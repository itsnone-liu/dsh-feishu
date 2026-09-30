/**
 * audit/commands.js — /audit 子命令解析与文案（A2/A3）。
 *
 * 纯函数层：解析 → 调 AuditController → 生成回复文本。
 * 不 import transport（发卡片由外层 Commands 负责），便于离线测试。
 *
 * 语法：
 *   /audit             创建完整审计运行（stopAfter=阶段表最后阶段）
 *   /audit T2          创建审计运行（stopAfter=T2）
 *   /audit status     查看状态
 *   /audit pause      暂停（活跃态 → PAUSED）
 *   /audit resume     恢复（PAUSED/PAUSED_NEEDS_USER）
 *   /audit stop       终止（任意活跃态 → STOPPED）
 *   /audit until X    修改停止点
 */
import { DEFAULT_STAGES } from './controller.js';
import { parsePreauthText, PREAUTH_TEMPLATE_EXACT, PREAUTH_TEMPLATE_CONSTRAINT } from './preauth-protocol.js';

const USAGE = [
  '**/audit 用法**',
  '',
  '- `/audit` — 一次性运行全部阶段（停止点：' + DEFAULT_STAGES.at(-1) + '）',
  '- `/audit <阶段>` — 运行至指定阶段（如 `/audit T2`，阶段表：' + DEFAULT_STAGES.join(' · ') + '）',
  '- `/audit next [阶段]` — 延续最近已完成的任务链，从下一阶段开始（不重审已完成阶段）',
  '- `/audit rebind` — 将当前运行迁移到专用审计 session（普通对话保持观察/控制）',
  '- `/audit status` — 查看状态 · `/audit pause` 暂停 · `/audit resume` 恢复',
  '- `/audit stop` — 终止 · `/audit until <阶段>` — 修改停止点',
  '- `/audit preauth add <阶段>` — 生成预授权话术模板（EXACT 需门位已展示 receipt hash）',
  '- `/audit preauth list` — 预授权记录状态 · `/audit preauth revoke <id>` — 立即撤销',
  '',
  'A3 已接入真实 DSH session 与 Git remote gate。阶段 APPROVE 后自动推进；REVISE 上限 8 次/阶段（`/audit resume <N>` 可提高）。',
  '运行会在等待 Executor marker 或审核裁决时停留 —— 这是预期行为，不代表卡死。',
  '人闸（SEAL/REVEAL）支持预授权放行：发送逐字登记话术或等待布防时自动消费匹配记录。',
].join('\n');

/** 状态中文速览（A1 十四态）。 */
const STATE_HINTS = {
  EXECUTING: '执行中（等待 DSH Executor marker；A3 会继续驱动）',
  AUDITING: '审计中（等待审核员裁决）',
  PAUSED: '已暂停（/audit resume 恢复）',
  PAUSED_NEEDS_USER: '需要人工介入（见原因行）',
  WAIT_GIT_PUSH: '等待 git push（A3 接线前需人工处理）',
  WAIT_DSH_QUOTA: '执行侧额度耗尽，等待窗口恢复',
  WAIT_WEB_QUOTA: '审核侧（网页额度）耗尽，等待窗口恢复',
  STOPPED: '已手动终止（终态）',
  STOPPED_TARGET_REACHED: '已到达停止点（终态，审计通过）',
  ERROR: '协议/远端失败已达上限（终态，需人工）',
};

const stateHint = (s) => STATE_HINTS[s] ?? s;

/**
 * @param {import('./controller.js').AuditController} controller
 * @param {string} arg '/audit' 之后的参数原文
 * @returns {{ title: string, body: string, template?: string }}
 */
