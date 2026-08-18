/**
 * ChatRouter — Feishu chats → durable DSH sessions.
 *
 * Per chat: whitelist gate → message-id dedup → pending-ask intercept →
 * command dispatch → per-chat serial queue → driver submit. The queue only
 * serializes OUR bookkeeping; a submit itself returns immediately (the agent
 * loop runs on its own fibers), so steer-while-running works.
 */
import { buildErrorCard, buildInfoCard } from './cards.js';
import { isWorkspaceAllowed } from './config.js';
import { log } from './log.js';

export class ChatRouter {
  constructor({ config, store, driver, renderer, transport, interactions, commands }) {
    this.config = config;
    this.store = store;
    this.driver = driver;
    this.renderer = renderer;
    this.transport = transport;
    this.interactions = interactions;
    this.commands = commands;
    /** chatId → promise tail (serial handling) */
    this.queues = new Map();
    /** LRU-ish dedup of inbound message ids */
    this.seen = new Set();
    this.seenOrder = [];
    this.warnedChats = new Set();
  }

  /** Transport entry point. Never throws. */
  onMessage(msg) {
    this.#enqueue(msg.chatId, async () => {
      try {
        await this.#handle(msg);
      } catch (e) {
        log.error(`chat ${msg.chatId}: ${e.stack ?? e}`);
        await this.transport
          .sendCard(msg.chatId, buildErrorCard('桥内部错误', e.message))
          .catch(() => {});
      }
    });
  }

  onCardAction(action) {
    const ok = this.interactions.onCardAction(action);
    if (!ok) log.debug(`unmatched card action: ${JSON.stringify(action.value).slice(0, 80)}`);
  }

  #enqueue(chatId, task) {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(chatId, next);
    next.finally(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
  }

  async #handle(msg) {
    const { chatId, openId, messageId, text } = msg;

    // dedup (Feishu may redeliver)
    if (messageId) {
      if (this.seen.has(messageId)) return;
      this.seen.add(messageId);
      this.seenOrder.push(messageId);
      if (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift());
    }

    // HARD security gate — fail closed, silently
    if (!this.config.allowedOpenIds.includes(openId)) {
      if (!this.warnedChats.has(chatId)) {
        this.warnedChats.add(chatId);
        log.warn(`dropping message from unknown open_id ${openId || '(none)'} in chat ${chatId} (whitelist: ${this.config.allowedOpenIds.length})`);
      }
      return;
    }

    // pending ask in this chat? plain text answers it
    if (this.interactions.handleAskText(chatId, text)) {
      log.info(`chat ${chatId}: text answered pending ask`);
      return;
    }

    // commands
    if (await this.commands.handle(chatId, text)) return;

    // normal traffic → agent
    const binding = this.store.get(chatId) ?? { sessionId: null, cwd: null };
    if (!binding.cwd) {
      binding.cwd = this.config.defaultCwd;
      if (!isWorkspaceAllowed(this.config, binding.cwd)) {
        await this.transport.sendCard(chatId, buildErrorCard('defaultCwd 不在白名单', `defaultCwd=${this.config.defaultCwd}`));
        return;
      }
    }
    const agent = await this.driver.ensure(binding);
    this.store.update(chatId, { sessionId: binding.sessionId, cwd: binding.cwd });
    if (this.renderer.chatOf(agent.id) !== chatId) this.renderer.attach(agent.id, chatId);
    const mode = this.driver.submit(agent, text);
    if (mode === 'steer') {
      this.renderer.setSteerNote(agent.id, text);
      log.info(`chat ${chatId}: steered running agent`);
    }
  }
}
