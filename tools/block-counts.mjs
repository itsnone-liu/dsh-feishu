#!/usr/bin/env node
/**
 * block-counts.mjs — what block count does each turn ACTUALLY accumulate in the
 * renderer's state? (fold-metrics only sees the cards handed to the transport,
 * which under throttle=0 may be early snapshots.) Instrument the renderer's
 * state directly.
 */
import fs from 'node:fs';
import { TurnRenderer } from '../src/renderer.js';

const file = process.argv[2];
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

const transport = { async sendCard() { return { messageId: 'm1' }; }, async updateCard() { return {}; } };
const renderer = new TurnRenderer({
  transport,
  config: { throttleMs: 0, cardTextLimit: 4000, defaultCwd: 'D:\\AI-Teaching-Assistant' },
  store: null,
});

// Reach into renderer state via the private sessions map by observing onEvent.
const peaks = new Map();
const orig = renderer.onEvent.bind(renderer);
renderer.onEvent = (sess, ev) => {
  orig(sess, ev);
  // find state objects on the renderer instance
  for (const key of Object.getOwnPropertyNames(renderer)) {
    const v = renderer[key];
    if (v instanceof Map) {
      for (const st of v.values()) {
        if (st && typeof st === 'object' && Array.isArray(st.blocks) && st.turnNo != null) {
          const n = st.blocks.filter(Boolean).length;
          const prev = peaks.get(st.turnNo);
          if (!prev || n > prev.blocks) {
            peaks.set(st.turnNo, {
              blocks: n,
              textChars: st.blocks.filter((b) => b?.kind === 'text').reduce((a, b) => a + (b.text?.length || 0), 0),
              fullOutputPath: st.fullOutputPath || '',
              outputDumped: !!st.outputDumped,
            });
          }
        }
      }
    }
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
await new Promise((res) => setTimeout(res, 150));

const CAP = 60;
console.log('turn | peakBlocks | textChars | wouldFoldAt28 | wouldFoldAt60 | dumped');
let fold28 = 0, fold60 = 0;
for (const [t, v] of [...peaks.entries()].sort((a, b) => a[0] - b[0])) {
  const f28 = v.blocks > 28 ? (v.blocks - (Math.ceil(28 * 0.6) + Math.floor(28 * 0.3))) : 0;
  const f60 = v.blocks > CAP ? (v.blocks - (Math.ceil(CAP * 0.6) + Math.floor(CAP * 0.3))) : 0;
  if (f28 > 0) fold28++;
  if (f60 > 0) fold60++;
  console.log(`${String(t).padStart(4)} | ${String(v.blocks).padStart(10)} | ${String(v.textChars).padStart(9)} | ${String(f28).padStart(13)} | ${String(f60).padStart(13)} | ${v.outputDumped ? 'yes' : 'no'}`);
}
console.log(`\nTURNS FOLDED at cap=28: ${fold28} / ${peaks.size}`);
console.log(`TURNS FOLDED at cap=60: ${fold60} / ${peaks.size}`);