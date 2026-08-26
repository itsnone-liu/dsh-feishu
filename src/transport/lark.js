/**
 * Vendored Feishu/Lark client — no SDK dependency.
 *
 * REST (high confidence, documented stable APIs):
 *   POST /open-apis/auth/v3/tenant_access_token/internal   → token
 *   POST /open-apis/im/v1/messages?receive_id_type=chat_id → send
 *   PUT  /open-apis/im/v1/messages/{message_id}            → update card
 *
 * WS long connection (best-effort reconstruction of the SDK protocol; if the
 * handshake details drift, fix ONLY this section — everything downstream of
 * `onMessage/onCardAction` is transport-agnostic):
 *   GET  {endpointPath} with Bearer token → { data: { endpoints: [...] } }
 *   connect → send {type:'register', data:{app_id, app_secret}}
 *   every 25s → {type:'heartbeat'} ; events arrive as {type:'event', ...}
 *
 * For production, prefer transport 'sdk' (install @larksuiteoapi/node-sdk) —
 * this vendored path exists so the bridge runs with zero npm dependencies.
 */
import { log } from '../log.js';
import { sleep, groupAdmission } from '../util.js';

export class LarkTransport {
  #botInfoAt = 0;

  constructor(config) {
    this.kind = 'vendored';
    this.config = config;
    this.handlers = null;
    this.token = null;
    this.tokenExpireAt = 0;
    this.tokenFetching = null;
    this.ws = null;
    this.closed = false;
    this.heartbeatTimer = null;
    /** Cached bot open_id (null while unresolved). */
    this.botOpenId = undefined;
  }

  // ------------------------------------------------------------- REST core

