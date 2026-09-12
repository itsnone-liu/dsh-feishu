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
import fs from 'node:fs';
import path from 'node:path';

export class ChatRouter {
  constructor({ config, store, driver, renderer, transport, interactions, commands, visionReady = false, autoContinue = null }) {
    this.config = config;
    this.store = store;
    this.driver = driver;
    this.renderer = renderer;
    this.transport = transport;
    this.interactions = interactions;
    this.commands = commands;
    /** inspect_image registered → text-only models can still take images. */
    this.visionReady = visionReady;
    this.autoContinue = autoContinue;
    /** chatId → promise tail (serial handling) */
    this.queues = new Map();
    /** LRU-ish dedup of inbound message ids */
    this.seen = new Set();
    this.seenOrder = [];
    this.warnedChats = new Set();
    /** chatId → pending image burst { images[], text, timer } */
    this.batches = new Map();
    /** chatId → last steer-ack card time (ms) — throttled to one per 90s */
    this.steerAckAt = new Map();
  }

  /** Transport entry point. Never throws. */
  onMessage(msg) {
    log.debug(`msg in chat=${msg.chatId ?? '?'} ${msg.images?.length ? 'image' : msg.files?.length ? 'file' : 'text'} from=${(msg.openId ?? '?').slice(0, 10)} text="${(msg.text ?? '').slice(0, 40).replace(/\n/g, '⏎')}"`);
    this.#enqueue(msg.chatId, async () => {
      try {
        await this.#handle(msg);
      } catch (e) {
        if (e?.occupied) {
          log.warn(`chat ${msg.chatId}: session occupied elsewhere`);
          await this.transport.sendCard(msg.chatId, buildErrorCard(
            '会话正被另一端使用',
            '该会话当前由其他程序（如 WebUI 或另一个桥进程）占用。\n\n- 在另一端退出/关闭后重发消息即可接续；\n- 或发 `/new` 在本聊天开一个全新会话。',
          )).catch(() => {});
          return;
        }
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
    // normalize: full-width slash (mobile IME) + stray whitespace
    const norm = typeof text === 'string' ? text.replace(/^\s*／/, '/').trim() : text;

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

    // any real user activity cancels pending quota auto-continue for this chat
    this.autoContinue?.cancelForChat(chatId);

    // transport-level image failure → surface as a card, never reach the agent
    if (msg.imageError) {
      await this.transport.sendCard(chatId, buildErrorCard('图片接收失败', `${msg.imageError}\n\n若提示无权限，请到飞书开放平台为应用添加「im:resource」（获取消息中的资源文件）权限后重发。`));
      return;
    }

    // transport-level file failure → surface as a card
    if (msg.fileError) {
      await this.transport.sendCard(chatId, buildErrorCard('文件接收失败', `${msg.fileError}\n\n若提示无权限，请到飞书开放平台核对「im:resource」（获取消息中的资源文件）权限后重发。`));
      return;
    }

    // pending ask in this chat? plain NON-EMPTY text answers it (image
    // messages carry an empty caption and must not settle an ask silently)
    if (norm && this.interactions.handleAskText(chatId, norm)) {
      log.info(`chat ${chatId}: text answered pending ask`);
      return;
    }

    // plain text while an image burst is pending = its caption → flush now.
    // Commands (start with '/') run normally; the burst keeps waiting.
    const burst = this.batches.get(chatId);
    if (burst && norm && !norm.startsWith('/')) {
      burst.text = burst.text ? `${burst.text}\n${norm}` : norm;
      log.info(`chat ${chatId}: text flushed pending image burst (${burst.images.length} img)`);
      this.#flushImages(chatId);
      return;
    }

    // commands
    if (await this.commands.handle(chatId, norm)) return;

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

    // file traffic → flush any pending image burst first (ordering), then
    // persist under the workspace and hand the agent a path note
    if (msg.files?.length) {
      if (this.batches.get(chatId)) this.#flushImages(chatId);
      const agent = await this.#agentFor(chatId);
      await this.#submitFiles(chatId, agent, msg);
      return;
    }

    // normal text traffic → agent
    const agent = await this.#agentFor(chatId);
    const mode = this.driver.submit(agent, norm);
    if (mode === 'steer') {
      this.renderer.setSteerNote(agent.id, norm);
      this.#steerAck(chatId);
      log.info(`chat ${chatId}: steered running agent`);
    }
  }

  /** Steer 到忙碌 agent 的即时回执（限频 90s/聊天）。
   *  消息进了 next-step 队列后要等当前步骤结束才生效——若回合正卡在长
   *  工具调用/后台作业轮询上（常见 1-2 分钟），用户毫无反馈，会以为
   *  「继续」没反应而连发甚至重启桥（2026-09-09 12:07 事故④）。一张
   *  轻量灰卡把「已收到、何时生效」说清楚。 */
  #steerAck(chatId) {
    const now = Date.now();
    const last = this.steerAckAt.get(chatId) ?? 0;
    if (now - last < 90_000) return;
    this.steerAckAt.set(chatId, now);
    this.transport.sendCard(chatId, buildInfoCard('⏳ 任务进行中，消息已注入', [
      '当前回合还在跑（可能在等长工具调用或后台作业，常见 1-2 分钟）。',
      '你的消息会在当前步骤结束后生效，无需重发。',
    ].join('\n'), { template: 'grey' })).catch(() => {});
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
    // A bound session that failed to resume was replaced by a NEW session —
    // never let that happen silently (2026-08-26 context-loss incident).
    for (const notice of this.driver.drainResumeFallbacks()) {
      await this.transport.sendCard(chatId, buildInfoCard(
        '⚠️ 旧会话无法恢复，已自动开启新会话',
        [
          `原会话 \`${String(notice.from ?? '').slice(0, 24)}\` 恢复失败：${String(notice.reason ?? '未知原因').slice(0, 160)}`,
          '',
          '本聊天已绑定**新会话**（上下文从零开始）。旧会话文件仍在磁盘上，可用 `/sessions` 查看后 `/resume <id前缀>` 手动接续。',
        ].join('\n'),
        { template: 'orange' },
      )).catch(() => {});
    }
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
        if (e?.occupied) {
          await this.transport.sendCard(chatId, buildErrorCard(
            '会话正被另一端使用',
            '该会话当前由其他程序（如 WebUI 或另一个桥进程）占用。\n\n- 在另一端退出/关闭后重发图片；\n- 或发 `/new` 开一个全新会话。',
          )).catch(() => {});
          return;
        }
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
    //    NEW: with the external inspect_image tool registered, a text-only
    //    model still works — the images ride as durable attachment refs in a
    //    text note and the agent farms them out to the vision endpoint.
    const accepts = await this.driver.modelAcceptsImages(agent);
    if (accepts === false && this.visionReady) {
      return await this.#submitImagesViaVisionTool(chatId, agent, msg, inputs);
    }
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

  /**
   * Text-only model + external vision tool: durably commit the batch, then
   * submit a TEXT note listing the attachment refs. The agent calls
   * inspect_image(attachment=…) per image — no model switch, no 1210.
   */
  async #submitImagesViaVisionTool(chatId, agent, msg, inputs) {
    let refs;
    try {
      refs = await this.driver.admitImages(inputs);
    } catch (e) {
      const reason = this.#imageAdmissionHint(e);
      await this.transport.sendCard(chatId, buildErrorCard('图片未通过校验', `${reason}\n\n原始错误：${e.message}`));
      return;
    }
    const lines = refs.map((ref, i) => {
      const name = ref.name ? `「${ref.name}」` : `第 ${i + 1} 张`;
      return `- ${name}（${ref.mediaType}，${ref.width ?? '?'}×${ref.height ?? '?'}）：\n  ${JSON.stringify(ref)}`;
    });
    const caption = msg.text ? `\n用户说：${msg.text}` : '';
    const note = [
      `[飞书图片] 收到 ${refs.length} 张图片，已保存为持久附件（当前主模型只接受文本）。`,
      '请使用 inspect_image 工具逐张识别（attachment 参数原样传下面任一行的 JSON），然后回答用户关于图片的问题。',
      ...lines,
      caption,
    ].join('\n');
    const mode = this.driver.submit(agent, note);
    if (mode === 'steer') {
      this.renderer.setSteerNote(agent.id, msg.text || `📷 图片 ×${refs.length}（外挂识图）`);
      log.info(`chat ${chatId}: steered running agent with ${refs.length} image(s) via vision tool`);
    } else {
      log.info(`chat ${chatId}: submitted ${refs.length} image(s) via vision tool path`);
    }
  }

