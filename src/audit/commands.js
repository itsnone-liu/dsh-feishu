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
// 2026-09-30 业主指令（纯无人值守）：预授权命令族与话术登记已整体删除。

const USAGE = [
  '**/audit 用法**',
  '',
  '- `/audit` — 一次性运行全部阶段（停止点：' + DEFAULT_STAGES.at(-1) + '）',
  '- `/audit <阶段>` — 运行至指定阶段（如 `/audit T2`，阶段表：' + DEFAULT_STAGES.join(' · ') + '）',
  '- `/audit next [阶段]` — 延续最近已完成的任务链，从下一阶段开始（不重审已完成阶段）',
  '- `/audit rebind` — 将当前运行迁移到专用审计 session（普通对话保持观察/控制）',
  '- `/audit status` — 查看状态 · `/audit pause` 暂停 · `/audit resume` 恢复',
  '- `/audit cleanup completed` — 将已完成运行移入可回滚 archive（不触碰活跃/事故运行）',
  '- `/audit stop` — 终止 · `/audit until <阶段>` — 修改停止点',
  '',
  'A3 已接入真实 DSH session 与 Git remote gate。阶段 APPROVE 后自动推进；REVISE 上限 8 次/阶段（`/audit resume <N>` 可提高）。',
  '运行会在等待 Executor marker 或审核裁决时停留 —— 这是预期行为，不代表卡死。',
  '纯无人值守（2026-09-30 起无任何人工授权门）；异常事故自动停机汇报，`/audit resume` 续跑。',
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
  const management = new Set(['status', 'pause', 'resume', 'stop', 'until', 'next', 'retry', 'rebind', 'cleanup']);

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
    case 'cleanup': {
      if (rest.length > 0 && rest[0] !== 'completed') return { title: '用法', body: '`/audit cleanup completed`', template: 'grey' };
      const r = controller.archiveCompleted({ chatId });
      return { title: '🧹 已清理已完成审计', body: r.archived.length ? r.archived.map((x) => `\`${x.runId}\` → archive`).join('\n') : '当前没有可清理的已完成运行。' };
    }
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
      if (s.cause) lines.push(`暂停原因：\`${s.cause}\``);
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


