#!/usr/bin/env node
/**
 * audit/fake-e2e.test.mjs — 离线端到端场景矩阵（FakeExecutor/FakeAuditor，纯 Node）。
 *
 *  G2 身份隔离（双向 mismatch，状态不动）；G10 fake 端到端（完整事件序列断言）；
 *  G11 push gate 场景（transient 链 / rejected / tip diverged）；多 run 并行隔离；
 *  NEED_USER / marker 缺失 / verdict 缺失 / duplicate 投递 全路径。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuditScenario } from '../../src/audit/fake-runner.js';
import { AuditStore } from '../../src/audit/store.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });

const MANIFEST = {
  hostId: 'h1', cwd: '/w', repo: 'https://github.com/x/y.git', branch: 'main',
  stages: ['T1', 'T2'], stopAfter: 'T2', startingCommit: 'base00', goal: 'g', approvedPlan: 'p',
};

let seq = 0;
const newStore = () => {
  seq += 1;
  return new AuditStore(fs.mkdtempSync(path.join(os.tmpdir(), `audit-e2e-${seq}-`)));
};
const scenario = (store, runId, executorScript, auditorScript, opts = {}) => {
  const { manifest, ...rest } = opts;
  return runAuditScenario({
    store,
    manifestInput: { ...MANIFEST, runId, ...(manifest ?? {}) },
    executorScript, auditorScript, ...rest,
  });
};
const eventsOf = (store, runId) => store.loadRun(runId).events.map((e) => e.event);

// ---------- G10 主线 ----------
await ok('happy path: REVISE → fix → APPROVE → next stage → APPROVE @ stopAfter', () => {
  const store = newStore();
  const { run } = scenario(store, 'e1',
    [{ type: 'READY' }, { type: 'READY' }, { type: 'READY' }],
    [{ type: 'REVISE', p0: ['fix A'] }, { type: 'APPROVE' }, { type: 'APPROVE' }]);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  assert.equal(run.s.currentStage, 'T2');
  assert.deepEqual(eventsOf(store, 'e1'), [
    'RUN_STARTED', 'STAGE_STARTED',
    'READY_FOR_AUDIT', 'AUDIT_REMOTE_READY', 'AUDIT_STARTED',
    'AUDIT_REVISE',
    'READY_FOR_AUDIT', 'AUDIT_REMOTE_READY', 'AUDIT_STARTED',
    'AUDIT_APPROVE', 'STAGE_ADVANCED', 'STAGE_STARTED',
    'READY_FOR_AUDIT', 'AUDIT_REMOTE_READY', 'AUDIT_STARTED',
    'AUDIT_APPROVE', 'TARGET_REACHED',
  ]);
  assert.deepEqual(store.loadRun('e1').manifest.auditedCommits, ['fke0001', 'fke0002', 'fke0003']);
});

await ok('REVISE × max → REVISE_LOOP_EXHAUSTED → PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const { run } = scenario(store, 'e2',
    [{ type: 'READY' }, { type: 'READY' }],
    [{ type: 'REVISE' }, { type: 'REVISE' }],
    { maxReviewIterations: 2 });
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'REVISE_LOOP_EXHAUSTED');
  const ev = eventsOf(store, 'e2');
  assert.ok(ev.includes('REVISE_LOOP_EXHAUSTED'));
  assert.ok(ev.indexOf('AUDIT_REVISE') < ev.indexOf('REVISE_LOOP_EXHAUSTED'));
});

await ok('NEED_USER → PAUSED_NEEDS_USER (cause NEED_USER)', () => {
  const store = newStore();
  const { run } = scenario(store, 'e3',
    [{ type: 'READY' }], [{ type: 'NEED_USER', reason: ['conflict'] }]);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'NEED_USER');
});

await ok('history rewrite at READY → HISTORY_REWRITTEN → PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const { run } = scenario(store, 'e4',
    [{ type: 'READY', ancestryOk: false }], [{ type: 'APPROVE' }]);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'HISTORY_REWRITTEN');
  const ev = eventsOf(store, 'e4');
  assert.ok(ev.includes('HISTORY_REWRITTEN'));
  assert.ok(!ev.includes('AUDIT_REMOTE_READY')); // 未过 gate，commit 不进保护链
  assert.deepEqual(store.loadRun('e4').manifest.auditedCommits, []);
});

// ---------- G11 push gate ----------
await ok('push transient×2 then ok → WAIT_GIT_PUSH path with RETRY event', () => {
  const store = newStore();
  const { run } = scenario(store, 'e5',
    [{ type: 'READY', pushAll: [{ ok: false, kind: 'transient' }, { ok: false, kind: 'transient' }, { ok: true, tipMatches: true }] }, { type: 'READY' }],
    [{ type: 'APPROVE' }, { type: 'APPROVE' }]);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  const ev = eventsOf(store, 'e5');
  assert.ok(ev.includes('GIT_PUSH_WAIT'));
  assert.equal(ev.filter((e) => e === 'GIT_PUSH_RETRY').length, 1);
  assert.ok(ev.includes('AUDIT_REMOTE_READY'));
});

await ok('push rejected (non-fast-forward) → ERROR_GIT_REMOTE → PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const { run } = scenario(store, 'e6',
    [{ type: 'READY', push: { ok: false, kind: 'rejected' } }], []);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'ERROR_GIT_REMOTE');
  assert.ok(eventsOf(store, 'e6').includes('ERROR_GIT_REMOTE'));
});

await ok('remote tip diverged → ERROR_GIT_REMOTE → PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const { run } = scenario(store, 'e7',
    [{ type: 'READY', push: { ok: true, tipMatches: false } }], []);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'ERROR_GIT_REMOTE');
});

await ok('push transient × pushMax → fatal → PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const { run } = scenario(store, 'e8',
    [{ type: 'READY', pushAll: [
      { ok: false, kind: 'transient' }, { ok: false, kind: 'transient' },
      { ok: false, kind: 'transient' }, { ok: false, kind: 'transient' },
    ] }], []);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'ERROR_GIT_REMOTE');
});

// ---------- G2 身份隔离 ----------
await ok('executor badRunId → aborted, state unchanged EXECUTING', () => {
  const store = newStore();
  const r = scenario(store, 'e9',
    [{ type: 'READY', badRunId: 'audit_OTHER' }], []);
  assert.equal(r.aborted, 'IDENTITY_MISMATCH');
  assert.equal(r.mismatch.field, 'RUN_ID');
  assert.equal(r.run.s.state, 'EXECUTING');
  assert.equal(r.run.s.pendingRemoteSync, null); // 未留下任何推进依据
});

await ok('auditor badStage → aborted, state unchanged AUDITING', () => {
  const store = newStore();
  const r = scenario(store, 'e10',
    [{ type: 'READY' }], [{ type: 'APPROVE', badStage: 'T9' }]);
  assert.equal(r.aborted, 'IDENTITY_MISMATCH');
  assert.equal(r.mismatch.side, 'auditor');
  assert.equal(r.mismatch.field, 'STAGE');
  assert.equal(r.run.s.state, 'AUDITING');
  assert.ok(!eventsOf(store, 'e10').includes('AUDIT_APPROVE')); // 未产生批准事件
});

await ok('executor badIteration (stale turn) → aborted', () => {
  const store = newStore();
  const r = scenario(store, 'e11',
    [{ type: 'READY', badIteration: 5 }], []);
  assert.equal(r.aborted, 'IDENTITY_MISMATCH');
  assert.equal(r.mismatch.field, 'ITERATION');
});

// ---------- 协议缺失路径 ----------
await ok('MISSING_MARKER ×1 → retry, executor re-asked, run continues', () => {
  const store = newStore();
  const { run } = scenario(store, 'e12',
    [{ type: 'MISSING_MARKER' }, { type: 'READY' }],
    [{ type: 'APPROVE' }],
    { manifest: { stopAfter: 'T1' } });
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  assert.ok(eventsOf(store, 'e12').includes('MARKER_RETRY'));
});

await ok('MISSING_MARKER ×2 → PAUSED_NEEDS_USER (MARKER_PARSE_FAILED)', () => {
  const store = newStore();
  const { run } = scenario(store, 'e13',
    [{ type: 'MISSING_MARKER' }, { type: 'MISSING_MARKER' }], []);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'MARKER_PARSE_FAILED');
});

await ok('MALFORMED verdict ×2 → VERDICT_PARSE_FAILED → PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const { run } = scenario(store, 'e14',
    [{ type: 'READY' }],
    [{ type: 'MALFORMED_OUTPUT' }, { type: 'MALFORMED_OUTPUT' }]);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'VERDICT_PARSE_FAILED');
});

await ok('MALFORMED marker (protocol throw) treated as missing marker', () => {
  const store = newStore();
  const { run } = scenario(store, 'e15',
    [{ type: 'MALFORMED', text: '[DSH-AUDIT]\nSTATE: READY_FOR_AUDIT\nRUN_ID: e15\nSTAGE: T1\nITERATION: one\nHEAD: c1\nSUMMARY:\n- broken iteration format' }, { type: 'READY' }],
    [{ type: 'APPROVE' }],
    { manifest: { stopAfter: 'T1' } });
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  assert.ok(eventsOf(store, 'e15').includes('MARKER_RETRY'));
});

// ---------- G9/G7 重复投递 ----------
await ok('duplicate APPROVE delivery → single STAGE_ADVANCED, no iteration inflation', () => {
  const store = newStore();
  const { run } = scenario(store, 'e16',
    [{ type: 'READY' }, { type: 'READY' }],
    [{ type: 'APPROVE', duplicate: true }, { type: 'APPROVE' }]);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  const ev = eventsOf(store, 'e16');
  assert.equal(ev.filter((e) => e === 'AUDIT_APPROVE').length, 2); // 两个不同 stage 各一次
  assert.equal(ev.filter((e) => e === 'STAGE_ADVANCED').length, 1); // 无双重推进
});

await ok('WEB quota mid-audit → wait → same-round recover → APPROVE', () => {
  const store = newStore();
  const { run } = scenario(store, 'e17',
    [{ type: 'READY' }],
    [{ type: 'WEB_QUOTA' }, { type: 'APPROVE' }],
    { manifest: { stopAfter: 'T1' } });
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  const ev = eventsOf(store, 'e17');
  assert.ok(ev.includes('WEB_QUOTA_WAIT'));
  assert.equal(ev.filter((e) => e === 'AUDIT_STARTED').length, 2); // 首发+同轮重发
});

await ok('DSH quota before marker → wait → recover → READY', () => {
  const store = newStore();
  const { run } = scenario(store, 'e18',
    [{ type: 'DSH_QUOTA' }, { type: 'READY' }],
    [{ type: 'APPROVE' }],
    { manifest: { stopAfter: 'T1' } });
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  assert.ok(eventsOf(store, 'e18').includes('DSH_QUOTA_WAIT'));
});

// ---------- 多 run 隔离 ----------
await ok('two concurrent runs: events and commits never cross', () => {
  const store = newStore();
  const a = scenario(store, 'runA',
    [{ type: 'READY' }, { type: 'READY' }, { type: 'READY' }],
    [{ type: 'REVISE' }, { type: 'APPROVE' }, { type: 'APPROVE' }]);
  const b = scenario(store, 'runB',
    [{ type: 'READY' }],
    [{ type: 'APPROVE', duplicate: true }],
    { manifest: { stopAfter: 'T1' } });
  assert.equal(a.run.s.state, 'STOPPED_TARGET_REACHED');
  assert.equal(b.run.s.state, 'STOPPED_TARGET_REACHED');
  for (const [id, commits] of [['runA', ['fke0001', 'fke0002', 'fke0003']], ['runB', ['fke0001']]]) {
    const m = store.loadRun(id).manifest;
    assert.equal(m.runId, id);
    assert.deepEqual(m.auditedCommits, commits); // fke 序号各 run 独立
    assert.ok(store.loadRun(id).events.every((e) => e.runId === id));
  }
});

await ok('HEAD lineage: every audit round audits a distinct commit (no stale head)', () => {
  const store = newStore();
  scenario(store, 'e19',
    [{ type: 'READY' }, { type: 'READY' }],
    [{ type: 'REVISE' }, { type: 'APPROVE' }],
    { manifest: { stopAfter: 'T1' } });
  const audits = store.loadRun('e19').events.filter((e) => e.event === 'AUDIT_STARTED');
  assert.equal(new Set(audits.map((a) => a.headCommit)).size, audits.length,
    'two AUDIT_STARTED share the same headCommit');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