  // ------------------------------------------------------------- file path

  /**
   * File (non-image) messages: persist bytes under the workspace and submit a
   * path note to the agent. Works with text-only models — the agent reads the
   * file with its own tools.
   */
  async #submitFiles(chatId, agent, msg) {
    const cwd = this.store.get(chatId)?.cwd ?? this.config.defaultCwd;
    const dir = path.join(cwd, '.feishu-files');
    const maxBytes = this.config.fileMaxBytes ?? 10485760;
    const saved = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of msg.files) {
        if (f.data?.byteLength > maxBytes) {
          await this.transport.sendCard(chatId, buildErrorCard(
            '文件过大',
            `「${f.name}」 ${(f.data.byteLength / 1048576).toFixed(1)}MB 超过上限 ${Math.round(maxBytes / 1048576)}MB，未保存。`,
          ));
          continue;
        }
        const safe = String(f.name ?? 'file')
          .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
          .replace(/^\.+/, '_')
          .slice(-80) || 'file';
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const dest = path.join(dir, `${ts}-${safe}`);
        fs.writeFileSync(dest, f.data);
        saved.push({ name: safe, dest, bytes: f.data.byteLength });
      }
    } catch (e) {
      await this.transport.sendCard(chatId, buildErrorCard('文件保存失败', e.message));
      return;
    }
    if (saved.length === 0) return;

    const lines = saved.map((s) => {
      const ext = path.extname(s.name).toLowerCase();
      const kind = /^\.(txt|md|csv|json|py|js|ts|mjs|cjs|html|css|xml|yml|yaml|log|ini|toml|sh|bat|ps1|java|c|cpp|h|go|rs|sql|env)$/.test(ext)
        ? '文本，可直接读取'
        : '二进制，请按扩展名选择工具处理';
      return `- 「${s.name}」（${(s.bytes / 1024).toFixed(1)} KB，${kind}）：\n  ${s.dest}`;
    });
    const note = [
      '[飞书文件] 收到以下文件，已保存到工作区：',
      ...lines,
      '',
      '请按用户后续指示处理这些文件。',
    ].join('\n');

    const mode = this.driver.submit(agent, note);
    if (mode === 'steer') {
      this.renderer.setSteerNote(agent.id, `📎 文件 ×${saved.length}`);
      log.info(`chat ${chatId}: steered running agent with ${saved.length} file(s)`);
    } else {
      log.info(`chat ${chatId}: submitted ${saved.length} file(s)`);
    }
    await this.transport.sendCard(chatId, buildInfoCard(
      '📎 文件已接收',
      `${lines.join('\n')}\n\n已转交 agent（可直接说「读一下刚才的文件」）。`,
      { template: 'green' },
    )).catch(() => {});
  }

  /** Map attachment admission codes to actionable Chinese hints. */
  #imageAdmissionHint(e) {    switch (e?.code) {
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
