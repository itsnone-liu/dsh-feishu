// Synthetic check: llm/retry shows in working card; quota error gets friendly text.
import { TurnRenderer } from '../src/renderer.js';

const cards = [];
const transport = {
  async sendCard(_c, card) { cards.push(card); return { messageId: 'm1' }; },
  async updateCard(_m, card) { cards.push(card); return { messageId: 'm1' }; },
};
const r = new TurnRenderer({ transport, config: { throttleMs: 0, cardTextLimit: 6000, cardRetryBaseMs: 10 }, store: null });
r.attach('s1', 'c1');
const ev = (type, data) => r.onEvent({ id: 's1' }, { type, data });

ev('session/title', { title: '测试' });
ev('turn/start', { turn: 1 });
ev('llm/retry', { turn: 1, step: 1, provider: 'glm_coding', retry: 2, maxRetries: 5, delayMs: 9021 });
await new Promise((res) => setTimeout(res, 80));
console.log('working card retry line:', JSON.stringify(cards[cards.length - 1]).includes('自动重试 2/5'));

ev('assistant/message', { message: { content: [{ type: 'text', text: '好的，继续。' }] }, usage: { inputTokens: 10, outputTokens: 5 } });
ev('turn/end', { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-08-26 20:36:10 重置。"}' } } });
await new Promise((res) => setTimeout(res, 200));
const final = cards[cards.length - 1];
const els = final.elements.map((e) => e.text?.content ?? '').filter(Boolean);
console.log('final title:', final.header.title.content);
console.log('friendly quota text:', els.some((x) => x.includes('额度窗口用尽') && x.includes('20:36')));
console.log('no raw 1308 JSON dump:', !els.some((x) => x.includes('{"code":"1308"')));

ev('turn/start', { turn: 2 });
ev('llm/retry', { turn: 2, step: 1, provider: 'glm_coding', retry: 1, maxRetries: 5, delayMs: 500 });
ev('turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } });
await new Promise((res) => setTimeout(res, 200));
const ab = cards[cards.length - 1];
console.log('aborted → stopped header:', ab.header.title.content.includes('已停止'));