export async function handleAuditCommand(controller, arg, chatId, ctx = {}) {
  const raw = arg.trim();
  const [first, ...rest] = raw.split(/\s+/);
  const word = (first ?? '').toLowerCase();
  const management = new Set(['status', 'pause', 'resume', 'stop', 'until', 'next', 'rebind', 'preauth']);

  if (word === 'preauth') {
    return handlePreauthSubcommand(controller, rest, chatId, ctx);
  }

  // 无参数默认跑完整阶段表；显式阶段仍允许设置停止点。
  if (!raw) {
    const stopAfter = controller.stages.at(-1);
    const r = await controller.createRun({ stopAfter, chatId });
    if (!r.ok) return { title: '❌ 创建失败', body: `${r.message}`, template: 'red' };
    return {
      title: '🧾 完整审计运行已创建',
      body: [`run：\`${r.runId}\``, '状态：**EXECUTING**（执行中）', `停止点：**${stopAfter}**（将连续运行全部阶段）`].join('\n'),
    };
  }
  if (word === 'next') {
    const stopAfter = rest.length === 1 ? rest[0] : null;
    if (rest.length > 1) {
      return { title: '❌ 延续失败', body: '用法：`/audit next` 或 `/audit next <停止阶段>`。', template: 'red' };
    }
    const r = await controller.next(chatId, { stopAfter });
    if (!r.ok) return { title: '❌ 延续失败', body: `${r.message}`, template: 'red' };
    return {
      title: '⏭ 审计链已延续',
      body: [
        `run：\`${r.runId}\``,
        `父运行：\`${r.result.parentRunId}\`（已完成阶段继承，不重审）`,
        `当前阶段：**${r.result.currentStage}**（iteration 1 起）`,
        `停止点：**${r.result.stopAfter}**`,
      ].join('\n'),
    };
  }
  if (!management.has(word)) {
    const r = await controller.createRun({ stopAfter: raw, chatId });
    if (!r.ok) {
      return { title: '❌ 创建失败', body: `${r.message}`, template: 'red' };
    }
    return {
      title: '🧾 审计运行已创建',
      body: [
        `run：\`${r.runId}\``,
        `状态：**EXECUTING**（${stateHint('EXECUTING')}）`,
        `停止点：**${r.result.stopAfter}**（阶段表 ${controller.stages.join(' · ')}）`,
        '',
        'REVISE 上限 8 次/阶段；身份四元组 RUN_ID/STAGE/ITERATION/HOST_ID 已锁定。',
        'A3 接线前没有执行端驱动，`/audit status` 可随时查看。',
      ].join('\n'),
    };
  }

  switch (word) {
    case 'rebind': {
      const r = await controller.rebind(chatId);
      if (!r.ok) return { title: '❌ 审计 session 迁移失败', body: r.message, template: 'red' };
      return { title: '🔗 审计 session 已迁移', body: `run：\`${r.runId}\`\n状态：**${r.result.state}**\n审计 session：\`${r.result.auditSessionId}\`\n普通对话 session 保留为观察/控制入口。` };
    }
    case '': return { title: '/audit 用法', body: USAGE };
    case 'status': {
      const r = await controller.status(chatId);
      if (!r.ok) {
        if (r.code === 'AUDIT_RUN_OWNED_BY_OTHER_CHAT') {
          return { title: '本机已有审计运行', body: r.message, template: 'grey' };
        }
        return { title: '没有审计运行', body: r.message, template: 'grey' };
      }
      const s = r.result;
      const lines = [
        `run：\`${r.runId}\``,
        `状态：**${s.state}** — ${stateHint(s.state)}`,
        `阶段：**${s.currentStage}**（第 ${s.iteration} 轮 · REVISE ${s.revisionCount}/${s.maxReviewIterations > 0 ? s.maxReviewIterations : '无限'}）`,
        '运行策略：**纯无人值守**（额度/审核超时/瞬态仓库错误自动等待重试；其余异常自动停机并汇报，人工修复后 `/audit resume` 续跑）',
        `停止点：**${s.stopAfter}**`,
      ];
      if (s.waitingForHuman) lines.push(`等待人工：\`${s.waitingReason}\``);
      else if (s.cause) lines.push(`暂停原因：\`${s.cause}\``);
      else if (s.lastPauseCause) lines.push(`上次暂停原因：\`${s.lastPauseCause}\``);
      // P-E 简化版：未解决事故（已停机等人工）。
      const inc = controller.lifecycle?.openIncident?.(r.runId);
      if (inc) lines.push(`⚠️ 事故停机中：\`${inc.trigger}\`（${new Date(inc.raisedAt).toLocaleString('zh-CN', { hour12: false })} 起，等人工修复后 \`/audit resume\`）`);
      if (s.lastExecutorEventAt) lines.push(`最后 executor 事件：\`${s.lastExecutorEvent}\`（turn ${s.lastExecutorTurn ?? '-'}）`);
      if (s.observerSessionId) lines.push(`观察 session：\`${s.observerSessionId}\``);
      if (s.auditSessionId) lines.push(`审计 session：\`${s.auditSessionId}\``);
      if (s.auditedCommits.length > 0) {
        lines.push(`已审 commits：${s.auditedCommits.map((c) => `\`${c}\``).join(', ')}`);
      }
      if (s.recentEvents.length > 0) {
        lines.push('', `最近事件：${s.recentEvents.map((e) => `\`${e}\``).join(' → ')}`);
      }
      lines.push('', `仓库：\`${s.repo}@${s.branch}\``);
      return { title: '📊 审计状态', body: lines.join('\n') };
    }
    case 'pause': {
      const r = await controller.pause(chatId);
      if (!r.ok) return { title: '❌ 暂停失败', body: r.message, template: 'red' };
      return { title: '⏸ 已暂停', body: `run \`${r.runId}\` 状态 **${r.result.state}**。\n/audit resume 恢复。` };
    }
    case 'resume': {
      const bumpReviewIterations = null;
      if (rest.length > 0) {
        return { title: '❌ 恢复失败', body: '用法：`/audit resume`（无限轮次由系统自动继续；旧运行也不再因轮次停止）。', template: 'red' };
      }
      const r = await controller.resume(chatId, { bumpReviewIterations });
      if (!r.ok) return { title: '❌ 恢复失败', body: r.message, template: 'red' };
      return { title: '▶️ 已恢复', body: `run \`${r.runId}\` 状态 **${r.result.state}**${r.result.maxReviewIterations ? `，REVISE上限 ${r.result.maxReviewIterations}` : ''}。` };
    }
    case 'stop': {
      const r = await controller.stop(chatId);
      if (!r.ok) return { title: '❌ 终止失败', body: r.message, template: 'red' };
      return { title: '🛑 已终止', body: `run \`${r.runId}\` 已进入终态 **${r.result.state}**。可重新 /audit <阶段> 创建新运行。` };
    }
    case 'until': {
      const target = rest[0];
      if (!target) return { title: '用法', body: '`/audit until <阶段>`（如 `/audit until T3`）', template: 'grey' };
      const r = await controller.until(chatId, target);
      if (!r.ok) return { title: '❌ 修改失败', body: r.message, template: 'red' };
      const extra = r.result.changed ? `停止点已改为 **${r.result.stopAfter}**（v0.2 §6.2 竞态规则由内核执行）。` : `停止点已是 **${r.result.stopAfter}**，无变化。`;
      return { title: '🎯 停止点', body: `run \`${r.runId}\`：${extra}` };
    }
    default:
      return {
        title: '未识别的 /audit 子命令',
        body: [`无法理解 \`${first}\`。`, '', USAGE].join('\n'),
        template: 'grey',
      };
  }
}