  async #tenantToken() {
    if (this.token && Date.now() < this.tokenExpireAt) return this.token;
    if (this.tokenFetching) return this.tokenFetching;
    this.tokenFetching = (async () => {
      const res = await this.#rawRequest('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }, { auth: false });
      if (res.code !== 0) throw new Error(`token error ${res.code}: ${res.msg}`);
      this.token = res.tenant_access_token;
      this.tokenExpireAt = Date.now() + (res.expire ?? 3600) * 1000 - 120_000;
      return this.token;
    })();
    try {
      return await this.tokenFetching;
    } finally {
      this.tokenFetching = null;
    }
  }

  async #rawRequest(method, path, body, { auth = true, query = '' } = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (auth) headers.Authorization = `Bearer ${await this.#tenantToken()}`;
    const res = await fetch(`${this.config.apiBase}${path}${query}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`feishu http ${res.status} ${path}`);
    return await res.json();
  }

  /**
   * Resolve our own open_id via GET /open-apis/bot/v3/info (cached, retried
   * at most once per minute). Group @-mention gating fails closed without it.
   */
  async #ensureBotOpenId() {
    if (this.botOpenId !== undefined) return this.botOpenId;
    if (Date.now() - this.#botInfoAt < 60000) return null;
    this.#botInfoAt = Date.now();
    try {
      const res = await this.#rawRequest('GET', '/open-apis/bot/v3/info');
      this.botOpenId = res?.bot?.open_id ?? null;
      if (this.botOpenId) log.info(`bot open_id resolved: ${this.botOpenId}`);
      else log.warn('bot/v3/info returned no open_id — group mention gating fails closed');
    } catch (e) {
      this.botOpenId = null;
      log.warn(`bot/v3/info failed（群聊 @ 门控将失效关闭）: ${e.message}`);
    }
    return this.botOpenId;
  }

  async #api(method, path, body, query = '') {
    let res = await this.#rawRequest(method, path, body, { query });
    if (res.code === 99991663 || res.code === 99991661) {
      // token expired/invalid → refresh once and retry
      this.token = null;
      this.tokenExpireAt = 0;
      res = await this.#rawRequest(method, path, body, { query });
    }
    if (res.code !== 0) throw new Error(`feishu api ${res.code}: ${res.msg ?? JSON.stringify(res).slice(0, 120)}`);
    return res;
  }

  async sendCard(chatId, card) {
    const res = await this.#api('POST', '/open-apis/im/v1/messages', {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }, '?receive_id_type=chat_id');
    return { messageId: res.data?.message_id };
  }

  async updateCard(messageId, card) {
    await this.#api('PUT', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: JSON.stringify(card),
    });
    return { messageId };
  }

  async sendText(chatId, text) {
    const res = await this.#api('POST', '/open-apis/im/v1/messages', {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }, '?receive_id_type=chat_id');
    return { messageId: res.data?.message_id };
  }

  /**
   * Download one resource attached to a message (binary REST, no JSON wrap).
   * @param {'image'|'file'} type
   * @returns {Promise<{ data: Uint8Array, name: string }>} raw bytes + display name
   */
  async downloadMessageResource(messageId, fileKey, type = 'image', name = fileKey) {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
      + `/resources/${encodeURIComponent(fileKey)}`;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    headers.Authorization = `Bearer ${await this.#tenantToken()}`;
    let res = await fetch(`${this.config.apiBase}${path}?type=${type}`, { headers });
    if (res.status === 401) {
      // token expired/invalid → refresh once and retry
      this.token = null;
      this.tokenExpireAt = 0;
      headers.Authorization = `Bearer ${await this.#tenantToken()}`;
      res = await fetch(`${this.config.apiBase}${path}?type=${type}`, { headers });
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.msg ? ` ${body.msg}` : '';
        if (body?.code) detail = ` (code ${body.code}) ${body.msg ?? ''}`;
      } catch {}
      throw new Error(`feishu http ${res.status} 资源下载${detail}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return { data: buf, name };
  }

  // -------------------------------------------------------------- WS part

  async start(handlers) {
    this.handlers = handlers;
    this.closed = false;
    this.#connectLoop().catch((e) => log.error(`ws loop: ${e.stack ?? e}`));
  }

  async stop() {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.ws?.close();
    } catch {}
  }

  async #connectLoop() {
    let backoff = 1000;
    while (!this.closed) {
      const startedAt = Date.now();
      try {
        await this.#connectOnce();
        // Resolved = the live session genuinely ended. Reconnect right away,
        // but only reset the backoff when the session lived a while (a
        // flapping socket must not reset its own escape valve).
        if (Date.now() - startedAt > 60_000) backoff = 1000;
      } catch (e) {
        if (this.closed) return;
        log.warn(`ws: ${e.message}; reconnect in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async #endpoints() {
    // Feishu long-connection endpoint discovery (matching lark_oapi ws.Client):
    //   POST {apiBase}/callback/ws/endpoint
    //   body { AppID, AppSecret }   →   { code:0, data:{ URL:"wss://..." } }
    // The old GET /open-apis/endpoint/v1 path returns 404 (no longer valid).
    const res = await fetch(`${this.config.apiBase}${this.config.endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        AppID: this.config.appId,
        AppSecret: this.config.appSecret,
      }),
    });
    if (!res.ok) throw new Error(`feishu http ${res.status} ${this.config.endpointPath}`);
    const body = await res.json();
    if (body.code !== 0) throw new Error(`feishu endpoint discovery error code=${body.code} msg=${body.msg}`);
    const url = body?.data?.URL;
    if (!url) throw new Error(`no ws endpoint: ${JSON.stringify(body).slice(0, 120)}`);
    // DSL-style: #connectOnce picks a random element, so return the single URL as an array.
    return [url];
  }

  async #connectOnce() {
    const endpoints = await this.#endpoints();
    const url = endpoints[Math.floor(Math.random() * endpoints.length)];

    // Phase 1: connect + register (bounded by a 15s timeout).
    const ws = new WebSocket(url);
    this.ws = ws;
    let registered = false;
    let serverDisconnect = false;
    let registerTimer = null;

    await new Promise((resolve, reject) => {
      registerTimer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('register timeout'));
      }, 15_000);

      const failEarly = (what) => {
        if (registered) return;
        clearTimeout(registerTimer);
        reject(new Error(what));
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
          data: { app_id: this.config.appId, app_secret: this.config.appSecret },
        }));
      });

      ws.addEventListener('message', (ev) => {
        let frame;
        try {
          frame = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        } catch {
          log.debug(`ws: unparsable frame`);
          return;
        }
        if (frame.type === 'register') {
          registered = true;
          clearTimeout(registerTimer);
          log.info('ws: registered');
          this.#startHeartbeat(ws);
          resolve();
          return;
        }
        if (frame.type === 'heartbeat') return;
        if (frame.type === 'event') {
          this.#dispatchEvent(frame.data ?? frame).catch((e) => log.error(`event dispatch: ${e.message}`));
          return;
        }
        if (frame.type === 'disconnect') {
          // Server-side rebalance: it wants us on a different endpoint.
          log.warn('ws: server asked to reconnect');
          serverDisconnect = true;
          try { ws.close(); } catch {}
          return;
        }
        log.debug(`ws: frame ${frame.type}`);
      });

      ws.addEventListener('error', () => failEarly('websocket error'));
      ws.addEventListener('close', () => failEarly('closed before register'));
    });

    // Phase 2: HOLD this connection until it actually ends. The old code
    // resolved after register and the reconnect loop immediately opened a
    // SECOND connection while the first kept heartbeating server-side —
    // "ws: registered" storms until Feishu's connection limit (1000040350)
    // rejected even endpoint discovery (2026-08-26). A connection must be
    // either the only live one or explicitly closed.
    await new Promise((resolve) => {
      const done = () => { if (resolved) return; resolved = true; resolve(); };
      let resolved = false;
      ws.addEventListener('close', () => done());
      ws.addEventListener('error', () => done()); // error is always followed by close
    });
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (serverDisconnect) log.warn('ws: session ended (server rebalance)');
    // Resolve (not throw): the loop reconnects immediately — one connection
    // at a time, the previous one is closed before the next dials.
  }

  #startHeartbeat(ws) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'heartbeat', data: {} }));
      } catch {}
    }, 25_000);
  }

  async #dispatchEvent(data) {
    const eventType = data?.header?.event_type;
    const event = data?.event ?? {};
    if (eventType === 'im.message.receive_v1') {
      const message = event.message ?? {};
      const sender = event.sender ?? {};
      const chatType = message.chat_type;
      const type = message.message_type;
      if (type !== 'text' && type !== 'image' && type !== 'file') return;
      if (chatType !== 'p2p') {
        const adm = groupAdmission(this.config, chatType, type, message.mentions ?? [], await this.#ensureBotOpenId());
        if (!adm.ok) return;
      }
      let text = '';
      let images = [];
      let imageError = '';
      let files = [];
      let fileError = '';
      if (type === 'text') {
        try {
          text = JSON.parse(message.content ?? '{}').text ?? '';
        } catch {}
      } else if (type === 'image') {
        // image message: content is {"image_key": "img_v2_..."}
        let imageKey = '';
        try {
          imageKey = JSON.parse(message.content ?? '{}').image_key ?? '';
        } catch {}
        if (imageKey) {
          try {
            images = [await this.downloadMessageResource(message.message_id, imageKey, 'image')];
          } catch (e) {
            imageError = `图片下载失败：${e.message}`;
          }
        }
      } else {
        // file message: content is {"file_key": "...", "file_name": "..."}
        let fileKey = '';
        let fileName = '';
        try {
          const c = JSON.parse(message.content ?? '{}');
          fileKey = c.file_key ?? '';
          fileName = c.file_name ?? '';
        } catch {}
        if (fileKey) {
          try {
            files = [await this.downloadMessageResource(message.message_id, fileKey, 'file', fileName || fileKey)];
          } catch (e) {
            fileError = `文件下载失败：${e.message}`;
          }
        }
      }
      text = text.replace(/@_user_\d+/g, '').trim();
      if (!text && images.length === 0 && files.length === 0 && !imageError && !fileError) return;
      this.handlers.onMessage({
        chatId: message.chat_id,
        openId: sender.sender_id?.open_id ?? '',
        messageId: message.message_id,
        chatType,
        text,
        images,
        imageError,
        files,
        fileError,
      });
      return;
    }
    if (eventType === 'card.action.trigger') {
      const value = event?.action?.value;
      const openId = event?.operator?.open_id ?? event?.operator?.sender_id?.open_id ?? '';
      if (value && typeof value === 'object') {
        this.handlers.onCardAction({ value, openId });
      }
      return;
    }
    log.debug(`ws: ignored event ${eventType}`);
  }
}
