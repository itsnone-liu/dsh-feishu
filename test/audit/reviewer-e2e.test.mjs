#!/usr/bin/env node
/** A4.2 reviewer lifecycle E2E: real git + lifecycle + FakeWebAuditRunner seam. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { GitRemoteGate } from '../../src/audit/git-gate.js';
import { FakeWebAuditRunner } from '../../src/audit/fake-web-audit-runner.js';
import { buildExecutorMarkerText, buildVerdictText } from '../../src/audit/protocol.js';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const f = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rv-')); const work = path.join(root, 'work'); const bare = path.join(root, 'origin.git'); fs.mkdirSync(work); fs.mkdirSync(bare); git(work, 'init', '-b', 'main'); git(bare, 'init', '--bare'); git(work, 'config', 'user.email', 'a@b.invalid'); git(work, 'config', 'user.name', 'A'); fs.writeFileSync(path.join(work, 'README'), 'base'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base'); git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-u', 'origin', 'main'); return { root, work, bare }; };
let pass = 0, fail = 0;
const ok = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });
const mk = (x, verdictScript) => {
  let clock = 1000;
  const store = new AuditStore(path.join(x.root, 'audit'));
  const controller = new AuditController({ store, hostId: 'h1', cwd: x.work, stages: ['T1', 'T2'], branch: 'main', now: () => ++clock });
  const prompts = []; const agent = { id: 'session-fixed', status: 'idle' };
  const driver = { ensure: async (_b, o) => { assert.equal(o.allowCreate, false); return agent; }, submit: (_a, t) => prompts.push(t) };
  const packet = { goal: 'frozen goal', approvedPlan: 'frozen plan', stages: ['T1', 'T2'], stageRequirements: { T1: 'r1', T2: 'r2' }, taskPacketHash: 'ph' };
  const lifecycle = new AuditLifecycle({ controller, driver, bindings: new Map([['chat-a', { sessionId: 'session-fixed', cwd: x.work }]]), gitGateFactory: (o) => new GitRemoteGate({ ...o, allowNonGithubRemote: true }), taskPacketLoader: () => packet });
  return { controller, lifecycle, packet, agent, prompts, commit: (file, text, msg) => { fs.writeFileSync(path.join(x.work, file), text); git(x.work, 'add', file); git(x.work, 'commit', '-m', msg); return git(x.work, 'rev-parse', 'HEAD'); }, reviewer: (script) => new FakeWebAuditRunner({ script }) };
};
const mark = (run, head, stage, iter) => lifecycle_events => lifecycle_events;
const send = async (lifecycle, agent, run, head, stage, iter, turn) => {
  await lifecycle.onEvent({ id: agent.id }, { type: 'turn/start', data: { turn } });
  await lifecycle.onEvent({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage, iteration: iter, head }) }] } } });
  await lifecycle.onEvent({ id: agent.id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
};
const vtext = (state, run, stage, iter) => buildVerdictText({ state, runId: run.runId, hostId: 'h1', stage, iteration: iter });

await ok('reviewer seam: REVISE same-session then APPROVE auto T2 then stopAfter STOPPED_TARGET_REACHED', async () => {
  const x = f(); const m = mk(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  const a = m.commit('a.txt', 'A', 'A');
  await send(m.lifecycle, m.agent, run, a, 'T1', 1, 1);
  assert.equal(run.s.state, 'AUDITING');
  const r1 = m.reviewer([{ text: vtext('REVISE', run, 'T1', 1) }]);
  await m.lifecycle.review(run.runId, r1);
  assert.equal(run.s.state, 'EXECUTING'); assert.equal(run.s.iteration, 2); assert.equal(m.prompts.length, 2);
  const p1 = r1.calls[0]; assert.equal(p1.runId, run.runId); assert.equal(p1.hostId, 'h1'); assert.equal(p1.stage, 'T1'); assert.equal(p1.iteration, 1); assert.equal(p1.targetCommit, a); assert.equal(p1.stageRequirement, 'r1');
  const b = m.commit('b.txt', 'B', 'B');
  await send(m.lifecycle, m.agent, run, b, 'T1', 2, 2);
  assert.equal(run.s.state, 'AUDITING');
  const r2 = m.reviewer([{ text: vtext('APPROVE', run, 'T1', 2) }]);
  await m.lifecycle.review(run.runId, r2);
  const p2 = r2.calls[0]; assert.equal(p2.stage, 'T1'); assert.equal(p2.iteration, 2); assert.equal(p2.targetCommit, b); assert.equal(p2.baseCommit, started.git.head); assert.equal(p2.stageRequirement, 'r1');
  assert.equal(run.s.state, 'EXECUTING'); assert.equal(run.s.currentStage, 'T2'); assert.equal(run.s.stageBaseCommit, b); assert.equal(m.prompts.length, 3);
  const c = m.commit('c.txt', 'C', 'C');
  await send(m.lifecycle, m.agent, run, c, 'T2', 1, 3);
  const r3 = m.reviewer([{ text: vtext('APPROVE', run, 'T2', 1) }]);
  await m.lifecycle.review(run.runId, r3);
  const p3 = r3.calls[0]; assert.equal(p3.stage, 'T2'); assert.equal(p3.iteration, 1); assert.equal(p3.targetCommit, c); assert.equal(p3.baseCommit, b); assert.equal(p3.stageRequirement, 'r2');
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED'); assert.equal(m.prompts.length, 3);
  assert.equal(git(x.work, 'ls-remote', x.bare, 'refs/heads/main').split(/\s+/)[0], c);
});

await ok('malformed → retry → valid continues; malformed×2 → PAUSED_NEEDS_USER; exhausted stays AUDITING', async () => {
  const x = f(); const m = mk(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  const a = m.commit('a.txt', 'A', 'A');
  await send(m.lifecycle, m.agent, run, a, 'T1', 1, 1);
  const retry = m.reviewer([{ text: 'looks fine, ship it' }, { text: vtext('APPROVE', run, 'T1', 1) }]);
  await m.lifecycle.review(run.runId, retry);
  assert.equal(retry.calls.length, 2); assert.equal(run.s.state, 'EXECUTING'); assert.equal(run.s.currentStage, 'T2');

  const b = m.commit('b.txt', 'B', 'B');
  await send(m.lifecycle, m.agent, run, b, 'T2', 1, 2);
  const twice = m.reviewer([{ text: 'nope' }, { text: 'still nope' }]);
  await m.lifecycle.review(run.runId, twice);
  assert.equal(twice.calls.length, 2); assert.equal(run.s.state, 'PAUSED_NEEDS_USER'); assert.equal(run.s.cause, 'VERDICT_PARSE_FAILED');

  const fresh = f(); const m2 = mk(fresh);
  const s2 = await m2.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' });
  const a2 = m2.commit('a.txt', 'A', 'A');
  await send(m2.lifecycle, m2.agent, s2.run, a2, 'T1', 1, 1);
  const empty = m2.reviewer([]);
  await assert.rejects(() => m2.lifecycle.review(s2.run.runId, empty), (e) => e.code === 'AUDIT_REVIEWER_SCRIPT_EXHAUSTED');
  assert.equal(s2.run.s.state, 'AUDITING'); assert.equal(empty.calls.length, 1);
});

await ok('review is rejected before any reviewer call outside AUDITING', async () => {
  const x = f(); const m = mk(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  const r = m.reviewer([{ text: vtext('APPROVE', run, 'T1', 1) }]);
  await assert.rejects(() => m.lifecycle.review(run.runId, r), (e) => e.code === 'AUDIT_REVIEW_NOT_READY');
  assert.equal(r.calls.length, 0);
  await m.lifecycle.control(run.runId, (rn) => rn.pause(), 'pause');
  await assert.rejects(() => m.lifecycle.review(run.runId, r), (e) => e.code === 'AUDIT_REVIEW_NOT_READY');
  assert.equal(r.calls.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
