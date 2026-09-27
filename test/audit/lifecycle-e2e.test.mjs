#!/usr/bin/env node
/** A3.1 full chain: real git remote + lifecycle/executor + fake reviewer. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { GitRemoteGate } from '../../src/audit/git-gate.js';
import { buildExecutorMarkerText, parseAuditorVerdict } from '../../src/audit/protocol.js';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const f = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-e2e-')); const work = path.join(root, 'work'); const bare = path.join(root, 'origin.git'); fs.mkdirSync(work); fs.mkdirSync(bare); git(work, 'init', '-b', 'main'); git(bare, 'init', '--bare'); git(work, 'config', 'user.email', 'a@b.invalid'); git(work, 'config', 'user.name', 'A'); fs.writeFileSync(path.join(work, 'README'), 'base'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base'); git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-u', 'origin', 'main'); return { root, work, bare }; };
let pass = 0, fail = 0;
const ok = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });

await ok('T1 REVISE→T1 new commit→APPROVE automatically starts T2 on same session', async () => {
  const x = f(); let clock = 1000; const store = new AuditStore(path.join(x.root, 'audit')); const controller = new AuditController({ store, hostId: 'h1', cwd: x.work, stages: ['T1', 'T2'], branch: 'main', now: () => ++clock });
  const binding = new Map([['chat-a', { sessionId: 'session-fixed', cwd: x.work }]]); const prompts = [];
  const agent = { id: 'session-fixed', status: 'idle' }; const driver = { ensure: async (_b, opts) => { assert.equal(opts.allowCreate, false); return agent; }, submit: (_a, text) => { prompts.push(text); } };
  const packet = { goal: 'frozen goal', approvedPlan: 'frozen plan', stages: ['T1', 'T2'], stageRequirements: { T1: 'r1', T2: 'r2' }, taskPacketHash: 'packet-hash' };
  const lifecycle = new AuditLifecycle({ controller, driver, bindings: binding, gitGateFactory: (opts) => new GitRemoteGate({ ...opts, allowNonGithubRemote: true }), taskPacketLoader: () => packet });
  const started = await lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run; const gate = new GitRemoteGate({ cwd: x.work });
  const commit = (file, text, msg) => { fs.writeFileSync(path.join(x.work, file), text); git(x.work, 'add', file); git(x.work, 'commit', '-m', msg); return git(x.work, 'rev-parse', 'HEAD'); };
  const a = commit('a.txt', 'A', 'A');
  await lifecycle.onEvent({ id: agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await lifecycle.onEvent({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
  await lifecycle.onEvent({ id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(run.s.state, 'AUDITING'); assert.deepEqual(run.manifest.auditedCommits, [a]);
  const rev = parseAuditorVerdict(`[DSH-AUDIT]\nSTATE: REVISE\nRUN_ID: ${run.runId}\nHOST_ID: h1\nSTAGE: T1\nITERATION: 1\nREASON:\nfix\n`);
  await lifecycle.applyVerdict(run.runId, rev); assert.equal(run.s.state, 'EXECUTING');
  const b = commit('b.txt', 'B', 'B');
  await lifecycle.onEvent({ id: agent.id }, { type: 'turn/start', data: { turn: 2 } });
  await lifecycle.onEvent({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 2, head: b }) }] } } });
  assert.equal(run.s.state, 'AUDITING'); assert.deepEqual(run.manifest.auditedCommits, [a, b]);
  const approve = parseAuditorVerdict(`[DSH-AUDIT]\nSTATE: APPROVE\nRUN_ID: ${run.runId}\nHOST_ID: h1\nSTAGE: T1\nITERATION: 2\n`);
  await lifecycle.applyVerdict(run.runId, approve);
  assert.equal(run.s.state, 'EXECUTING'); assert.equal(run.s.currentStage, 'T2'); assert.equal(run.s.stageBaseCommit, b); assert.equal(prompts.length, 3);
  assert.equal(git(x.work, 'ls-remote', x.bare, 'refs/heads/main').split(/\s+/)[0], b);
  // Restart reattachment: same persisted run/session; no duplicate stage prompt.
  const life2 = new AuditLifecycle({ controller, driver, bindings: binding, taskPacketLoader: () => packet });
  const restored = await life2.resume(run.runId); assert.equal(restored.run.runId, run.runId); assert.equal(restored.run.manifest.dshSessionId, 'session-fixed'); assert.equal(restored.run.s.currentStage, 'T2'); assert.equal(prompts.length, 3);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
