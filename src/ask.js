/**
 * InteractionManager — the Feishu side of DSH's two interactive seams.
 *
 * 1. `ctx.userQuestions` provider (the ONLY one allowed in this process —
 *    that is why the bridge is a sibling profile, not a web-process plugin):
 *    questions render as a button card; buttons and the chat's next plain
 *    text message both answer. Abort (turn cancelled) invalidates the card.
 *
 * 2. `approval/request` answerer (waterfall): two-button card, or instant
 *    'rejected' when config.approval === 'never'. Unknown agents delegate
 *    via next() so we never speak for someone else's agent.
 */
import { buildAskCard, buildAskResolvedCard, buildApprovalCard, buildApprovalResolvedCard } from './cards.js';
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

  /** Waterfall answerer for `approval/request`. */
  async handleApproval(req, next) {
    const chatId = this.chatOfSession(req.agent?.id);
    if (!chatId) return next(); // not our agent — never speak for it
    if (this.config.approval === 'never') return 'rejected';

    const approvalId = newInteractionId('apr');
    const card = buildApprovalCard({
      approvalId,
      toolName: req.toolName,
      reason: req.reason,
      argsPreview: '',
    });
    const { messageId } = await this.transport.sendCard(chatId, card);

    return await new Promise((resolve) => {
      const pending = {
        approvalId,
        chatId,
        messageId,
        toolName: req.toolName,
        settled: false,
        resolve,
        onAbort: null,
      };
      this.approvals.set(approvalId, pending);

      const settle = (outcome) => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.onAbort && req.signal) req.signal.removeEventListener('abort', pending.onAbort);
        this.approvals.delete(approvalId);
        this.transport
          .updateCard(messageId, buildApprovalResolvedCard({ toolName: req.toolName, outcome }))
          .catch((e) => log.warn(`approval card update failed: ${e.message}`));
        resolve(outcome);
      };
      pending.settle = settle;

      if (req.signal) {
        pending.onAbort = () => settle('cancelled');
        if (req.signal.aborted) pending.onAbort();
        else req.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
    });
  }

  handleApprovalAction({ approvalId, decision }) {
    const pending = this.approvals.get(approvalId);
    if (!pending) return false;
    pending.settle(decision === 'allowed-once' ? 'allowed-once' : 'rejected');
    return true;
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