// ---------------------------------------------------------------------------
// P-C：/audit preauth 命令族 + 逐字话术登记（I7 命令层）。
// ---------------------------------------------------------------------------

const isoNoMs = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** 该聊天当前活跃（非终态）的 audit run；无则 null。 */
function activeRunFor(lifecycle, chatId) {
  if (!lifecycle?.liveRuns) return null;
  for (const run of lifecycle.liveRuns.values()) {
    if (run.manifest.chatId === chatId && !['STOPPED', 'STOPPED_TARGET_REACHED', 'ERROR'].includes(run.s.state)) return run;
  }
  return null;
}

/**
 * /audit preauth add|list|revoke。
 * @param {import('./controller.js').AuditController} controller
 * @param {string[]} rest 子命令词
 */
function handlePreauthSubcommand(controller, rest, chatId, ctx) {
  const store = ctx?.preauthStore ?? null;
  const sub = (rest[0] ?? '').toLowerCase();
  if (!store) {
    return { title: '❌ 预授权未启用', body: '本装配未注入 PreauthStore（P-C）。', template: 'red' };
  }
  if (sub === 'list') {
    const recs = store.list();
    if (recs.length === 0) return { title: '📋 预授权记录', body: '暂无记录。用 `/audit preauth add <阶段>` 生成登记话术。' };
    const lines = recs.slice(-15).reverse().map((r) => {
      const status = r.consumedAt ? `已消费@${r.stage}` : (r.revokedAt ? '已撤销' : (r.expiresAt <= Date.now() ? '已过期' : '生效中'));
      const target = r.binding === 'EXACT' ? `\`${String(r.receiptHash).slice(0, 12)}…\`` : `ordinal≤${r.constraints?.maxOrdinal ?? '?'}`;
      return `- \`${r.preauthId}\` ${r.binding}·${r.gateKind}@${r.stage} ${target} — ${status}（至 ${isoNoMs(r.expiresAt)}）`;
    });
    return { title: '📋 预授权记录', body: [`最近 ${lines.length} 条（新→旧）：`, ...lines, '', '`/audit preauth revoke <id>` 立即撤销。'].join('\n') };
  }
  if (sub === 'revoke') {
    const id = rest[1];
    if (!id) return { title: '用法', body: '`/audit preauth revoke <preauthId>`（id 见 `/audit preauth list`）。', template: 'grey' };
    try {
      const rec = store.get(id);
      if (!rec) return { title: '❌ 撤销失败', body: `记录 \`${id}\` 不存在。`, template: 'red' };
      store.revoke(id);
      return { title: '🗑 预授权已撤销', body: `\`${id}\`（${rec.binding}·${rec.gateKind}@${rec.stage}）即刻失效；已消费的放行不回滚（事后审计见 GATE_PASSED_BY_PREAUTH 事件）。` };
    } catch (e) {
      return { title: '❌ 撤销失败', body: String(e.message ?? e), template: 'red' };
    }
  }
  if (sub === 'add') {
    const stage = (rest[1] ?? '').toUpperCase();
    if (!stage) {
      return { title: '用法', body: '`/audit preauth add <阶段>`（如 `/audit preauth add B4`）。阶段必须已在任务书 preauthorization 节声明门位。', template: 'grey' };
    }
    const run = activeRunFor(ctx?.lifecycle, chatId);
    if (!run) {
      return { title: '❌ 无活跃审计运行', body: '预授权绑定运行链。请先 `/audit` 创建运行，再生成登记话术。', template: 'red' };
    }
    const gateDecl = run.manifest.stageGates?.[stage];
    if (!gateDecl) {
      const declared = Object.keys(run.manifest.stageGates ?? {}).join(' · ') || '（无）';
      return { title: '❌ 该阶段未声明人闸', body: `阶段 **${stage}** 未在任务书 preauthorization 节声明。已声明：${declared}。`, template: 'red' };
    }
    const rootRunId = run.manifest.rootRunId ?? run.runId;
    const expiresAt = Date.now() + 24 * 3600_000;
    const waitingHere = run.s.waitingForHuman && String(run.s.currentStage).toUpperCase() === stage;
    const wantExact = (gateDecl.bindings ?? []).includes('EXACT');
    if (wantExact && waitingHere && run.s.waitingApprovalHash) {
      const phrase = PREAUTH_TEMPLATE_EXACT
        .replaceAll('<rootRunId>', rootRunId)
        .replaceAll('<expiresAt>', isoNoMs(expiresAt))
        .replaceAll('<64hex>', run.s.waitingApprovalHash);
      return {
        title: `🔑 ${stage} EXACT 预授权话术（已按当前门位预填）`,
        body: [
          '以下话术已用当前等待中的 receipt sha256 预填。**原样复制发送**即完成登记；若门位正在等待，同一条消息会直接走消费路径放行：',
          '', '```', phrase, '```', '',
          `- 运行链：\`${rootRunId}\``, `- 有效期至：${isoNoMs(expiresAt)}`, '- 仅放行该 hash 一次；`/audit preauth list` 查看，`revoke <id>` 随时撤销。',
        ].join('\n'),
      };
    }
    if (wantExact) {
      return {
        title: `🔑 ${stage} EXACT 预授权：需要门位 hash`,
        body: [
          'EXACT 绑定要求门位已布防（receipt sha256 已展示）。当前该门未在等待 —— 两个选择：',
          '1. 等待门位布防后（WAIT_HUMAN_APPROVAL 卡）再 `/audit preauth add ${stage}`，届时 hash 自动预填；',
          '2. 若任务书同时声明 CONSTRAINT，用 `/audit preauth add ${stage}` 改用约束绑定（无需预先知道 hash）。',
        ].join('\n'),
        template: 'grey',
      };
    }
    // CONSTRAINT 模板（占位符待填）
    const tmpl = PREAUTH_TEMPLATE_CONSTRAINT
      .replaceAll('NEXT_REVEAL_ONLY', gateDecl.kind === 'REVEAL' ? 'NEXT_REVEAL_ONLY' : 'SEAL_ANNOTATION_ONLY')
      .replaceAll('于阶段 C2', `于阶段 ${stage}`);
    return {
      title: `🔑 ${stage} CONSTRAINT 预授权模板（待填占位符）`,
      body: [
        '替换全部 `<占位符>` 后原样发送即登记（发送时该聊天若有活跃运行链，登记自动绑定它）：',
        '', '```', tmpl, '```', '',
        '- `<64hex>` = 上游门（如 B4 SEAL receipt）的 sha256，见其 WAIT 卡或 GATE_PASSED 事件；',
        '- `<commit>`/`<path>` = 承载门位产物的提交与文件（blob sha256 必须等于门位 hash）；',
        '- ordinal ≤ N 限制该阶段最多放行前 N 次布防。',
      ].join('\n'),
    };
  }
  return {
    title: '用法',
    body: ['`/audit preauth add <阶段>` · `/audit preauth list` · `/audit preauth revoke <id>`'].join('\n'),
    template: 'grey',
  };
}

