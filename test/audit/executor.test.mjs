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

await ok('A5.4 stage prompt carries exact marker template with real identity values', async () => {
  const f = runFixture(); const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  await ex.start({ run: f.run, agent: f.agent, gitGate: {} });
  const p = f.submitted[0];
  assert.ok(p.includes('[DSH-AUDIT]'), 'marker tag must be in prompt');
  assert.ok(p.includes('RUN_ID: r1'));
  assert.ok(p.includes('HOST_ID: h1'), 'HOST_ID value must be explicit (fail-closed identity)');
  assert.ok(p.includes('STAGE: T1'));
  assert.ok(p.includes('ITERATION: 1'));
  assert.ok(p.includes('STATE: READY_FOR_AUDIT'));
  assert.ok(p.includes('HEAD:'));
  // 模板字段顺序与 buildExecutorMarkerText 双向一致：RUN_ID 在 HOST_ID 前，STAGE 在 ITERATION 前
  assert.ok(p.indexOf('RUN_ID: r1') < p.indexOf('HOST_ID: h1'));
  assert.ok(p.indexOf('STAGE: T1') < p.indexOf('ITERATION: 1'));
});

await ok('A5.4 stage prompt carries the frozen stage requirements text', async () => {
  const f = runFixture();
  // manifest fixture 不带 stageRequirements —— 用带需求的 manifest 重建 run
  const m = manifest('r9'); m.stageRequirements = { T1: 'REQ-T1-ALPHA: 必须新增模块 X 并覆盖边界。', T2: 'REQ-T2' };
  const run = AuditRun.create(f.store, m, { now: () => 10 });
  const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  await ex.start({ run, agent: f.agent, gitGate: {} });
  assert.ok(f.submitted[0].includes('REQ-T1-ALPHA'), 'current-stage requirements must be inlined');
  assert.ok(!f.submitted[0].includes('REQ-T2'), 'other stages must not leak');
});

await ok('A5.4 REVISE feedback re-carries template with advanced iteration; startStage with next stage', async () => {
  const f = runFixture();
  const gate = { isAncestor: async () => true, pushAndVerify: async ({ head }) => ({ ok: true, tipMatches: true, tip: head }) };
  const ex = new AuditExecutor({ driver: f.driver, gitGate: gate });
  await ex.start({ run: f.run, agent: f.agent });
  const text = buildExecutorMarkerText({ runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, head: 'a'.repeat(40) });
  await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  ex.applyVerdict('r1', { state: 'REVISE', runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, reason: ['missing test'] });
  const revisePrompt = f.submitted.at(-1);
  assert.ok(revisePrompt.includes('missing test'), 'REVISE reason reaches executor');
  assert.ok(revisePrompt.includes('ITERATION: 2'), 'feedback template carries the ADVANCED iteration');
  assert.ok(revisePrompt.includes('HOST_ID: h1'));
  // 第二轮：executor 按 iteration 2 重新输出 marker -> 再次 AUDITING
  const text2 = buildExecutorMarkerText({ runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 2, head: 'b'.repeat(40) });
  await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: text2 }] } } });
  assert.equal(f.run.s.state, 'AUDITING');
  ex.applyVerdict('r1', { state: 'APPROVE', runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 2 });
  const stagePrompt = f.submitted.at(-1);
  assert.ok(stagePrompt.includes('STAGE: T2'), 'startStage template carries next stage');
  assert.ok(stagePrompt.includes('ITERATION: 1'), 'new stage restarts at iteration 1');
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

await ok('late completion after NEED_USER pause is stale, not marker-retry', async () => {
  const f = runFixture(); const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  await ex.start({ run: f.run, agent: f.agent });
  f.run.s.state = 'PAUSED_NEEDS_USER'; f.run.s.cause = 'NEED_USER';
  const r = await ex.onEvent({ id: 's-a' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.deepEqual(r, { turnEnded: true, stale: true });
  assert.equal(f.run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(f.submitted.length, 1, 'must not submit a retry into the paused run');
});

await ok('malformed assistant prose does not become READY', async () => {
  const f = runFixture(); const ex = new AuditExecutor({ driver: f.driver, gitGate: {} });
  const r = await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成了，下一阶段开始。' }] } } });
  assert.deepEqual(r, { ignored: true }); assert.equal(f.run.s.state, 'EXECUTING');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

await ok('stale terminal entry never starves a live run on the same session (marker reaches active run)', async () => {
  const dead = runFixture(); const live = runFixture();
  const ex = new AuditExecutor({ driver: dead.driver, gitGate: {} });
  // 残留：终态 run 的 entry 先注册（同一 session id 's-a'）
  await ex.start({ run: dead.run, agent: dead.agent, gitGate: {} });
  dead.run.stop('测试终结'); // → STOPPED（terminal），entry 不清理（旧 bug 场景）
  // 活跃：新 run 同 session 注册在后
  let isAncestor = async () => true;
  const gate = { isAncestor: (c) => isAncestor(c), pushAndVerify: async () => ({ ok: true, head: 'c2', remote: 'origin', branch: 'main' }) };
  await ex.start({ run: live.run, agent: { id: 's-a', status: 'idle' }, gitGate: gate });
  const text = buildExecutorMarkerText({ runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, head: 'c2', summary: '', tests: '' });
  // 修复点1：find 优先非终态 entry → marker 送进 live run，而非撞上终态 run 抛 AUDIT_RUN_FROZEN
  let threw = null;
  try {
    const r = await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
    assert.ok(!r?.ignored, 'active run must consume the marker');
  } catch (e) { threw = e; }
  assert.equal(threw, null, 'stale terminal entry must not leak AUDIT_RUN_FROZEN to caller');
  assert.ok(['AUDIT_REMOTE_READY', 'AUDIT_STARTED', 'AUDITING'].includes(live.run.s.state), `live run must accept the marker, got ${live.run.s.state}`);
  assert.equal(dead.run.s.state, 'STOPPED', 'terminal run must stay untouched');
});

await ok('frozen cleanup: executor self-removes stale entry instead of throwing', async () => {
  const dead = runFixture();
  const ex = new AuditExecutor({ driver: dead.driver, gitGate: {} });
  await ex.start({ run: dead.run, agent: dead.agent, gitGate: {} });
  dead.run.stop('测试终结');
  const text = buildExecutorMarkerText({ runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, head: 'c9', summary: '', tests: '' });
  // 强制走终态 entry（唯一 entry）验证 catch 分支自清理
  const r = await ex.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  assert.ok(r?.ignored, 'frozen entry yields by returning ignored');
  assert.equal(ex.runs.size, 0, 'stale entry must be removed from runs map');
});
