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
        if (message.message_type !== 'text') return;
        let text = '';
        try {
          text = JSON.parse(message.content ?? '{}').text ?? '';
        } catch {}
        text = text.replace(/@_user_\d+/g, '').trim();
        if (!text) return;
        await handlers.onMessage({
          chatId: message.chat_id,
          openId: data?.sender?.sender_id?.open_id ?? '',
          messageId: message.message_id,
          chatType: message.chat_type,
          text,
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
