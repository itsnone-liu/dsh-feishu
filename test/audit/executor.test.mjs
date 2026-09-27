#!/usr/bin/env node
/** A3 executor: strict marker, remote gate, and same-session feedback. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRemoteGate } from '../../src/audit/git-gate.js';
import { AuditStore } from '../../src/audit/store.js';
import { AuditRun } from '../../src/audit/state-machine.js';
import { AuditExecutor } from '../../src/audit/executor.js';
import { buildExecutorMarkerText } from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`PASS ${name}`); }).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });
const manifest = (runId) => ({ schemaVersion: 1, runId, hostId: 'h1', chatId: 'chat-a', dshSessionId: 's-a', cwd: '/w', repo: 'r', branch: 'main', stages: ['T1', 'T2'], currentStage: 'T1', stopAfter: 'T2', startingCommit: 'base', stageBaseCommit: 'base', goal: 'g', approvedPlan: 'p', auditedCommits: [], ignorePaths: [], createdAt: 1, updatedAt: 1 });
const runFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-exec-')); const store = new AuditStore(root);
  const run = AuditRun.create(store, manifest('r1'), { now: () => 10 });
  const submitted = []; const agent = { id: 's-a', status: 'idle' }; const driver = { submit: (_a, text) => { submitted.push(text); return 'followup'; } };
  return { store, run, agent, driver, submitted };
};

await ok('start submits exactly one executor prompt to bound session', async () => {
  const f = runFixture(); const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  const r = await ex.start({ run: f.run, agent: f.agent, gitGate: {} });
  assert.equal(r.sessionId, 's-a'); assert.equal(f.submitted.length, 1);
});

await ok('READY marker + verified gate enters AUDITING, then REVISE feedback uses same agent', async () => {
  const f = runFixture();
  const gate = { isAncestor: async () => true, pushAndVerify: async ({ head }) => ({ ok: true, tipMatches: true, tip: head }) };
  const ex = new AuditExecutor({ driver: f.driver, gitGate: gate });
  await ex.start({ run: f.run, agent: f.agent });
  const text = buildExecutorMarkerText({ runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, head: 'a'.repeat(40) });
  const result = await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  assert.equal(result.auditing, true); assert.equal(f.run.s.state, 'AUDITING');
  const injected = ex.feedback('r1', 'REVISE feedback: fix the current stage and output READY_FOR_AUDIT again.');
  assert.equal(injected.sessionId, 's-a'); assert.equal(f.submitted.length, 2);
});

await ok('completed turn without marker retries once, then pauses on second completed turn', async () => {
  const f = runFixture(); const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  await ex.start({ run: f.run, agent: f.agent });
  await ex.onEvent({ id: 's-a' }, { type: 'turn/start', data: { turn: 1 } });
  const first = await ex.onEvent({ id: 's-a' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(first.retry, true); assert.equal(f.run.s.state, 'EXECUTING');
  await ex.onEvent({ id: 's-a' }, { type: 'turn/start', data: { turn: 2 } });
  const second = await ex.onEvent({ id: 's-a' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  assert.equal(second.failed, true); assert.equal(f.run.s.state, 'PAUSED_NEEDS_USER');
});

await ok('malformed assistant prose does not become READY', async () => {
  const f = runFixture(); const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  const r = await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成了，下一阶段开始。' }] } } });
  assert.deepEqual(r, { ignored: true }); assert.equal(f.run.s.state, 'EXECUTING');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
