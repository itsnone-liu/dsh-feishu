/**
 * Feishu interactive-card builders — pure functions, no transport knowledge.
 *
 * Card shape is the classic v1 "interactive" card (msg_type: "interactive"),
 * updatable via the im message-update API, so one card per turn streams in
 * place. All model-derived strings go through mdEscape/clamp at the call site
 * (see renderer) — builders trust their inputs.
 */
import { mdEscape as esc, clamp } from './util.js';

const note = (text) => ({ tag: 'note', elements: [{ tag: 'plain_text', content: text }] });
const hr = () => ({ tag: 'hr' });

function mdDiv(content) {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function headerCard(template, title, elements) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements,
  };
}

/** Phase → (template, title) for the turn card header. */
function turnHeader(state) {
  const t = state.turnNo ? ` · turn ${state.turnNo}` : '';
  switch (state.phase) {
    case 'working':
      return ['blue', `● 工作中${t} — ${state.title}`];
    case 'done':
      return ['green', `✓ 完成${t} — ${state.title}`];
    case 'error':
      return ['red', `✗ 出错${t} — ${state.title}`];
    case 'stopped':
      return ['grey', `⏹ 已停止${t} — ${state.title}`];
    default:
      return ['blue', `● 工作中${t} — ${state.title}`];
  }
}

/**
 * Build the streaming turn card from renderer state.
 * state.blocks: [{kind:'reasoning'|'text'|'tool', text, tool?:{name, args, status, preview}}]
 */
export function buildTurnCard(state, textLimit) {
  const [template, title] = turnHeader(state);
  const elements = [];
  for (const b of state.blocks) {
    if (b.kind === 'reasoning') {
      const body = clamp(b.text ?? '', 700);
      if (!body.trim()) continue;
      elements.push(mdDiv(`💭 **思考**（仅示末段）\n> ${body.replace(/\n/g, '\n> ')}`));
    } else if (b.kind === 'tool') {
      const t = b.tool ?? {};
      const icon = t.status === 'ok' ? '✅' : t.status === 'error' ? '❌' : '⏳';
      const line = `🔧 \`${esc(t.name ?? 'tool')}\` ${icon} \`${esc(t.args ?? '')}\``;
      const preview = t.preview ? `\n　　↳ ${esc(t.preview)}` : '';
      elements.push(mdDiv(line + preview));
    } else {
      const body = clamp(b.text ?? '', textLimit);
      if (!body.trim()) continue;
      elements.push(mdDiv(esc(body)));
    }
  }
  if (state.steerNote) {
    elements.push(mdDiv(`↩️ **转向输入**：${esc(state.steerNote)}`));
  }
  if (elements.length === 0) {
    elements.push(mdDiv('…'));
  }
  elements.push(hr());
  elements.push(note(state.footer ?? ''));
  return headerCard(template, title, elements);
}

/** Pending ask_user_question card: questions as button groups + skip. */
export function buildAskCard({ questions, askId, timeoutMs }) {
  const elements = [];
  elements.push(mdDiv('**❓ Harness 提问**（回复文字=自由输入，点按钮=选择）'));
  for (const q of questions) {
    if (q.header) elements.push(mdDiv(`**${esc(q.header)}**`));
    elements.push(mdDiv(esc(q.question)));
    if (q.detail) elements.push(mdDiv(`> ${clamp(q.detail, 800).replace(/\n/g, '\n> ')}`));
    const actions = (q.options ?? []).map((o, i) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: clamp(o.label, 20) },
      type: i === 0 ? 'primary' : 'default',
      value: { bridge: 'ask', askId, questionId: q.id, kind: 'option', label: o.label },
    }));
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '跳过' },
      type: 'default',
      value: { bridge: 'ask', askId, questionId: q.id, kind: 'skip', label: '' },
    });
    if (actions.length) elements.push({ tag: 'action', actions });
  }
  const foot = timeoutMs > 0 ? `等待回答（${Math.round(timeoutMs / 60000)} 分钟超时）` : '等待回答';
  elements.push(note(foot));
  return headerCard('turquoise', '❓ 等待你的输入', elements);
}

/** Answered ask card — replaces buttons with the chosen answer. */
export function buildAskResolvedCard({ questions, answers, aborted }) {
  const elements = [];
  if (aborted) {
    elements.push(mdDiv('⚠️ 该问题已随回合取消而失效。'));
  } else {
    for (const q of questions) {
      const a = answers.find((x) => x.id === q.id);
      const chosen = a ? (a.custom ? `“${a.custom}”` : a.selected?.length ? a.selected.map((s) => `“${s}”`).join('、') : '（跳过）') : '（未答）';
      elements.push(mdDiv(`**Q:** ${esc(q.question)}\n**A:** ${chosen}`));
    }
  }
  return headerCard('grey', '❓ 已回答', elements);
}

/** Approval card: two buttons, fail-closed semantics documented in the footer. */
export function buildApprovalCard({ approvalId, toolName, reason, argsPreview }) {
  const elements = [
    mdDiv(`🔐 **工具审批请求**\n工具：\`${esc(toolName)}\`\n理由：${esc(reason ?? '（未提供）')}`),
  ];
  if (argsPreview) elements.push(mdDiv(`> ${clamp(argsPreview, 400)}`));
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '允许一次' },
        type: 'primary',
        value: { bridge: 'approval', approvalId, decision: 'allowed-once' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '拒绝' },
        type: 'danger',
        value: { bridge: 'approval', approvalId, decision: 'rejected' },
      },
    ],
  });
  elements.push(note('仅本次生效 · 不回应则回合结束后按失败处理'));
  return headerCard('orange', '🔐 需要审批', elements);
}

export function buildApprovalResolvedCard({ toolName, outcome }) {
  const map = {
    'allowed-once': '✅ 已允许（本次）',
    rejected: '🚫 已拒绝',
    cancelled: '⏹ 已取消',
    unavailable: '⚠️ 无人应答（失败关闭）',
  };
  return headerCard('grey', '🔐 审批结束', [mdDiv(`\`${esc(toolName)}\` → ${map[outcome] ?? outcome}`)]);
}

/** Plain informational card (help text, session lists, status). */
export function buildInfoCard(title, markdown, { template = 'blue' } = {}) {
  return headerCard(template, title, [mdDiv(markdown)]);
}

export function buildErrorCard(title, message) {
  return headerCard('red', `✗ ${title}`, [mdDiv(`\`\`\`\n${clamp(message, 1200)}\n\`\`\``)]);
}
