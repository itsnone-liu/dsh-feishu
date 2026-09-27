#!/usr/bin/env node
import assert from 'node:assert';
import { AuditRetryScheduler } from '../../src/audit/retry-scheduler.js';
let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });
await ok('injected timer schedules 30/60/120 style delays and cancel is idempotent', () => {
  const timers = []; const scheduler = new AuditRetryScheduler({ delays: [30, 60, 120], setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  assert.equal(scheduler.schedule('r1').delayMs, 30); assert.equal(timers[0].ms, 30); scheduler.cancel('r1'); scheduler.cancel('r1');
  assert.equal(scheduler.schedule('r1', undefined, 2).delayMs, 60); assert.equal(timers[1].ms, 60);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
