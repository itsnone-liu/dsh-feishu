#!/usr/bin/env node
/**
 * fold-metrics.mjs — replay a real decoded session through TurnRenderer and
 * report, per turn, how many blocks were folded out of the user-visible card.
 *
 * This is the user-facing regression metric for the 2026-09-20 cap change
 * (MAX_CARD_ELEMENTS 28 -> 60): "输出不完整" == blocks silently folded away.
 *
 * Usage: node tools/fold-metrics.mjs <decoded.jsonl>
 */
import fs from 'node:fs';
import { TurnRenderer } from '../src/renderer.js';

const file = process.argv[2];
if (!file) { console.error('usage: fold-metrics.mjs <decoded.jsonl>'); process.exit(1); }

const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

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

// Capture every card the renderer hands to the transport, tagged by turn.
const perTurn = new Map(); // turnNo -> last card snapshot
const transport = {
  async sendCard(chatId, card) { return { messageId: `m${Math.random()}` }; },
  async updateCard(messageId, card) { return { messageId }; },
};

// Intercept the built card by wrapping buildTurnCard via the renderer's config?
// Simpler: monkeypatch the module's export is not possible for ESM live bindings,
// so instead we inspect the card by hooking the transport AND recomputing fold
// info from the JSON we can see.
let last = null;
const origSend = transport.sendCard;
transport.sendCard = async (chatId, card) => { last = card; return { messageId: 'm1' }; };
transport.updateCard = async (messageId, card) => { last = card; return { messageId }; };

const renderer = new TurnRenderer({
  transport,
  config: { throttleMs: 0, cardTextLimit: 4000, defaultCwd: 'D:\\AI-Teaching-Assistant' },
  store: null,
});

// Track turn boundaries ourselves so we can attribute the final card to a turn.
let currentTurn = null;
const turnCards = new Map();

const origOnEvent = renderer.onEvent.bind(renderer);
renderer.onEvent = (sess, ev) => {
  if (ev.type === 'turn/start') currentTurn = ev.data?.turn ?? ev.data?.turnNo ?? currentTurn;
  origOnEvent(sess, ev);
  if (last && currentTurn != null) {
    const flat = JSON.stringify(last);
    const m = flat.match(/已折叠 (\d+) 个中间块/);
    turnCards.set(currentTurn, {
      folded: m ? Number(m[1]) : 0,
      elements: last.elements?.length ?? 0,
      chars: (flat.match(/chars/) ? 0 : 0),
    });
  }
};

renderer.attach('session-replay', 'oc_test');

let count = 0;
for (const r of records) {
  if (r.type === 'session') continue;
  for (const ev of toEvents(r)) {
    renderer.onEvent({ id: 'session-replay' }, ev);
    count++;
    if (count % 50 === 0) await new Promise((res) => setTimeout(res, 0));
  }
}
await new Promise((res) => setTimeout(res, 120));

console.log(`events=${count}  turns=${turnCards.size}`);
console.log('turn | foldedBlocks | elements');
let anyFold = 0;
for (const [t, v] of [...turnCards.entries()].sort((a, b) => a[0] - b[0])) {
  if (v.folded > 0) anyFold++;
  console.log(`${String(t).padStart(4)} | ${String(v.folded).padStart(12)} | ${v.elements}`);
}
console.log(`\nTURNS WITH FOLDING: ${anyFold} / ${turnCards.size}`);