#!/usr/bin/env node
/**
 * replay-render.mjs — 用真实会话事件流回放 TurnRenderer，验证崩溃可复现性
 *
 * Usage: node test/replay-render.mjs <decoded.jsonl> [--turn N] [--throttle 0]
 * 无参数时回放全部事件；--turn 只回放指定回合。
 */
import fs from 'node:fs';
import { TurnRenderer } from '../src/renderer.js';

const file = process.argv[2];
const turnFilter = process.argv.includes('--turn') ? Number(process.argv[process.argv.indexOf('--turn') + 1]) : null;
const throttle = process.argv.includes('--throttle') ? Number(process.argv[process.argv.indexOf('--throttle') + 1]) : 0;

const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// storage record → renderer event(s)
function toEvents(r) {
  const t = r.time ?? r.time0 ?? 0;
  switch (r.type) {
    case 'text-chunks':
      return (r.data.texts ?? []).map((text) => ({ time: t, type: 'assistant/chunk', data: { turn: r.data.turn, step: r.data.step, chunk: { type: 'text-delta', index: r.data.index, text } } }));
    case 'reasoning-chunks':
      return (r.data.texts ?? []).map((text) => ({ time: t, type: 'assistant/chunk', data: { turn: r.data.turn, step: r.data.step, chunk: { type: 'reasoning-delta', index: r.data.index, text } } }));
    default:
      return [{ time: t, type: r.type, data: r.data }];
  }
}

const sentCards = [];
const transport = {
  async sendCard(chatId, card) {
    sentCards.push({ op: 'send', elements: card?.elements?.length ?? 0 });
    if (process.env.REPLAY_FAIL_SEND === '1' && sentCards.length > 2) throw new Error('feishu update 230002: card invalid');
    return { messageId: `m${sentCards.length}` };
  },
  async updateCard(messageId, card) {
    sentCards.push({ op: 'update', messageId, elements: card?.elements?.length ?? 0 });
    return { messageId };
  },
};

const renderer = new TurnRenderer({ transport, config: { throttleMs: throttle, cardTextLimit: 4000, defaultCwd: 'D:\\AI-Teaching-Assistant' }, store: null });
const SESSION_ID = 'session-replay';
renderer.attach(SESSION_ID, 'oc_test');

let count = 0;
let crashed = null;
try {
  for (const r of records) {
    if (r.type === 'session') continue;
    if (turnFilter !== null) {
      const tn = r.data?.turn ?? null;
      if (tn !== null && tn !== turnFilter) continue;
    }
    for (const ev of toEvents(r)) {
      renderer.onEvent({ id: SESSION_ID }, ev);
      count++;
      // 让 throttle=0 的定时器有机会触发（微任务/宏任务交替）
      if (count % 50 === 0) await new Promise((res) => setTimeout(res, 0));
    }
  }
  await new Promise((res) => setTimeout(res, 50));
} catch (e) {
  crashed = e;
}

console.log(`events=${count} cards=${sentCards.length}`);
if (crashed) {
  console.log('CRASH:', crashed.stack);
  process.exit(1);
}
console.log('replay OK, no crash');
