/**
 * audit/commands.js — /audit 子命令解析与文案（A2）。
 *
 * 纯函数层：解析 → 调 AuditController → 生成回复文本。
 * 不 import transport（发卡片由外层 Commands 负责），便于离线测试。
 *
 * 语法：
 *   /audit T2         创建审计运行（stopAfter=T2）
 *   /audit status     查看状态
 *   /audit pause      暂停（活跃态 → PAUSED）
 *   /audit resume     恢复（PAUSED/PAUSED_NEEDS_USER）
 *   /audit stop       终止（任意活跃态 → STOPPED）
 *   /audit until X    修改停止点
 */
import { DEFAULT_STAGES } from './controller.js';

const USAGE = [
  '**/audit 用法**',
  '',
  '- `/audit <阶段>` — 创建审计运行（如 `/audit T2`，阶段表：' + DEFAULT_STAGES.join(' · ') + '）',
  '- `/audit status` — 查看状态 · `/audit pause` 暂停 · `/audit resume` 恢复',
  '- `/audit stop` — 终止 · `/audit until <阶段>` — 修改停止点',
  '',
  '当前为 A2 阶段：外部执行端（DSH lifecycle / git push / 审核员）尚未接线，',
  '运行会停在 EXECUTING 等待 —— 这是预期行为，不代表卡死。',
].join('\n');

/** 状态中文速览（A1 十四态）。 */
const STATE_HINTS = {
  EXECUTING: '执行中（等待 executor 标记 —— A3 接线前停在这是预期的）',
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
export function handleAuditCommand(controller, arg) {
  const [first, ...rest] = arg.trim().split(/\s+/);
  const word = (first ?? '').toLowerCase();

  // —— 创建：/audit T2 ——
  if (word && /^[A-Za-z]\d*$/.test(first) && !['status', 'pause', 'resume', 'stop', 'until'].includes(word)) {
    const r = controller.createRun({ stopAfter: first });
    if (!r.ok) {
      return { title: '❌ 创建失败', body: `${r.message}`, template: 'red' };
    }
    return {
      title: '🧾 审计运行已创建',
      body: [
        `run：\`${r.runId}\``,
        `状态：**EXECUTING**（${stateHint('EXECUTING')}）`,
        `停止点：**${first}**（阶段表 ${controller.stages.join(' · ')}）`,
        '',
        'REVISE 上限 8 次/阶段；身份四元组 RUN_ID/STAGE/ITERATION/HOST_ID 已锁定。',
        'A3 接线前没有执行端驱动，`/audit status` 可随时查看。',
      ].join('\n'),
    };
  }

  switch (word) {
    case '': return { title: '/audit 用法', body: USAGE };
    case 'status': {
      const r = controller.status();
      if (!r.ok) return { title: '没有审计运行', body: r.message, template: 'grey' };
      const s = r.result;
      const lines = [
        `run：\`${r.runId}\``,
        `状态：**${s.state}** — ${stateHint(s.state)}`,
        `阶段：**${s.currentStage}**（第 ${s.iteration} 轮 · REVISE ${s.revisionCount}/${s.maxReviewIterations}）`,
        `停止点：**${s.stopAfter}**`,
      ];
      if (s.cause) lines.push(`暂停原因：\`${s.cause}\``);
      if (s.auditedCommits.length > 0) {
        lines.push(`已审 commits：${s.auditedCommits.map((c) => `\`${c}\``).join(', ')}`);
      }
      if (s.recentEvents.length > 0) {
        lines.push('', `最近事件：${s.recentEvents.map((e) => `\`${e}\``).join(' → ')}`);
      }
      lines.push('', `仓库（A2 stub）：\`${s.repo}@${s.branch}\``);
      return { title: '📊 审计状态', body: lines.join('\n') };
    }
    case 'pause': {
      const r = controller.pause();
      if (!r.ok) return { title: '❌ 暂停失败', body: r.message, template: 'red' };
      return { title: '⏸ 已暂停', body: `run \`${r.runId}\` 状态 **${r.result.state}**。\n/audit resume 恢复。` };
    }
    case 'resume': {
      const r = controller.resume();
      if (!r.ok) return { title: '❌ 恢复失败', body: r.message, template: 'red' };
      return { title: '▶️ 已恢复', body: `run \`${r.runId}\` 状态 **${r.result.state}**。` };
    }
    case 'stop': {
      const r = controller.stop();
      if (!r.ok) return { title: '❌ 终止失败', body: r.message, template: 'red' };
      return { title: '🛑 已终止', body: `run \`${r.runId}\` 已进入终态 **${r.result.state}**。可重新 /audit <阶段> 创建新运行。` };
    }
    case 'until': {
      const target = rest[0];
      if (!target) return { title: '用法', body: '`/audit until <阶段>`（如 `/audit until T3`）', template: 'grey' };
      const r = controller.until(target);
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
