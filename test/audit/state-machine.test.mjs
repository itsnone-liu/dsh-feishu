#!/usr/bin/env node
/**
 * audit/state-machine.test.mjs — 状态机转移合法性与冻结语义测试（纯 Node）。
 *
 *  G3 转移合法性（全状态×非法目标矩阵抽查 + 健全性）；
 *  G4 stopAfter 精确语义（APPROVE@stopAfter 才停，三重否定）；
 *  G5 REVISE 计数持久化 + 耗尽 → REVISE_LOOP_EXHAUSTED → PAUSED_NEEDS_USER（禁自动归零）；
 *  G6 历史改写 → HISTORY_REWRITTEN → PAUSED_NEEDS_USER（禁自动重建 baseline）；
 *  /audit until 三条竞态规则；push gate 四分支；marker/verdict 缺失两次路径；
 *  G7 幂等（重复 verdict）；G9 身份 fail-closed；terminal 冻结。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuditRun, STATES, TRANSITIONS, TERMINAL_STATES, canTransition, assertTransition,
} from '../../src/audit/state-machine.js';
import { AuditStore } from '../../src/audit/store.js';
import {
  IllegalTransitionError, FrozenStateException, AuditError,
  ManifestValidationError,
} from '../../src/audit/errors.js';
import { buildExecutorMarkerText, buildVerdictText, parseExecutorMarker, parseAuditorVerdict } from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 4).join('\n  ')}`); });
const throws = (name, fn, code) => ok(name, () => Promise.resolve().then(fn).then(
  () => { throw new Error('expected throw'); },
  (e) => { assert.equal(e.code, code, `code ${e.code} != ${code}`); return true; },
));

const MANIFEST = {
  runId: 'audit_sm', hostId: 'h1', cwd: '/w', repo: 'https://github.com/x/y.git', branch: 'main',
  stages: ['T1', 'T2', 'T3'], stopAfter: 'T2', startingCommit: 'base00', goal: 'g', approvedPlan: 'p',
};

let seq = 0;
const newRun = (opts = {}) => {
  seq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `audit-sm-${seq}-`));
  const store = new AuditStore(dir);
  const input = { ...MANIFEST, ...(opts.manifest ?? {}), runId: `audit_sm_${seq}` };
  const run = AuditRun.create(store, input, { maxReviewIterations: opts.max ?? 8, ...(opts.runOpts ?? {}) });
  return { run, store };
};

/** 驱动到 AUDITING 的便捷函数：READY + push ok。 */
const toAuditing = (run, head = 'c0001') => {
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: run.s.currentStage, iteration: run.s.iteration, head,
  }));
  run.executorReady(marker, {});
  return run.remoteSyncResult({ ok: true, tipMatches: true });
};
const feedVerdict = (run, state, over = {}) => {
  const text = buildVerdictText({
    state, runId: run.runId, hostId: 'h1', stage: run.s.currentStage, iteration: run.s.iteration, ...over,
  });
  return run.auditorVerdict(parseAuditorVerdict(text));
};

// ---------- 表健全性 ----------
await ok('transition table edge count pinned (A1.1 P1: 报告矩阵防漂移锚点)', () => {
  const edges = Object.values(TRANSITIONS).reduce((n, v) => n + v.length, 0);
  console.log(`    TRANSITIONS edge count = ${edges}`);
  // e33c490 后实际边数：STOPPED 出边补齐 + PAUSED 系可 resume 回 WAIT_* 的结果。
  // 表变更时同步更新此数字并重出 Gate Report 覆盖矩阵。
  assert.equal(edges, 50, 'edge count changed — update this pin AND regenerate the gate report matrix');
});

await ok('every state is either terminal or has legal outgoing edges', () => {
  for (const s of STATES) {
    const edges = TRANSITIONS[s];
    if (TERMINAL_STATES.includes(s)) assert.deepEqual(edges, [], `${s} terminal must have no edges`);
    else assert.ok(edges.length > 0, `${s} has no outgoing edges`);
  }
});

await ok('all transition targets are known states', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) assert.ok(STATES.includes(to), `${from} -> unknown ${to}`);
  }
});

await ok('REVISE_LOOP_EXHAUSTED & HISTORY_REWRITTEN: sole edge to PAUSED_NEEDS_USER (no auto-progress)', () => {
  assert.deepEqual(TRANSITIONS.REVISE_LOOP_EXHAUSTED, ['PAUSED_NEEDS_USER']);
  assert.deepEqual(TRANSITIONS.HISTORY_REWRITTEN, ['PAUSED_NEEDS_USER']);
});

