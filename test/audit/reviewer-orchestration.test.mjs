#!/usr/bin/env node
/** A4.3 automatic reviewer orchestration: turn boundary, dedupe, control races, restart. */
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
const f = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-orch-')); const work = path.join(root, 'work'); const bare = path.join(root, 'origin.git'); fs.mkdirSync(work); fs.mkdirSync(bare); git(work, 'init', '-b', 'main'); git(bare, 'init', '--bare'); git(work, 'config', 'user.email', 'a@b.invalid'); git(work, 'config', 'user.name', 'A'); fs.writeFileSync(path.join(work, 'README'), 'base'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base'); git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-u', 'origin', 'main'); return { root, work, bare }; };
let pass = 0, fail = 0;
const ok = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });
const vt = (state, run, stage, iter) => buildVerdictText({ state, runId: run.runId, hostId: 'h1', stage, iteration: iter });
const setup = (x, opts = {}) => {
  const script = [...(opts.script ?? [])];
  let clock = 1000;
  const store = new AuditStore(path.join(x.root, 'audit'));
  const controller = new AuditController({ store, hostId: 'h1', cwd: x.work, stages: ['T1', 'T2'], branch: 'main', now: () => ++clock });
  const prompts = []; const agent = { id: 'session-fixed', status: 'idle' };
  const driver = { ensure: async (_b, o) => { assert.equal(o.allowCreate, false); return agent; }, submit: (_a, t) => prompts.push(t) };
  const packet = { goal: 'g', approvedPlan: 'p', stages: ['T1', 'T2'], stageRequirements: { T1: 'r1', T2: 'r2' }, taskPacketHash: 'ph' };
  const reviewer = new FakeWebAuditRunner({ script });
  reviewer.script = script;
  const lifecycle = new AuditLifecycle({ controller, driver, bindings: new Map([['chat-a', { sessionId: 'session-fixed', cwd: x.work }]]), gitGateFactory: (o) => new GitRemoteGate({ ...o, allowNonGithubRemote: true }), taskPacketLoader: () => packet });
  lifecycle.reviewer = reviewer;
  const commit = (file, text, msg) => { fs.writeFileSync(path.join(x.work, file), text); git(x.work, 'add', file); git(x.work, 'commit', '-m', msg); return git(x.work, 'rev-parse', 'HEAD'); };
  const send = async (head, stage, iter, turn) => {
    await lifecycle.onEvent({ id: agent.id }, { type: 'turn/start', data: { turn } });
    await lifecycle.onEvent({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: lifecycle.liveRuns.keys().next().value, hostId: 'h1', stage, iteration: iter, head }) }] } } });
    await lifecycle.onEvent({ id: agent.id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  };
  return { controller, lifecycle, reviewer, prompts, commit, send, agent, packet, store };
};

