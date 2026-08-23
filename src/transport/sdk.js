/**
 * Adapter over the official `@larksuiteoapi/node-sdk` (production path).
 *
 * The SDK's WSClient owns the long connection and event dispatch; we only
 * wrap its Client for the im/v1 message APIs so sendCard/updateCard keep the
 * transport interface. Install with:
 *   dsh plugin --profile feishu add @larksuiteoapi/node-sdk
 */
import { log } from '../log.js';

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
  }

  async start(handlers) {
    const dispatcher = new this.sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const message = data?.message ?? {};
        if (message.chat_type !== 'p2p' && !this.config.allowGroupChats) return;
        const type = message.message_type;
        if (type !== 'text' && type !== 'image') return;
        let text = '';
        let images = [];
        let imageError = '';
        if (type === 'text') {
          try {
            text = JSON.parse(message.content ?? '{}').text ?? '';
          } catch {}
        } else {
          // image message: content is {"image_key": "img_v2_..."}
          let imageKey = '';
          try {
            imageKey = JSON.parse(message.content ?? '{}').image_key ?? '';
          } catch {}
          if (imageKey) {
            try {
              images = [await this.downloadMessageImage(message.message_id, imageKey)];
            } catch (e) {
              imageError = `图片下载失败：${e.message}`;
            }
          }
        }
        text = text.replace(/@_user_\d+/g, '').trim();
        if (!text && images.length === 0 && !imageError) return;
        await handlers.onMessage({
          chatId: message.chat_id,
          openId: data?.sender?.sender_id?.open_id ?? '',
          messageId: message.message_id,
          chatType: message.chat_type,
          text,
          images,
          imageError,
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
   * Download one image attached to a message (im/v1 message-resource API).
   * @returns {Promise<{ data: Uint8Array, name: string }>} raw bytes + display name
   */
  async downloadMessageImage(messageId, fileKey) {
    const res = await this.client.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: fileKey },
    });
    const stream = res?.getReadableStream?.();
    if (!stream) throw new Error('响应中没有可读流（getReadableStream 缺失）');
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { data: new Uint8Array(Buffer.concat(chunks)), name: fileKey };
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