/**
 * 逐字登记话术 → PreauthStore 记录（I7：登记窗口与有效期在命令层补齐）。
 * 调用时机：router 收到普通文本、且没有等待中人闸消费它时（§4 —— 无 liveRun
 * waiting 也应接受登记）。
 * @returns {{ok:true, record}|{ok:false, reason:string}}
 */
export function registerPreauthPhrase(ctx, text, chatId, messageRef = null) {
  const store = ctx?.preauthStore ?? null;
  if (!store) return { ok: false, reason: 'preauth not enabled' };
  let parsed;
  try { parsed = parsePreauthText(text); } catch (e) {
    return { ok: false, reason: `not a preauth phrase: ${e.message ?? e}` };
  }
  if (parsed.binding === 'EXACT') {
    const record = store.append({
      chatId, messageRef: messageRef ?? `chat:${chatId}:${Date.now()}`, humanText: text.trim(),
      binding: 'EXACT', gateKind: parsed.gateKind, stage: parsed.stage,
      receiptHash: parsed.receiptHash,
      expiresAt: parsed.expiresAt ?? Date.now() + 24 * 3600_000,
      runScope: parsed.runScope,
    });
    return { ok: true, record };
  }
  // CONSTRAINT：话术不含运行链 —— 绑定当前聊天活跃运行链（fail-closed）。
  const run = activeRunFor(ctx?.lifecycle, chatId);
  if (!run) {
    return { ok: false, reason: 'CONSTRAINT 预授权需要活跃审计运行链（先 /audit 创建运行）' };
  }
  const record = store.append({
    chatId, messageRef: messageRef ?? `chat:${chatId}:${Date.now()}`, humanText: text.trim(),
    binding: 'CONSTRAINT', gateKind: parsed.gateKind, stage: parsed.stage,
    constraints: parsed.constraints,
    expiresAt: Date.now() + 24 * 3600_000,
    runScope: { rootRunId: run.manifest.rootRunId ?? run.runId },
  });
  return { ok: true, record };
}
