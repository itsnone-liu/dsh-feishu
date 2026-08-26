/**
 * Adapter over the official `@larksuiteoapi/node-sdk` (production path).
 *
 * The SDK's WSClient owns the long connection and event dispatch; we only
 * wrap its Client for the im/v1 message APIs so sendCard/updateCard keep the
 * transport interface. Install with:
 *   dsh plugin --profile feishu add @larksuiteoapi/node-sdk
 */
import { log } from '../log.js';
import { groupAdmission } from '../util.js';

export class SdkTransport {
  constructor(config, sdk) {
    this.kind = 'sdk';
    this.config = config;
    this.sdk = sdk;
    this.client = new sdk.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: sdk.AppType.SelfBuild,
      domain: config.apiBase,
    });
    /** Cached bot open_id (null while unresolved). */
    this.botOpenId = undefined;
  }
  #botInfoAt = 0;

  /**
   * Resolve our own open_id via GET /open-apis/bot/v3/info (cached, retried
   * at most once per minute). Group @-mention gating fails closed without it.
   */
  async #ensureBotOpenId() {
    if (this.botOpenId !== undefined) return this.botOpenId;
    if (Date.now() - this.#botInfoAt < 60000) return null;
    this.#botInfoAt = Date.now();
    try {
      const res = await this.client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
      this.botOpenId = res?.data?.bot?.open_id ?? res?.bot?.open_id ?? null;
      if (this.botOpenId) log.info(`bot open_id resolved: ${this.botOpenId}`);
      else log.warn('bot/v3/info returned no open_id — group mention gating fails closed');
    } catch (e) {
      this.botOpenId = null;
      log.warn(`bot/v3/info failed（群聊 @ 门控将失效关闭）: ${e.message}`);
    }
    return this.botOpenId;
  }

  async start(handlers) {
    const dispatcher = new this.sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const message = data?.message ?? {};
        const chatType = message.chat_type;
        const type = message.message_type;
        if (type !== 'text' && type !== 'image' && type !== 'file') return;
        // group gate (p2p always passes)
        if (chatType !== 'p2p') {
          const adm = groupAdmission(this.config, chatType, type, message.mentions ?? [], await this.#ensureBotOpenId());
          if (!adm.ok) {
            // never silent: a dropped message with zero log lines is
            // indistinguishable from a dead bridge (2026-08-26 incident)
            log.info(`group message dropped (chat=${message.chat_id?.slice(0, 12)}… reason=${adm.reason ?? 'group policy'})`);
            return;
          }
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
        await handlers.onMessage({
          chatId: message.chat_id,
          openId: data?.sender?.sender_id?.open_id ?? '',
          messageId: message.message_id,
          chatType: message.chat_type,
          text,
          images,
          imageError,
          files,
          fileError,
        });
      },
      'card.action.trigger': async (data) => {
        const value = data?.event?.action?.value;
        if (value && typeof value === 'object') {
          await handlers.onCardAction({
            value,
            openId: data?.operator?.open_id ?? data?.operator?.sender_id?.open_id ?? '',
          });
        }
      },
    });
    this.wsClient = new this.sdk.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.apiBase,
      loggerLevel: this.sdk.LoggerLevel.info,
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
    log.info('sdk ws client started');
  }

  /**
   * Download one resource attached to a message (im/v1 message-resource API).
   * @param {'image'|'file'} type
   * @returns {Promise<{ data: Uint8Array, name: string }>} raw bytes + display name
   */
  async downloadMessageResource(messageId, fileKey, type = 'image', name = fileKey) {
    const res = await this.client.im.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    const stream = res?.getReadableStream?.();
    if (!stream) throw new Error('响应中没有可读流（getReadableStream 缺失）');
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { data: new Uint8Array(Buffer.concat(chunks)), name };
  }

  async stop() {
    try {
      await this.wsClient?.close();
    } catch {}
  }

  async sendCard(chatId, card) {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (res.code !== 0) throw new Error(`feishu send ${res.code}: ${res.msg}`);
    return { messageId: res.data?.message_id };
  }

  async updateCard(messageId, card) {
    const res = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    if (res.code !== 0) throw new Error(`feishu update ${res.code}: ${res.msg}`);
    return { messageId };
  }

  async sendText(chatId, text) {
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0) throw new Error(`feishu send ${res.code}: ${res.msg}`);
    return { messageId: res.data?.message_id };
  }
}
