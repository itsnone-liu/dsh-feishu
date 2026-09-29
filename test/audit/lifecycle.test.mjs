#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log(`PASS ${name}`);
}).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-life-'));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  git(work, 'init', '-b', 'main'); git(work, 'config', 'user.email', 'a@b.invalid'); git(work, 'config', 'user.name', 'A');
  fs.writeFileSync(path.join(work, 'README'), 'base'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  return { root, work, head: git(work, 'rev-parse', 'HEAD') };
};
const ctrl = (root, work) => new AuditController({
  store: new AuditStore(path.join(root, 'audit-store')), hostId: 'h1', cwd: work,
  repo: 'unused', branch: 'main', stages: ['T1', 'T2'], now: () => Date.now(),
});

await ok('start requires an existing owner session and never forks', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const bindings = new Map([['chat-a', { sessionId: 's-a', cwd: f.work }]]);
  const calls = [];
  const driver = { ensure: async (binding, opts) => { calls.push({ binding, opts }); return { id: 's-a', status: 'idle' }; }, submit() {} };
  const gate = { inspect: async () => ({ cwd: f.work, repo: 'real-origin', branch: 'main', head: f.head }), pushAndVerify: async () => ({ ok: true, tipMatches: true }) };
  const life = new AuditLifecycle({ controller: c, driver, bindings, gitGateFactory: () => gate, taskPacketLoader: () => ({ goal: 'g', approvedPlan: 'p', stages: ['T1', 'T2'], stageRequirements: { T1: 'r1', T2: 'r2' }, taskPacketHash: 'hash' }), executorFactory: () => ({ start: async () => ({ started: true }) }) });
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  assert.equal(r.run.manifest.dshSessionId, 's-a');
  assert.equal(r.run.manifest.chatId, 'chat-a');
  assert.equal(r.run.manifest.startingCommit, f.head);
  assert.equal(calls[0].opts.allowCreate, false);
});

await ok('busy bound session is rejected, not forked', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const bindings = new Map([['chat-a', { sessionId: 's-a', cwd: f.work }]]);
  const driver = { ensure: async () => ({ id: 's-a', status: 'running' }) };
  const life = new AuditLifecycle({ controller: c, driver, bindings, gitGateFactory: () => ({ inspect: async () => ({}) }) });
  await assert.rejects(() => life.start({ chatId: 'chat-a', stopAfter: 'T1' }), (e) => e.code === 'AUDIT_SESSION_OCCUPIED');
});

await ok('missing binding is rejected before git/session side effects', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  let inspected = false;
  const life = new AuditLifecycle({ controller: c, driver: {}, bindings: new Map(), gitGateFactory: () => { inspected = true; return {}; } });
  await assert.rejects(() => life.start({ chatId: 'chat-missing', stopAfter: 'T1' }), (e) => e.code === 'AUDIT_SESSION_REQUIRED');
  assert.equal(inspected, false);
});

await ok('resume requires persisted dshSessionId to match owner binding', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const bindings = new Map([['chat-a', { sessionId: 's-a', cwd: f.work }]]);
  const driver = { ensure: async () => ({ id: 's-a', status: 'idle' }) };
  const gate = { inspect: async () => ({ cwd: f.work, repo: 'real-origin', branch: 'main', head: f.head }) };
  const life = new AuditLifecycle({ controller: c, driver, bindings, gitGateFactory: () => gate, taskPacketLoader: () => ({ goal: 'g', approvedPlan: 'p', stages: ['T1', 'T2'], stageRequirements: {}, taskPacketHash: 'hash' }), executorFactory: () => ({ start: async () => ({}) }) });
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T1' });
  const resumed = await life.resume(r.run.runId);
  assert.equal(resumed.agent.id, 's-a');
});

await ok('MARKER_PARSE_FAILED human resume replays the current stage prompt', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const bindings = new Map([['chat-a', { sessionId: 's-a', cwd: f.work }]]);
  const prompts = [];
  const driver = { ensure: async () => ({ id: 's-a', status: 'idle' }), submit: (_agent, prompt) => prompts.push(prompt) };
  const gate = { inspect: async () => ({ cwd: f.work, repo: 'real-origin', branch: 'main', head: f.head }) };
  const executorFactory = (opts) => new (class {
    async start({ run, agent, gitGate, sendPrompt = true }) { this.run = run; this.agent = agent; this.gitGate = gitGate; if (sendPrompt) opts.driver.submit(agent, 'initial'); }
    startStage() { opts.driver.submit(this.agent, `replayed:${this.run.s.currentStage}`); }
  })();
  const life = new AuditLifecycle({ controller: c, driver, bindings, gitGateFactory: () => gate,
    taskPacketLoader: () => ({ goal: 'g', approvedPlan: 'p', stages: ['T1', 'T2'], stageRequirements: {}, taskPacketHash: 'hash' }), executorFactory });
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T1' });
  r.run.markerMissing(); r.run.markerMissing();
  assert.equal(r.run.s.state, 'PAUSED_NEEDS_USER');
  const resumed = await life.resume(r.run.runId, { human: true });
  assert.equal(resumed.run.s.state, 'EXECUTING');
  assert.deepEqual(prompts, ['initial', 'replayed:T1']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