await ok('illegal transition samples rejected', () => {
  for (const [from, to] of [
    ['IDLE', 'AUDITING'], ['EXECUTING', 'STOPPED_TARGET_REACHED'], ['EXECUTING', 'NEXT_STAGE'],
    ['AUDITING', 'IDLE'], ['WAIT_DSH_QUOTA', 'AUDITING'],
    ['PAUSED', 'NEXT_STAGE'],
    ['ERROR', 'EXECUTING'], ['STOPPED', 'EXECUTING'], ['STOPPED_TARGET_REACHED', 'EXECUTING'],
    ['REVISE_LOOP_EXHAUSTED', 'EXECUTING'], ['HISTORY_REWRITTEN', 'AUDITING'],
    ['WAIT_GIT_PUSH', 'EXECUTING'], ['WAIT_WEB_QUOTA', 'EXECUTING'],
  ]) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} should be illegal`);
  }
  assert.throws(() => assertTransition('AUDITING', 'IDLE'), IllegalTransitionError);
});

// ---------- G4：stopAfter 精确语义 ----------
await ok('APPROVE @ non-stop stage → NEXT_STAGE fields all advance', () => {
  const { run } = newRun();
  toAuditing(run, 'cT1a');
  const r = feedVerdict(run, 'APPROVE');
  assert.equal(r.advanced, true);
  assert.equal(run.s.currentStage, 'T2');
  assert.equal(run.s.iteration, 1);
  assert.equal(run.s.revisionCount, 0);
  assert.equal(run.s.stageBaseCommit, 'cT1a');
  assert.equal(run.manifest.currentStage, 'T2');
  assert.equal(run.manifest.stageBaseCommit, 'cT1a');
  assert.deepEqual(run.manifest.auditedCommits, ['cT1a']);
});

await ok('APPROVE @ stopAfter → STOPPED_TARGET_REACHED', () => {
  const { run } = newRun({ manifest: { stopAfter: 'T1' } });
  toAuditing(run);
  const r = feedVerdict(run, 'APPROVE');
  assert.equal(r.stopped, true);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  assert.ok(run.s.stoppedAt > 0);
});

await ok('READY_FOR_AUDIT is NOT pass: no gate → verdict rejected', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'cX',
  }));
  run.executorReady(marker, {}); // READY 但未过 push gate
  assert.equal(run.s.state, 'EXECUTING'); // 仍未进入 AUDITING
  assert.throws(() => feedVerdict(run, 'APPROVE'), IllegalTransitionError);
  assert.equal(run.s.state, 'EXECUTING'); // fail closed：状态不变
});

await ok('DSH self-claimed completion is not pass (missing marker path)', () => {
  const { run } = newRun();
  const r = run.markerMissing();
  assert.equal(r.retry, true);
  assert.equal(run.s.state, 'EXECUTING');
});

// ---------- G5：REVISE 计数与耗尽 ----------
await ok('REVISE counter persists across reload', () => {
  const { run, store } = newRun({ max: 3 });
  toAuditing(run, 'c1'); feedVerdict(run, 'REVISE');
  toAuditing(run, 'c2'); feedVerdict(run, 'REVISE');
  assert.equal(run.s.revisionCount, 2);
  assert.equal(run.s.iteration, 3);
  const reopened = AuditRun.open(store)({ runId: run.runId }); // 进程重启
  assert.equal(reopened.s.revisionCount, 2);
  assert.equal(reopened.s.iteration, 3);
});

await ok('REVISE × max → REVISE_LOOP_EXHAUSTED → PAUSED_NEEDS_USER, no auto-reset', () => {
  const { run } = newRun({ max: 2 });
  toAuditing(run, 'c1'); feedVerdict(run, 'REVISE');
  toAuditing(run, 'c2');
  const r = feedVerdict(run, 'REVISE');
  assert.equal(r.exhausted, true);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'REVISE_LOOP_EXHAUSTED');
  assert.equal(run.s.revisionCount, 2); // 计数不归零
  const events = run.store.loadRun(run.runId).events.map((e) => e.event);
  assert.ok(events.includes('REVISE_LOOP_EXHAUSTED'));
});

await ok('exhausted resume without bump keeps count (next REVISE re-exhausts immediately)', () => {
  const { run } = newRun({ max: 1 });
  toAuditing(run, 'c1'); feedVerdict(run, 'REVISE');
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  run.resumeFromHuman({}); // 人工确认但没加轮次
  assert.equal(run.s.state, 'EXECUTING');
  assert.equal(run.s.revisionCount, 1);
  toAuditing(run, 'c2'); feedVerdict(run, 'REVISE');
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER'); // 立即再次耗尽（>=max）
});

await ok('exhausted resume with explicit bump allows more iterations (human decision)', () => {
  const { run } = newRun({ max: 1 });
  toAuditing(run, 'c1'); feedVerdict(run, 'REVISE');
  run.resumeFromHuman({ bumpReviewIterations: 2 });
  assert.equal(run.s.runOptions.maxReviewIterations, 2);
  toAuditing(run, 'c2');
  const r = feedVerdict(run, 'REVISE'); // revisionCount=2 >= max=2 → 仍耗尽（bump 只买到这一轮）
  assert.equal(r.exhausted, true);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
});

await throws('bump must be integer > current max', () => {
  const { run } = newRun({ max: 1 });
  toAuditing(run, 'c1'); feedVerdict(run, 'REVISE');
  return Promise.resolve().then(() => run.resumeFromHuman({ bumpReviewIterations: 1 }));
}, 'AUDIT_ARG_INVALID');

// ---------- G6 / G11：历史改写 ----------
await ok('ancestry broken at READY → HISTORY_REWRITTEN → PAUSED_NEEDS_USER', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'rewritten',
  }));
  const r = run.executorReady(marker, { ancestryOk: false });
  assert.equal(r.historyRewritten, true);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'HISTORY_REWRITTEN');
});

await throws('resume after rewrite without explicit baseline rejected (no auto rebase)', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'rewritten',
  }));
  run.executorReady(marker, { ancestryOk: false });
  return Promise.resolve().then(() => run.resumeFromHuman({}));
}, 'AUDIT_BASELINE_REQUIRED');

await ok('resume with explicit newBaseline updates stageBase, keeps auditedCommits', () => {
  const { run } = newRun();
  toAuditing(run, 'c1'); // c1 进入审计链
  feedVerdict(run, 'REVISE');
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 2, head: 'c2-bad',
  }));
  run.executorReady(marker, { ancestryOk: false });
  run.resumeFromHuman({ newBaselineCommit: 'human-fixed-base' });
  assert.equal(run.s.stageBaseCommit, 'human-fixed-base');
  assert.equal(run.manifest.stageBaseCommit, 'human-fixed-base');
  assert.deepEqual(run.manifest.auditedCommits, ['c1']); // 追责链保留
  assert.equal(run.s.state, 'EXECUTING');
});

// ---------- /audit until 竞态 ----------
await ok('until target < currentStage rejected', () => {
  const { run } = newRun();
  toAuditing(run, 'c1'); feedVerdict(run, 'APPROVE'); // now at T2
  assert.equal(run.s.currentStage, 'T2');
  assert.throws(() => run.until('T1'), ManifestValidationError);
});

await ok('until target == currentStage allowed; repeat idempotent', () => {
  const { run } = newRun();
  assert.equal(run.until('T3').changed, true); // T1 → T3 合法（>= current，且 != 原 stopAfter T2）
  assert.equal(run.s.stopAfter, 'T3');
  assert.equal(run.until('T3').changed, false); // 幂等
  const events = run.store.loadRun(run.runId).events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'STOP_TARGET_CHANGED').length, 1);
});

await ok('until target not in stages rejected', () => {
  const { run } = newRun();
  assert.throws(() => run.until('T9'), ManifestValidationError);
});

// ---------- push gate（§29.3） ----------
await ok('transient push → WAIT_GIT_PUSH → retry(transient) → ok → AUDITING', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'c1',
  }));
  run.executorReady(marker, {});
  let r = run.remoteSyncResult({ ok: false, kind: 'transient' }); // EXECUTING → WAIT
  assert.equal(r.waiting, true);
  assert.equal(run.s.state, 'WAIT_GIT_PUSH');
  r = run.remoteSyncResult({ ok: false, kind: 'transient' }); // WAIT 态重试（产生 RETRY 事件）
  assert.equal(r.waiting, true);
  r = run.remoteSyncResult({ ok: true, tipMatches: true }); // 第三次成功
  assert.equal(r.auditing, true);
  assert.equal(run.s.state, 'AUDITING');
  const events = run.store.loadRun(run.runId).events.map((e) => e.event);
  assert.ok(events.includes('GIT_PUSH_WAIT'));
  assert.equal(events.filter((e) => e === 'GIT_PUSH_RETRY').length, 1);
  assert.ok(events.includes('AUDIT_REMOTE_READY'));
});

await ok('transient over pushMax → ERROR_GIT_REMOTE → PAUSED_NEEDS_USER', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'c1',
  }));
  run.executorReady(marker, {});
  for (let i = 0; i < 4; i++) {
    const r = run.remoteSyncResult({ ok: false, kind: 'transient' });
    if (r.fatal) break;
  }
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'ERROR_GIT_REMOTE');
});

await ok('non-fast-forward push → PAUSED_NEEDS_USER immediately', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'c1',
  }));
  run.executorReady(marker, {});
  const r = run.remoteSyncResult({ ok: false, kind: 'rejected' });
  assert.equal(r.fatal, 'ERROR_GIT_REMOTE');
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
});

await ok('push ok but remote tip diverged → PAUSED_NEEDS_USER', () => {
  const { run } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'c1',
  }));
  run.executorReady(marker, {});
  const r = run.remoteSyncResult({ ok: true, tipMatches: false });
  assert.equal(r.fatal, 'ERROR_GIT_REMOTE');
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
});

// ---------- marker / verdict 缺失 ----------
await ok('markerMissing ×1 retry, ×2 PAUSED_NEEDS_USER', () => {
  const { run } = newRun();
  assert.equal(run.markerMissing().retry, true);
  assert.equal(run.markerMissing().failed, true);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'MARKER_PARSE_FAILED');
});

await ok('verdictMissing ×1 retry, ×2 PAUSED_NEEDS_USER (§14.5)', () => {
  const { run } = newRun();
  toAuditing(run);
  assert.equal(run.verdictMissing().retry, true);
  assert.equal(run.verdictMissing().failed, true);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'VERDICT_PARSE_FAILED');
});

// ---------- G7 幂等 / G9 身份 ----------
await ok('duplicate verdict delivery → deduped, no double advance', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  const text = buildVerdictText({ state: 'APPROVE', runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1 });
  const parsed = parseAuditorVerdict(text);
  const r1 = run.auditorVerdict(parsed);
  assert.equal(r1.advanced, true);
  const r2 = run.auditorVerdict(parseAuditorVerdict(text)); // 同一文本重复投递
  assert.equal(r2.deduped, true);
  assert.equal(run.s.currentStage, 'T2'); // 没有二次推进
  const events = run.store.loadRun(run.runId).events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'STAGE_ADVANCED').length, 1);
});

await ok('identity mismatch on verdict → fail closed, state unchanged', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  const bad = parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: 'audit_OTHER', hostId: 'h1', stage: 'T1', iteration: 1,
  }));
  assert.throws(() => run.auditorVerdict(bad), (e) => e.code === 'AUDIT_IDENTITY_MISMATCH' && e.field === 'RUN_ID');
  assert.equal(run.s.state, 'AUDITING'); // 未推进
});

await ok('omitted HOST_ID on verdict → rejected (fail closed, A1.1 P0-1)', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  const noHost = parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: run.runId, stage: 'T1', iteration: 1, // 无 HOST_ID 头行
  }));
  assert.equal(noHost.hostId, null);
  assert.throws(() => run.auditorVerdict(noHost),
    (e) => e.code === 'AUDIT_IDENTITY_MISMATCH' && e.field === 'HOST_ID');
  assert.equal(run.s.state, 'AUDITING');
});

await ok('omitted HOST_ID on executor marker → rejected (fail closed)', () => {
  const { run } = newRun();
  const noHost = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, stage: 'T1', iteration: 1, head: 'c1', // 无 HOST_ID 头行
  }));
  assert.equal(noHost.hostId, null);
  assert.throws(() => run.executorReady(noHost, {}),
    (e) => e.code === 'AUDIT_IDENTITY_MISMATCH' && e.field === 'HOST_ID');
  assert.equal(run.s.state, 'EXECUTING');
  assert.equal(run.s.pendingRemoteSync, null);
});

await ok('identity mismatch on marker (bad iteration) → fail closed', () => {
  const { run } = newRun();
  const bad = parseExecutorMarker(buildExecutorMarkerText({
    runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 7, head: 'c1',
  }));
  assert.throws(() => run.executorReady(bad, {}), (e) => e.code === 'AUDIT_IDENTITY_MISMATCH' && e.field === 'ITERATION');
  assert.equal(run.s.state, 'EXECUTING');
});

// ---------- 额度两侧 ----------
await ok('WEB quota: AUDITING → WAIT → recover same iteration', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  run.webQuotaExhausted();
  assert.equal(run.s.state, 'WAIT_WEB_QUOTA');
  assert.deepEqual(run.s.auditInFlight, { stage: 'T1', iteration: 1, headCommit: 'c1' }); // 保留
  run.webQuotaRecovered();
  assert.equal(run.s.state, 'AUDITING');
  assert.equal(run.s.iteration, 1); // 同轮重发，未 +1
});

await ok('DSH quota: EXECUTING → WAIT → recover', () => {
  const { run } = newRun();
  run.dshQuotaExhausted();
  assert.equal(run.s.state, 'WAIT_DSH_QUOTA');
  run.dshQuotaRecovered();
  assert.equal(run.s.state, 'EXECUTING');
});

// ---------- terminal 冻结 ----------
await ok('terminal run frozen for all actions (but duplicate verdict still dedupes)', () => {
  const { run } = newRun({ manifest: { stopAfter: 'T1' } });
  toAuditing(run, 'c1');
  feedVerdict(run, 'APPROVE');
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  // 同一 verdict 重复投递：G7 幂等吞掉（deduped），不抛错也不推进
  assert.equal(feedVerdict(run, 'APPROVE').deduped, true);
  // 不同 verdict / 其他动作：terminal 冻结
  assert.throws(() => feedVerdict(run, 'REVISE'), FrozenStateException);
  assert.throws(() => run.until('T3'), FrozenStateException);
  assert.throws(() => run.pause(), FrozenStateException);
});

await ok('NEED_USER verdict → PAUSED_NEEDS_USER', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  const r = feedVerdict(run, 'NEED_USER', { reason: ['conflict with frozen plan'] });
  assert.equal(r.needUser, true);
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'NEED_USER');
});

// ---------- 用户干预 pause/resume/stop ----------
await ok('pause in EXECUTING → PAUSED records pausedFrom; resume returns', () => {
  const { run } = newRun();
  run.pause();
  assert.equal(run.s.state, 'PAUSED');
  assert.equal(run.s.pausedFrom, 'EXECUTING');
  const r = run.resume();
  assert.equal(r.resumed, 'EXECUTING');
  assert.equal(run.s.state, 'EXECUTING');
});

await ok('pause during AUDITING → resume back to AUDITING same round', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  run.pause();
  assert.equal(run.s.pausedFrom, 'AUDITING');
  run.resume();
  assert.equal(run.s.state, 'AUDITING');
  assert.deepEqual(run.s.auditInFlight, { stage: 'T1', iteration: 1, headCommit: 'c1' });
});

await ok('stop → STOPPED terminal with RUN_STOPPED event', () => {
  const { run } = newRun();
  run.stop();
  assert.equal(run.s.state, 'STOPPED');
  assert.ok(run.s.stoppedAt > 0);
  assert.ok(run.store.loadRun(run.runId).events.some((e) => e.event === 'RUN_STOPPED'));
});

await ok('stop from WAIT_GIT_PUSH / WAIT_DSH_QUOTA also legal', () => {
  const { run: r1 } = newRun();
  r1.dshQuotaExhausted();
  r1.stop();
  assert.equal(r1.s.state, 'STOPPED');

  const { run: r2 } = newRun();
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: r2.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'c1',
  }));
  r2.executorReady(marker, {});
  r2.remoteSyncResult({ ok: false, kind: 'transient' });
  assert.equal(r2.s.state, 'WAIT_GIT_PUSH');
  r2.stop();
  assert.equal(r2.s.state, 'STOPPED');
});

await ok('pause during WAIT_WEB_QUOTA → PAUSED → resume back to AUDITING', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  run.webQuotaExhausted();
  run.pause();
  assert.equal(run.s.state, 'PAUSED');
  assert.equal(run.s.pausedFrom, 'WAIT_WEB_QUOTA'); // 记录的是 pause 时刻所在状态
  const r = run.resume();
  assert.equal(r.resumed, 'WAIT_WEB_QUOTA');
  run.webQuotaRecovered();
  assert.equal(run.s.state, 'AUDITING');
});

await ok('NEED_USER resume returns to AUDITING same round (human answered)', () => {
  const { run } = newRun();
  toAuditing(run, 'c1');
  feedVerdict(run, 'NEED_USER', { question: ['clarify goal?'] });
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  const r = run.resumeFromHuman({});
  assert.equal(r.resumed, 'AUDITING');
  assert.equal(run.s.state, 'AUDITING');
  assert.deepEqual(run.s.auditInFlight, { stage: 'T1', iteration: 1, headCommit: 'c1' }); // 同轮继续
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
