#!/usr/bin/env node
import assert from 'node:assert';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });
const setup = () => {
  const events = []; let release; let scheduled;

  const gate = { pushAndVerify: () => new Promise((resolve) => { events.push('push.start'); release = () => { events.push('push.finish'); resolve({ ok: true, tipMatches: true }); }; }) };
  const run = { runId: 'r1', s: { state: 'WAIT_GIT_PUSH', pendingRemoteSync: { stage: 'T1', iteration: 1, head: 'a'.repeat(40) }, retry: { pushAttempts: 1 } }, manifest: { branch: 'main' }, remoteSyncResult: (r) => { events.push('remote.result'); return r; }, stop: () => { events.push('run.stop'); run.s.state = 'STOPPED'; return {}; }, resume: () => { events.push('run.resume'); return { resumed: true }; } };
  const executor = { retry: async () => { events.push('retry.enter'); await gate.pushAndVerify(); run.remoteSyncResult({ ok: true, tipMatches: true }); }, stop: () => events.push('executor.stop') };
  const controller = { store: { listRuns: () => [], loadRun: () => null } };
  const lifecycle = new AuditLifecycle({ controller, driver: {}, retryScheduler: { cancel: () => events.push('retry.cancel'), schedule: (_id, fn) => { scheduled = fn; return { scheduled: true }; } } });
  lifecycle.liveRuns.set('r1', run); lifecycle.executors.set('r1', executor);
  return { lifecycle, events, release: () => release?.(), fire: () => scheduled?.('r1') };
};
await ok('in-flight retry serializes before stop; stop cannot overlap push', async () => {
  const x = setup(); await x.lifecycle.control('r1', (run) => run.resume(), 'resume'); const retry = x.fire();
  await new Promise((r) => setImmediate(r));
  const stop = x.lifecycle.control('r1', (run) => run.stop(), 'stop');
  assert.deepEqual(x.events, ['run.resume', 'retry.cancel', 'retry.enter', 'push.start']);
  x.release(); await retry; await stop;
  assert.deepEqual(x.events, ['run.resume', 'retry.cancel', 'retry.enter', 'push.start', 'push.finish', 'remote.result', 'retry.cancel', 'executor.stop', 'run.stop']);
});
await ok('stop first detaches executor; later retry is ignored and never pushes', async () => {
  const x = setup(); await x.lifecycle.control('r1', (run) => run.stop(), 'stop');
  const result = await x.lifecycle.retry('r1'); assert.deepEqual(result, { ignored: true });
  assert.deepEqual(x.events, ['retry.cancel', 'executor.stop', 'run.stop', 'retry.cancel']);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
