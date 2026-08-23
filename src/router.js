/**
 * ChatRouter — Feishu chats → durable DSH sessions.
 *
 * Per chat: whitelist gate → message-id dedup → pending-ask intercept →
 * command dispatch → per-chat serial queue → driver submit. The queue only
 * serializes OUR bookkeeping; a submit itself returns immediately (the agent
 * loop runs on its own fibers), so steer-while-running works.
 */
import { buildErrorCard, buildInfoCard, buildImageRejectCard } from './cards.js';
import { isWorkspaceAllowed } from './config.js';
import { sniffImageMediaType } from './util.js';
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
    /** chatId → pending image burst { images[], text, timer } */
    this.batches = new Map();
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
    if (this.#handleModelAction(action)) return;
    const ok = this.interactions.onCardAction(action);
    if (!ok) log.debug(`unmatched card action: ${JSON.stringify(action.value).slice(0, 80)}`);
  }

  /**
   * One-tap model switch from the image-reject card (value.bridge === 'model').
   * Fail-closed on the whitelist; only acts on LIVE agents (never creates one).
   */
  #handleModelAction(action) {
    const v = action?.value;
    if (!v || v.bridge !== 'model' || !v.provider || !v.model || !v.chatId) return false;
    if (!this.config.allowedOpenIds.includes(action.openId)) {
      log.warn(`model action from unknown open_id ${action.openId || '(none)'} — dropped`);
      return true; // consumed, not forwarded
    }
    const { chatId, provider, model } = v;
    this.#enqueue(chatId, async () => {
      try {
        const binding = this.store.get(chatId);
        const entry = binding?.sessionId ? this.driver.live.get(binding.sessionId) : null;
        if (!entry) {
          await this.transport.sendCard(chatId, buildErrorCard('无法切换', '当前聊天没有进行中的会话。发任意消息开始会话后，或直接用 `/model` 切换。'));
          return;
        }
        this.driver.setModel(entry.agent, provider, model);
        log.info(`chat ${chatId}: model switched via card button → ${provider}/${model}`);
        await this.transport.sendCard(chatId, buildInfoCard(
          '模型已切换',
          `→ **${provider}/${model}**\n\n下一回合起生效。现在可以重发图片了（若仍有待合并图片，将自动按新模型提交）。`,
          { template: 'green' },
        ));
      } catch (e) {
        log.error(`chat ${chatId}: model action: ${e.stack ?? e}`);
        await this.transport.sendCard(chatId, buildErrorCard('切换失败', e.message)).catch(() => {});
      }
    });
    return true;
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

    // transport-level image failure → surface as a card, never reach the agent
    if (msg.imageError) {
      await this.transport.sendCard(chatId, buildErrorCard('图片接收失败', `${msg.imageError}\n\n若提示无权限，请到飞书开放平台为应用添加「im:resource」（获取消息中的资源文件）权限后重发。`));
      return;
    }

    // pending ask in this chat? plain NON-EMPTY text answers it (image
    // messages carry an empty caption and must not settle an ask silently)
    if (text && this.interactions.handleAskText(chatId, text)) {
      log.info(`chat ${chatId}: text answered pending ask`);
      return;
    }

    // plain text while an image burst is pending = its caption → flush now.
    // Commands (start with '/') run normally; the burst keeps waiting.
    const burst = this.batches.get(chatId);
    if (burst && text && !text.startsWith('/')) {
      burst.text = burst.text ? `${burst.text}\n${text}` : text;
      log.info(`chat ${chatId}: text flushed pending image burst (${burst.images.length} img)`);
      this.#flushImages(chatId);
      return;
    }

    // commands
    if (await this.commands.handle(chatId, text)) return;

    // image traffic → (optional burst window) → sniff → gate → durable commit → image blocks
    if (msg.images?.length) {
      if ((this.config.imageBatchMs ?? 0) > 0) {
        this.#stashImage(chatId, msg);
        return;
      }
      const agent = await this.#agentFor(chatId);
      await this.#submitImages(chatId, agent, msg);
      return;
    }

    // normal text traffic → agent
    const agent = await this.#agentFor(chatId);
    const mode = this.driver.submit(agent, text);
    if (mode === 'steer') {
      this.renderer.setSteerNote(agent.id, text);
      log.info(`chat ${chatId}: steered running agent`);
    }
  }

  /** Resolve (and remember) the live agent bound to a chat. */
  async #agentFor(chatId) {
    const binding = this.store.get(chatId) ?? { sessionId: null, cwd: null };
    if (!binding.cwd) {
      binding.cwd = this.config.defaultCwd;
      if (!isWorkspaceAllowed(this.config, binding.cwd)) {
        throw new Error(`defaultCwd 不在白名单（defaultCwd=${this.config.defaultCwd}）`);
      }
    }
    const agent = await this.driver.ensure(binding);
    this.store.update(chatId, { sessionId: binding.sessionId, cwd: binding.cwd });
    if (this.renderer.chatOf(agent.id) !== chatId) this.renderer.attach(agent.id, chatId);
    return agent;
  }

  // ---------------------------------------------------------- image bursts

  /** Queue one image message into the per-chat burst window. */
  #stashImage(chatId, msg) {
    let b = this.batches.get(chatId);
    if (!b) {
      b = { images: [], text: '', timer: null };
      this.batches.set(chatId, b);
    }
    b.images.push(...msg.images);
    if (msg.text) b.text = b.text ? `${b.text}\n${msg.text}` : msg.text;
    const cap = Math.max(1, this.config.imageBatchMax ?? 9);
    if (b.images.length >= cap) {
      this.#flushImages(chatId);
      return;
    }
    if (!b.timer) {
      b.timer = setTimeout(() => this.#flushImages(chatId), this.config.imageBatchMs);
    }
  }

  /** Empty the burst for a chat (timer-safe). Returns null when none pending. */
  #takeBatch(chatId) {
    const b = this.batches.get(chatId);
    if (!b) return null;
    if (b.timer) clearTimeout(b.timer);
    this.batches.delete(chatId);
    return { images: b.images, text: b.text };
  }

  /** Submit the pending burst (if any) through the serial queue. */
  #flushImages(chatId) {
    const batch = this.#takeBatch(chatId);
    if (!batch) return;
    this.#enqueue(chatId, async () => {
      try {
        const agent = await this.#agentFor(chatId);
        await this.#submitImages(chatId, agent, batch);
      } catch (e) {
        log.error(`chat ${chatId}: image flush: ${e.stack ?? e}`);
        await this.transport.sendCard(chatId, buildErrorCard('图片提交失败', e.message)).catch(() => {});
      }
    });
  }

  /**
   * Image message path: sniff media types, gate on the active model's declared
   * image input, durably commit the batch, then submit with image blocks.
   * Answers with an error card on every refusal.
   */
  async #submitImages(chatId, agent, msg) {
    // 1) media types from magic bytes (Feishu carries no usable content-type)
    const inputs = [];
    for (const img of msg.images) {
      const mediaType = sniffImageMediaType(img.data);
      if (!mediaType) {
        await this.transport.sendCard(chatId, buildErrorCard('不支持的图片格式', '仅支持 PNG / JPEG / WebP / GIF。'));
        return;
      }
      inputs.push({ data: img.data, mediaType, name: img.name });
    }

    // 2) capability gate BEFORE anything durable — a text-only route would
    //    fail mid-turn after the message is committed, leaving a turn that
    //    cannot succeed. Fail-open when the route cannot be resolved.
    const accepts = await this.driver.modelAcceptsImages(agent);
    if (accepts === false) {
      const current = this.driver.currentModel(agent);
      const suggestions = (await this.driver.imageModels()).slice(0, 8);
      await this.transport.sendCard(chatId, buildImageRejectCard({
        current: current ? `${current.provider}/${current.model}` : null,
        suggestions,
        chatId,
      }));
      return;
    }

    // 3) durable commit (batch-validated: no partial writes on refusal)
    let refs;
    try {
      refs = await this.driver.admitImages(inputs);
    } catch (e) {
      const reason = this.#imageAdmissionHint(e);
      await this.transport.sendCard(chatId, buildErrorCard('图片未通过校验', `${reason}\n\n原始错误：${e.message}`));
      return;
    }

    // 4) submit — images first, caption text rides behind
    const mode = this.driver.submit(agent, msg.text || '', refs);
    if (mode === 'steer') {
      this.renderer.setSteerNote(agent.id, msg.text || '📷 图片');
      log.info(`chat ${chatId}: steered running agent with image(s)`);
    } else {
      log.info(`chat ${chatId}: submitted ${refs.length} image(s)`);
    }
  }

  /** Map attachment admission codes to actionable Chinese hints. */
  #imageAdmissionHint(e) {
    switch (e?.code) {
      case 'IMAGE_TOO_LARGE':
      case 'IMAGES_TOO_LARGE':
        return '图片超过大小上限（10MB）。请压缩后重发。';
      case 'IMAGE_DIMENSION_TOO_LARGE':
        return '图片单边超过 8192px 上限。请缩小后重发。';
      case 'IMAGE_TOO_MANY_PIXELS':
        return '图片像素总数超过上限（1 亿像素）。请缩小后重发。';
      case 'UNSUPPORTED_IMAGE_TYPE':
        return '图片格式不受支持（仅 PNG / JPEG / WebP / GIF）。';
      case 'IMAGE_TYPE_MISMATCH':
        return '图片字节与声明格式不符，请转存为 PNG/JPEG 后重发。';
      case 'TOO_MANY_IMAGES':
        return '一条消息的图片数量超上限。';
      default:
        return '图片未能保存。';
    }
  }
}
