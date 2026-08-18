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
import { sleep } from '../util.js';

export class LarkTransport {
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
      try {
        await this.#connectOnce();
        backoff = 1000; // reset only after a clean session ends
      } catch (e) {
        log.warn(`ws: ${e.message}; reconnect in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async #endpoints() {
    const res = await this.#rawRequest('GET', this.config.endpointPath, undefined, {
      query: `?app_id=${encodeURIComponent(this.config.appId)}`,
    });
    const list = res?.data?.endpoints;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`no endpoints: ${JSON.stringify(res).slice(0, 120)}`);
    }
    return list;
  }

  async #connectOnce() {
    const endpoints = await this.#endpoints();
    const url = endpoints[Math.floor(Math.random() * endpoints.length)];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let registered = false;

      const fail = (e) => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        reject(e);
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
          log.warn('ws: server asked to reconnect');
          fail(new Error('server disconnect'));
          return;
        }
        log.debug(`ws: frame ${frame.type}`);
      });

      ws.addEventListener('error', () => fail(new Error('websocket error')));
      ws.addEventListener('close', () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (!registered) fail(new Error('closed before register'));
        else reject(new Error('session closed'));
      });

      // register timeout
      setTimeout(() => {
        if (!registered) fail(new Error('register timeout'));
      }, 15_000);
    });
  }

  #startHeartbeat(ws) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'heartbeat', data: {} }));
      } catch {}
    }, 25_000);
  }

  #dispatchEvent(data) {
    const eventType = data?.header?.event_type;
    const event = data?.event ?? {};
    if (eventType === 'im.message.receive_v1') {
      const message = event.message ?? {};
      const sender = event.sender ?? {};
      const chatType = message.chat_type;
      if (chatType !== 'p2p' && !this.config.allowGroupChats) return;
      if (message.message_type !== 'text') return;
      let text = '';
      try {
        text = JSON.parse(message.content ?? '{}').text ?? '';
      } catch {}
      text = text.replace(/@_user_\d+/g, '').trim();
      if (!text) return;
      this.handlers.onMessage({
        chatId: message.chat_id,
        openId: sender.sender_id?.open_id ?? '',
        messageId: message.message_id,
        chatType,
        text,
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
