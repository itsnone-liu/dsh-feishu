/**
 * audit/repair-protocol.js — P-E「停-报-修-续」修复 agent 协议。
 *
 * 设计决定（2026-09-29 用户拍板）：桥内不再做 LLM 枚举恢复/自动代码修复。
 * 有异常就停：持久化完整事故报告 → 飞书汇报 → 派一个独立修复 agent session
 * 去调查修复（它是完整 DSH agent，能读代码/日志、改文件、跑测试、commit）
 * → 修复完成后桥自动续跑原审计 run。多修几次，常见问题自然收敛。
 *
 * 本模块只做两件事（纯函数、无 IO）：
 *  - buildRepairPrompt：给修复 agent 的任务书（含事故报告 JSON 与严格报告块模板）；
 *  - parseRepairReport：解析修复 agent 的 [DSH-REPAIR] 报告块（fail-closed，
 *    身份字段 RUN_ID/INCIDENT_ID 不匹配一律返回 null）。
 */

const REPAIR_TAG = '[DSH-REPAIR]';

/**
 * @param {object} p
 * @param {object} p.incident       完整事故报告（lifecycle #incidentContext 产物）
 * @param {string} p.runId
 * @param {string} p.incidentId
 * @param {number} p.attempt        第几次修复尝试（1 起）
 * @param {string} p.workspace      审计工作区（run 的任务仓库）
 * @param {string} p.bridgeRoot     桥本体仓库根（修复 agent 的 cwd）
 * @param {string|null} p.logFile   桥日志路径（可 null）
 * @param {string|null} p.previousBlockedSummary 上次 BLOCKED 摘要（重试时附上）
 * @returns {string} prompt 文本
 */
export function buildRepairPrompt({ incident, runId, incidentId, attempt, workspace, bridgeRoot, logFile = null, previousBlockedSummary = null } = {}) {
  const prev = previousBlockedSummary
    ? `\n（注意：这是第 ${attempt} 次尝试。上一次修复报告无法解决，其摘要如下，请换角度深挖根因，不要重复同一方案：\n${String(previousBlockedSummary).slice(0, 1500)}\n）\n`
    : '';
  return [
    `你是无人值守审计系统的修复代理（第 ${attempt} 次尝试）。`,
    '',
    '背景：飞书桥（dsh-feishu）在纯无人值守模式驱动一个审计 run 时检测到异常，已停止该 run 的一切自动重试并保留现场。你的任务：调查根因 → 修复 → 自测 → 本地 commit。修复完成后桥会自动恢复该 run。',
    '',
    '你可以调查和修改两个位置：',
    `- 审计工作区（run 的任务仓库）：${workspace}`,
    `- 桥本体（编排代码，即你当前所在仓库）：${bridgeRoot}`,
    logFile ? `- 桥日志：${logFile}（含崩溃/审计轨迹）` : '',
    '',
    '要求：',
    '1. 先读下面的事故报告与相关日志/代码定位根因；报告中含 run 状态、最近事件、git 快照与触发异常。不要盲目改动。',
    '2. 修复以最小 diff 为原则。禁止：push --force、reset --hard、改写审计证据文件（events.jsonl / verdicts.jsonl / recovery.jsonl / incident.json）、伪造测试结果。',
    '3. 修复后必须实测验证：桥代码用 `node --check` 相关文件并跑 `test/audit/` 相关测试；工作区代码按其自身测试约定。验证通过后在对应仓库创建本地 commit（不要 push）。',
    '4. 如果调查结论是「无需改代码」（如外部服务暂不可用、卡死 turn 需要取消重启），也允许：在 SUMMARY 里写明操作建议并输出 STATUS: DONE，RESTART 按是否需要重载桥代码填写。',
    prev,
    '事故报告（JSON）：',
    '```json',
    JSON.stringify(incident, null, 2),
    '```',
    '',
    '完成后只输出以下严格报告块（除该块外不要输出任何说明文字）：',
    '',
    REPAIR_TAG,
    `RUN_ID: ${runId}`,
    `INCIDENT_ID: ${incidentId}`,
    'STATUS: DONE | BLOCKED',
    'RESTART: yes | no',
    'FILES:',
    '- <每个改动文件一行，以 "- " 开头；无改动则只留 "-" 一行>',
    'SUMMARY:',
    '<根因、修复内容、验证结果；BLOCKED 时写明卡点与建议>',
  ].filter((x) => x !== '').join('\n');
}

/** 提醒修复 agent 输出报告块（turn 结束但没有报告块时补发）。 */
export function buildRepairNudge({ runId, incidentId } = {}) {
  return [
    '你的上一条回复没有包含要求的 [DSH-REPAIR] 报告块，系统无法判定修复结果。',
    '请现在只输出报告块（不要其他说明）：',
    '',
    REPAIR_TAG,
    `RUN_ID: ${runId}`,
    `INCIDENT_ID: ${incidentId}`,
    'STATUS: DONE | BLOCKED',
    'RESTART: yes | no',
    'FILES:',
    '- <改动文件或 "-">',
    'SUMMARY:',
    '<根因与修复摘要 / BLOCKED 原因与建议>',
  ].join('\n');
}

/**
 * 解析 [DSH-REPAIR] 报告块。任何结构缺失 / STATUS 非法 → null（fail-closed，
 * 不猜）。身份校验（runId/incidentId 与期望一致）由调用方做或在此做：
 * 传入 expected 时直接在此校验。
 * @returns {{runId:string, incidentId:string, status:'DONE'|'BLOCKED', restart:boolean, files:string[], summary:string}|null}
 */
export function parseRepairReport(text, { runId = null, incidentId = null } = {}) {
  const raw = String(text ?? '');
  const idx = raw.indexOf(REPAIR_TAG);
  if (idx < 0) return null;
  const body = raw.slice(idx + REPAIR_TAG.length);
  const lines = body.split(/\r?\n/);
  const out = { files: [] };
  let section = 'fields'; // fields | files | summary
  const summaryLines = [];
  for (const line of lines) {
    if (section === 'summary') { summaryLines.push(line); continue; }
    if (section === 'files') {
      const m = /^-\s?(.*)$/.exec(line.trim());
      if (m) { if (m[1].trim() && m[1].trim() !== '-') out.files.push(m[1].trim()); continue; }
      if (/^SUMMARY:\s*/i.test(line)) { section = 'summary'; continue; }
      // FILES 段里出现其他 KEY: 行 → 结构损坏
      if (/^[A-Z_]+:\s*/.test(line)) return null;
      continue;
    }
    const m = /^([A-Z_]+):\s*(.*)$/.exec(line);
    if (!m) continue; // 字段区允许空行
    const [, key, value] = m;
    if (key === 'FILES') { section = 'files'; continue; }
    if (key === 'SUMMARY') { section = 'summary'; continue; }
    if (key === 'RUN_ID') out.runId = value.trim();
    else if (key === 'INCIDENT_ID') out.incidentId = value.trim();
    else if (key === 'STATUS') out.status = value.trim().toUpperCase();
    else if (key === 'RESTART') out.restart = /^y(es)?$/i.test(value.trim());
  }
  if (!out.runId || !out.incidentId) return null;
  if (out.status !== 'DONE' && out.status !== 'BLOCKED') return null;
  if (runId && out.runId !== runId) return null;
  if (incidentId && out.incidentId !== incidentId) return null;
  out.summary = summaryLines.join('\n').trim();
  return out;
}