await ok('auto happy path: no manual review() from start to TARGET_REACHED', async () => {
  const x = f(); const m = setup(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  m.reviewer.script.push({ text: vt('REVISE', run, 'T1', 1) });
  const a = m.commit('a.txt', 'A', 'A'); await m.send(a, 'T1', 1, 1);
  assert.equal(run.s.state, 'EXECUTING'); assert.equal(run.s.iteration, 2); assert.equal(m.reviewer.calls.length, 1);
  m.reviewer.script.push({ text: vt('APPROVE', run, 'T1', 2) });
  const b = m.commit('b.txt', 'B', 'B'); await m.send(b, 'T1', 2, 2);
  assert.equal(run.s.currentStage, 'T2'); assert.equal(m.reviewer.calls.length, 2);
  m.reviewer.script.push({ text: vt('APPROVE', run, 'T2', 1) });
  const c = m.commit('c.txt', 'C', 'C'); await m.send(c, 'T2', 1, 3);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED'); assert.equal(m.reviewer.calls.length, 3);
});

await ok('turn boundary: reviewer starts only after turn/end, duplicate turn/end deduped', async () => {
  const x = f(); const m = setup(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  const a = m.commit('a.txt', 'A', 'A');
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
  assert.equal(m.reviewer.calls.length, 0);
  m.reviewer.script.push({ text: vt('APPROVE', run, 'T1', 1) });
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(m.reviewer.calls.length, 1);
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(m.reviewer.calls.length, 1);
});

await ok('WAIT_GIT_PUSH retry success auto-reviews once', async () => {
  const x = f(); const m = setup(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  // 真实 transient push：远程 gate 暂时离线 → WAIT_GIT_PUSH；随后恢复并 retry 成功 → 自动 review。
  let broken = true;
  const realPush = (o) => new GitRemoteGate({ cwd: x.work, allowNonGithubRemote: true }).pushAndVerify(o);
  m.lifecycle.executors.get(run.runId).runs.get(run.runId).gitGate = {
    isAncestor: async () => true,
    pushAndVerify: async (o) => { if (broken) { const e = new Error('network down'); e.code = 'AUDIT_GIT_COMMAND_FAILED'; throw e; } return realPush(o); },
  };
  const a = m.commit('a.txt', 'A', 'A');
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
  assert.equal(run.s.state, 'WAIT_GIT_PUSH');
  broken = false;
  m.reviewer.script.push({ text: vt('APPROVE', run, 'T1', 1) });
  await m.lifecycle.retry(run.runId);
  assert.equal(m.reviewer.calls.length, 1);
  assert.equal(run.s.currentStage, 'T2');
});
await ok('malformed retry auto path emits exactly one VERDICT_RETRY then proceeds', async () => {
  const x = f(); const m = setup(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  m.reviewer.script.push({ text: 'garbage' }, { text: vt('APPROVE', run, 'T1', 1) });
  const a = m.commit('a.txt', 'A', 'A'); await m.send(a, 'T1', 1, 1);
  assert.equal(m.reviewer.calls.length, 2); assert.equal(run.s.currentStage, 'T2');
  const events = m.store.loadRun(run.runId).events;
  const retries = events.filter((e) => e.event === 'VERDICT_RETRY');
  assert.equal(retries.length, 1);
});

await ok('reviewer blocked → stop queues behind; stop first → reviewer never called', async () => {
  const x = f(); const m = setup(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  let release; const savedReview = m.reviewer.review.bind(m.reviewer);
  m.reviewer.review = (packet) => new Promise((res, rej) => { m.reviewer.calls.push(packet); release = () => savedReview(packet).then(res, rej); });
  const a = m.commit('a.txt', 'A', 'A');
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
  m.reviewer.script.push({ text: vt('APPROVE', run, 'T1', 1) });
  const inFlight = m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(m.reviewer.calls.length, 1);
  const stopped = m.lifecycle.control(run.runId, (rn) => rn.stop(), 'stop');
  await new Promise((r) => setImmediate(r));
  assert.equal(run.s.state, 'AUDITING');
  release(); await inFlight; await stopped;
  assert.equal(run.s.state, 'STOPPED');

  const x2 = f(); const m2 = setup(x2);
  const s2 = await m2.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await m2.lifecycle.control(s2.run.runId, (rn) => rn.stop(), 'stop');
  const r2 = await m2.lifecycle.review(s2.run.runId, m2.reviewer).catch((e) => e);
  assert.equal(r2.code, 'AUDIT_EXECUTOR_NOT_FOUND');
  assert.equal(m2.reviewer.calls.length, 0);
});

await ok('restart while AUDITING auto-reviews exactly once; NEED_USER resume allows re-review', async () => {
  const x = f(); const m = setup(x);
  const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' }); const run = started.run;
  // 先停在 AUDITING（reviewer 阻塞不返回），模拟 crash 前状态已持久化为 AUDITING。
  let release; const savedReview = m.reviewer.review.bind(m.reviewer);
  m.reviewer.review = (packet) => new Promise((res, rej) => { m.reviewer.calls.push(packet); release = () => savedReview(packet).then(res, rej); });
  const a = m.commit('a.txt', 'A', 'A');
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
  const pendingTurn = m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }).catch(() => undefined);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(m.reviewer.calls.length, 1);
  void pendingTurn; void release; // 保持 pending，模拟审核中崩溃

  // 新 lifecycle 实例重启恢复：AUDITING 持久态 → 自动恰调用一次 reviewer。
  let clock2 = 5000;
  const store2 = new AuditStore(path.join(x.root, 'audit'));
  const controller2 = new AuditController({ store: store2, hostId: 'h1', cwd: x.work, stages: ['T1', 'T2'], branch: 'main', now: () => ++clock2 });
  const prompts2 = []; const agent2 = { id: 'session-fixed', status: 'idle' };
  const driver2 = { ensure: async () => agent2, submit: (_a, t) => prompts2.push(t) };
  const reviewer2 = new FakeWebAuditRunner({ script: [] });
  let resumed = 0;
  reviewer2.review = async (packet) => { resumed += 1; return { state: 'NEED_USER', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration, question: ['q'] }; };
  const life2 = new AuditLifecycle({ controller: controller2, driver: driver2, bindings: new Map([['chat-a', { sessionId: 'session-fixed', cwd: x.work }]]), gitGateFactory: (o) => new GitRemoteGate({ ...o, allowNonGithubRemote: true }), taskPacketLoader: () => m.packet });
  life2.reviewer = reviewer2;
  await life2.resume(run.runId);
  assert.equal(resumed, 1); // 重启后自动触发恰一次（NEED_USER → PAUSED_NEEDS_USER）

  // 人工恢复（NEED_USER 同轮）允许再次审核：reviewRounds 清除后同轮重审。
  const r2 = life2.liveRuns.get(run.runId);
  assert.equal(r2.s.state, 'PAUSED_NEEDS_USER');
  reviewer2.review = async (packet) => { resumed += 1; return { state: 'APPROVE', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration }; };
  await life2.control(run.runId, (rn) => rn.resumeFromHuman({}), 'resume');
  assert.equal(resumed, 2);
  assert.equal(r2.s.currentStage, 'T2');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
