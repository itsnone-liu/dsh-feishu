#!/usr/bin/env node
import assert from 'node:assert';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });
const make = () => {
  const events = [];
  const run = { runId: 'r1', s: { state: 'EXECUTING', pendingRemoteSync: null, retry: { pushAttempts: 0 } }, pause() { events.push('run.pause'); return { paused: true }; }, stop() { events.push('run.stop'); this.s.state = 'STOPPED'; return { stopped: true }; } };
  const controller = { store: { listRuns: () => [], loadRun: () => null }, activeRun: () => ({ id: 'r1', state: 'EXECUTING', chatId: 'a' }), now: Date.now };
  const retry = { cancel: () => events.push('retry.cancel'), schedule() {} };
  const executor = { cancel: () => events.push('executor.cancel'), stop: () => events.push('executor.stop') };
  const lifecycle = new AuditLifecycle({ controller, driver: {}, retryScheduler: retry });
  lifecycle.liveRuns.set('r1', run); lifecycle.executors.set('r1', executor);
  return { lifecycle, run, events };
};
await ok('pause ordering is cancel → executor.cancel → run.pause', async () => { const x = make(); await x.lifecycle.control('r1', (r) => r.pause(), 'pause'); assert.deepEqual(x.events, ['retry.cancel', 'executor.cancel', 'run.pause']); });
await ok('stop ordering is cancel → executor.cancel → executor.stop → run.stop', async () => { const x = make(); await x.lifecycle.control('r1', (r) => r.stop(), 'stop'); assert.deepEqual(x.events, ['retry.cancel', 'executor.cancel', 'executor.stop', 'run.stop']); });
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
