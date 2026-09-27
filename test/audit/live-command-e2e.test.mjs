#!/usr/bin/env node
/** A3.3 live command path: Commands -> async parser -> Controller -> Lifecycle -> same AuditRun. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditRun } from '../../src/audit/state-machine.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { Commands } from '../../src/commands.js';
import { MockTransport } from '../../src/transport/mock.js';
let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });
await ok('live pause/resume/until/stop cards use one live run and preserve result shape', async () => {
  const store = new AuditStore(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-live-cmd-')));
  const controller = new AuditController({ store, hostId: 'h1', cwd: '/w', repo: 'stub://local', branch: 'main', now: () => Date.now() });
  const created = controller.createRun({ stopAfter: 'T2', chatId: 'chat-a' });
  const run = AuditRun.open(store, { now: Date.now })(created.runId);
  const retry = { cancel() {}, schedule() {} };
  const lifecycle = new AuditLifecycle({ controller, driver: { submit() {} }, bindings: new Map(), retryScheduler: retry, executorFactory: () => ({ stop() {} }) });
  lifecycle.liveRuns.set(created.runId, run);
  lifecycle.executors.set(created.runId, { stop() {} });
  controller.lifecycle = lifecycle;
  const transport = new MockTransport({});
  const commands = new Commands({ config: {}, store: null, driver: null, renderer: null, transport, permissionPresets: {}, llm: null, agentPresets: {}, auditController: controller });
  for (const text of ['/audit pause', '/audit resume', '/audit until T2', '/audit stop']) {
    assert.equal(await commands.handle('chat-a', text), true);
  }
  assert.equal(run.s.state, 'STOPPED');
  assert.equal(transport.sent.length, 4);
  assert.match(JSON.stringify(transport.sent[0].card), /PAUSED/);
  assert.match(JSON.stringify(transport.sent[1].card), /EXECUTING/);
  assert.match(JSON.stringify(transport.sent[2].card), /T2/);
  assert.match(JSON.stringify(transport.sent[3].card), /STOPPED/);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
