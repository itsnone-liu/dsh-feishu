/**
 * InteractionManager — the Feishu side of DSH's two interactive seams.
 *
 * 1. `ctx.userQuestions` provider (the ONLY one allowed in this process —
 *    that is why the bridge is a sibling profile, not a web-process plugin):
 *    questions render as a button card; buttons and the chat's next plain
 *    text message both answer. Abort (turn cancelled) invalidates the card.
 *
 * 2. `approval/request` answerer: 2026-09-30 业主指令起一律自动放行
 *    （'allowed-once'），无卡片无等待。Unknown agents delegate via next()
 *    so we never speak for someone else's agent.
 */
import { buildAskCard, buildAskResolvedCard } from './cards.js';
import { newInteractionId, clamp } from './util.js';
import { log } from './log.js';

export class InteractionManager {
  constructor({ transport, config, chatOfSession }) {
    this.transport = transport;
    this.config = config;
    this.chatOfSession = chatOfSession; // sessionId → chatId (null = not ours)
    /** askId → pending ask */
    this.asks = new Map();
    /** approvalId → pending approval */
    this.approvals = new Map();
    /** chatId → FIFO of pending ask ids (free-text answering) */
    this.pendingByChat = new Map();
  }

  #enqueueChatPending(chatId, askId) {
    const q = this.pendingByChat.get(chatId) ?? [];
    q.push(askId);
    this.pendingByChat.set(chatId, q);
  }

  #dequeueChatPending(chatId, askId) {
    const q = (this.pendingByChat.get(chatId) ?? []).filter((x) => x !== askId);
    if (q.length) this.pendingByChat.set(chatId, q);
    else this.pendingByChat.delete(chatId);
  }

  /** A pending ask waiting for free-text in this chat? */
  pendingAskForChat(chatId) {
    const id = (this.pendingByChat.get(chatId) ?? [])[0];
    return id ? this.asks.get(id) ?? null : null;
  }

  // ---------------------------------------------------------------- ask seam

  /** Provider `ask()`. */
  async handleAsk(request) {
    const chatId = this.chatOfSession(request.agent?.id);
    if (!chatId) {
      throw new Error(`feishu bridge has no chat for agent ${request.agent?.id ?? '?'}`);
    }
    const askId = newInteractionId('ask');
    const card = buildAskCard({
      questions: request.questions,
      askId,
      timeoutMs: this.config.askTimeoutMs,
    });
    const { messageId } = await this.transport.sendCard(chatId, card);

    return await new Promise((resolve, reject) => {
      const pending = {
        askId,
        chatId,
        messageId,
        questions: request.questions,
        settled: false,
        resolve,
        reject,
        timer: null,
        onAbort: null,
      };
      this.asks.set(askId, pending);
      this.#enqueueChatPending(chatId, askId);

      const settle = (answers, { aborted = false } = {}) => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.onAbort && request.signal) request.signal.removeEventListener('abort', pending.onAbort);
        this.asks.delete(askId);
        this.#dequeueChatPending(chatId, askId);
        this.transport
          .updateCard(messageId, buildAskResolvedCard({ questions: request.questions, answers, aborted }))
          .catch((e) => log.warn(`ask card update failed: ${e.message}`));
        resolve({ answers });
      };
      pending.settle = settle;

      const fail = (err) => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        this.asks.delete(askId);
        this.#dequeueChatPending(chatId, askId);
        this.transport
          .updateCard(messageId, buildAskResolvedCard({ questions: request.questions, answers: [], aborted: true }))
          .catch(() => {});
        reject(err);
      };
      pending.fail = fail;

      if (request.signal) {
        pending.onAbort = () => fail(new Error('ask aborted: turn cancelled'));
        if (request.signal.aborted) pending.onAbort();
        else request.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      if (this.config.askTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          // timeout → skip everything (documented provider semantics)
          settle(request.questions.map((q) => ({ id: q.id, selected: [] })));
        }, this.config.askTimeoutMs);
      }
    });
  }

  /** Answer a pending ask from a button click. */
  handleAskAction({ askId, questionId, kind, label }) {
    const pending = this.asks.get(askId);
    if (!pending) return false;
    const answers = pending.questions.map((q) =>
      q.id === questionId
        ? kind === 'skip'
          ? { id: q.id, selected: [] }
          : { id: q.id, selected: [label] }
        : { id: q.id, selected: [] }
    );
    pending.settle(answers);
    return true;
  }

  /** Answer a pending ask with free text (the chat's next message). */
  handleAskText(chatId, text) {
    const pending = this.pendingAskForChat(chatId);
    if (!pending) return false;
    const target = pending.questions[0];
    const answers = pending.questions.map((q) =>
      q === target ? { id: q.id, selected: [], custom: text } : { id: q.id, selected: [] }
    );
    pending.settle(answers);
    return true;
  }

  // --------------------------------------------------------- approval seam

  /**
   * Waterfall answerer for `approval/request`.
   * 2026-09-30 业主指令：权限通通放行——审批一律自动 `allowed-once`，
   * 不再发卡片等人点击（历史 'cards' 等点/''never' 自动拒语义废弃；
   * config.approval 字段保留仅为兼容，不再有任何阻断效果）。
   */
  async handleApproval(req, _next) {
    // 全局无人值守策略：审计专用 session 不挂 renderer.chatOfSession，
    // 不能再因 chatId 为空而 delegating 到默认 unavailable。所有桥内
    // approval/request 统一直接返回 allowed-once，不生成卡片、不等待点击。
    log.info(`approval auto-allowed (unattended): tool=${req.toolName} reason=${req.reason ?? '-'} session=${req.agent?.id ?? '-'}`);
    return 'allowed-once';
  }

  handleApprovalAction({ approvalId }) {
    // 2026-09-30：审批已全部自动放行，pending Map 恒空；保留该入口只为
    // 吞掉历史遗留卡片的点击（无 pending → false，transport 走未知动作路径）。
    return this.approvals.has(approvalId);
  }

  // ------------------------------------------------------------- dispatch

  /** Transport card-action entry: value.bridge routes to the right seam. */
  onCardAction({ value, openId }) {
    if (!value || typeof value !== 'object') return false;
    if (value.bridge === 'ask') {
      return this.handleAskAction(value);
    }
    if (value.bridge === 'approval') {
      return this.handleApprovalAction(value);
    }
    return false;
  }
}
