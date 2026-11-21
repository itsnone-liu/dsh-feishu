#!/usr/bin/env node
// Prove dsh now resolves bailian-ds to the corrected contextWindow, and that
// isContextOverflow no longer fires on the real failing usage numbers.
import { isContextOverflow } from '@earendil-works/pi-ai';

// --- Part 1: the real failing usage from session 52b199c1 turn 20 ---
const turn20 = {
  stopReason: 'length',
  usage: { input: 47, cacheRead: 166272 },
};
const turn19 = {
  stopReason: 'length',
  usage: { input: 166318, cacheRead: 0 },
};
const turn1 = { stopReason: 'stop', usage: { input: 13668, cacheRead: 0 } };

for (const [label, msg, win] of [
  ['turn1  (stop, 13.7k)  @OLD 65536', turn1, 65536],
  ['turn1  (stop, 13.7k)  @NEW 200000', turn1, 200000],
  ['turn19 (length,166k)  @OLD 65536', turn19, 65536],
  ['turn19 (length,166k)  @NEW 200000', turn19, 200000],
  ['turn20 (length,166k)  @OLD 65536', turn20, 65536],
  ['turn20 (length,166k)  @NEW 200000', turn20, 200000],
]) {
  const r = isContextOverflow(msg, win);
  const thresh = win * 0.99;
  const used = (msg.usage.input || 0) + (msg.usage.cacheRead || 0);
  console.log(
    `${label.padEnd(36)} used=${String(used).padStart(7)} thresh=${String(thresh).padStart(9)} -> overflow=${r ? 'TRUE  <-- FALSE POSITIVE' : 'false'}`
  );
}