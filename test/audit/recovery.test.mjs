#!/usr/bin/env node
/**
 * audit/recovery.test.mjs — 崩溃恢复与跨重启幂等测试（纯 Node，无真实 sleep）。
 *
 *  G8 Durable restart recovery：
 *  - crash @ AUDIT_STARTED / READY_FOR_AUDIT / AUDIT_APPROVE / WAIT_GIT_PUSH → reload 续跑，无双批准；
 *  - crash 夹缝（事件已落盘、状态未转移）→ 重放同输入收敛，不产生重复事件；
 *  G9：events.jsonl 是 dedupe 唯一事实源，重启后 seenKeys 重建；
 *  - 额度窗口等待恢复后同轮重发（iteration 不变）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditRun } from '../../src/audit/state-machine.js';
import { AuditStore } from '../../src/audit/store.js';
import { runAuditScenario, SimulatedCrash } from '../../src/audit/fake-runner.js';
import { buildExecutorMarkerText, buildVerdictText, parseExecutorMarker, parseAuditorVerdict } from '../../src/audit/protocol.js';

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
  return new AuditStore(fs.mkdtempSync(path.join(os.tmpdir(), `audit-rc-${seq}-`)));
};

await ok('crash @ AUDIT_STARTED → reload → same audit round, exactly one APPROVE', () => {
  const store = newStore();
  let crashed;
  try {
    runAuditScenario({
      store, manifestInput: { ...MANIFEST, runId: 'rc1' },
      executorScript: [{ type: 'READY' }],
      auditorScript: [{ type: 'APPROVE' }],
      crashOnEvent: { event: 'AUDIT_STARTED' },
    });
  } catch (e) {
    assert.ok(e instanceof SimulatedCrash); crashed = e;
  }
  assert.equal(crashed.atEvent, 'AUDIT_STARTED');
  // 进程重启：重新 open
  const open = AuditRun.open(store);
  const run = open('rc1');
  assert.equal(run.s.state, 'AUDITING');
  assert.deepEqual(run.s.auditInFlight, { stage: 'T1', iteration: 1, headCommit: 'fke0001' });
  // 续跑：verdict 正常处理
  const v = parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: 'rc1', hostId: 'h1', stage: 'T1', iteration: 1,
  }));
  const r = run.auditorVerdict(v);
  assert.equal(r.advanced, true);
  const events = store.loadRun('rc1').events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'AUDIT_APPROVE').length, 1); // 无双批准
  assert.equal(events.filter((e) => e === 'AUDIT_STARTED').length, 1);
});

await ok('crash @ AUDIT_APPROVE (event saved, state not yet advanced) → replay converges', () => {
  const store = newStore();
  // 手工走到 AUDITING，然后直接在 appendEvent AUDIT_APPROVE 后崩溃：
  // 事件写入成功但 saveState 未发生。
  const run = AuditRun.create(store, { ...MANIFEST, runId: 'rc2' });
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc2', hostId: 'h1', stage: 'T1', iteration: 1, head: 'c1',
  }));
  run.executorReady(marker, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  assert.equal(run.s.state, 'AUDITING');

  // 模拟：内存中先 emit AUDIT_APPROVE 再崩溃（不 saveState）。
  // 用一个代理 store 捕获，简单方式：直接调用 auditorVerdict 前丢弃 saveState ——
  // 改为复现真实顺序：emit 先于 transition。手工模拟：
  const evt = {
    runId: 'rc2', hostId: 'h1', stage: 'T1', iteration: 1, headCommit: 'c1', event: 'AUDIT_APPROVE',
    timestamp: 1, elapsedMs: 1, tokens: null,
    dedupeKey: 'rc2|T1|1|c1|AUDIT_APPROVE',
  };
  store.appendEvent(evt); // 事件落盘
  // 状态仍是 AUDITING（未执行 transition —— 崩溃）

  const reopened = AuditRun.open(store)('rc2');
  assert.equal(reopened.s.state, 'AUDITING'); // 恢复到崩溃前状态
  // 重放同一 verdict：
  const v = parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: 'rc2', hostId: 'h1', stage: 'T1', iteration: 1,
  }));
  const r = reopened.auditorVerdict(v);
  assert.equal(r.advanced, true); // 状态推进完成
  const events = store.loadRun('rc2').events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'AUDIT_APPROVE').length, 1); // 事件只一份（dedupe 吞掉重放）
  assert.ok(events.includes('STAGE_ADVANCED'));
});

await ok('crash @ READY_FOR_AUDIT (inside emit window) → reload → gate still enforced, replay converges', () => {
  const store = newStore();
  let crashed;
  try {
    runAuditScenario({
      store, manifestInput: { ...MANIFEST, runId: 'rc3' },
      executorScript: [{ type: 'READY' }, { type: 'READY' }],
      auditorScript: [{ type: 'APPROVE' }, { type: 'APPROVE' }],
      crashOnEvent: { event: 'READY_FOR_AUDIT' },
    });
  } catch (e) { assert.ok(e instanceof SimulatedCrash); crashed = e; }
  // 崩溃窗口语义：emit 先于 saveState → READY_FOR_AUDIT 事件已落盘，
  // 但 pendingRemoteSync 内存态丢失。恢复 = EXECUTING，gate 事实不存在（fail closed）。
  const run = AuditRun.open(store)('rc3');
  assert.equal(run.s.state, 'EXECUTING');
  assert.equal(run.s.pendingRemoteSync, null); // 未过 gate 的 READY 不构成任何推进依据
  // 恢复后未进 AUDITING：verdict 被拒绝（G6：READY ≠ PASS）
  assert.throws(() => run.auditorVerdict(parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: 'rc3', hostId: 'h1', stage: 'T1', iteration: 1,
  }))), (e) => e.code === 'AUDIT_ILLEGAL_TRANSITION');
  // executor 重放同一 READY（事件被 dedupe 吞），gate 补跑 → 正常进入审计
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc3', hostId: 'h1', stage: 'T1', iteration: 1, head: 'fke0001',
  }));
  run.executorReady(marker, {});
  const r = run.remoteSyncResult({ ok: true, tipMatches: true });
  assert.equal(r.auditing, true);
  const events = store.loadRun('rc3').events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'READY_FOR_AUDIT').length, 1); // 重放未产生重复事件
});

await ok('crash @ GIT_PUSH_RETRY (WAIT state, after saveState) → reload → attempts persist', () => {
  const store = newStore();
  let crashed;
  try {
    runAuditScenario({
      store, manifestInput: { ...MANIFEST, runId: 'rc4' },
      executorScript: [{ type: 'READY', pushAll: [{ ok: false, kind: 'transient' }, { ok: false, kind: 'transient' }] }],
      auditorScript: [{ type: 'APPROVE' }, { type: 'APPROVE' }],
      // 第 1 次 transient：GIT_PUSH_WAIT + transition；第 2 次（WAIT 态）：计数已落盘后才 crash 在
      // emit 窗口 —— 注意 remoteSyncResult 中 WAIT 态重试是 emit(RETRY) 先于 saveState，
      // 因此 crash 后 attempts 回退为 1（第 1 次已随 transition 落盘）。
      crashOnEvent: { event: 'GIT_PUSH_RETRY' },
    });
  } catch (e) { assert.ok(e instanceof SimulatedCrash); crashed = e; }
  const run = AuditRun.open(store)('rc4');
  assert.equal(run.s.state, 'WAIT_GIT_PUSH');
  assert.equal(run.s.retry.pushAttempts, 1); // 窗口内未落盘的自增丢失（安全：重放会重新计数）
  assert.ok(run.s.pendingRemoteSync); // gate 待补
  const r = run.remoteSyncResult({ ok: true, tipMatches: true });
  assert.equal(r.auditing, true);
  const events = store.loadRun('rc4').events.map((e) => e.event);
  assert.ok(events.includes('AUDIT_REMOTE_READY'));
});

await ok('dedupe survives restart purely via events.jsonl (no in-memory state)', () => {
  const store = newStore();
  const evt = {
    runId: 'rc5', stage: 'T1', iteration: 1, headCommit: 'c1', event: 'AUDIT_REVISE',
    timestamp: 1, elapsedMs: 1, tokens: null, dedupeKey: 'rc5|T1|1|c1|AUDIT_REVISE',
  };
  const run = AuditRun.create(store, { ...MANIFEST, runId: 'rc5' }); // 合法 manifest + 初始 state
  store.appendEvent(evt);
  const store2 = new AuditStore(store.root); // 全新进程，无任何缓存
  assert.equal(store2.appendEvent({ ...evt, timestamp: 999 }).appended, false);
});

await ok('WEB quota wait → recover → same iteration re-audit, both events recorded', () => {
  const store = newStore();
  const r = runAuditScenario({
    store, manifestInput: { ...MANIFEST, runId: 'rc6', stopAfter: 'T1' },
    executorScript: [{ type: 'READY' }],
    auditorScript: [{ type: 'WEB_QUOTA' }, { type: 'APPROVE' }],
  });
  assert.equal(r.run.s.state, 'STOPPED_TARGET_REACHED');
  const events = store.loadRun('rc6').events;
  assert.ok(events.some((e) => e.event === 'WEB_QUOTA_WAIT'));
  assert.ok(events.some((e) => e.event === 'WEB_QUOTA_RECOVER'));
  const started = events.filter((e) => e.event === 'AUDIT_STARTED');
  assert.equal(started.length, 2); // 首发 + 同轮重发
  assert.equal(started[1].iteration, started[0].iteration); // 同 iteration
  assert.equal(started[1].stage, started[0].stage);
  assert.equal(started[1].headCommit, started[0].headCommit); // 同 head —— 语义：同一轮审计
  assert.notEqual(started[1].dedupeKey, started[0].dedupeKey); // repeatSeq 区分（重发是新事实）
});

await ok('DSH quota wait → recover → continue same stage', () => {
  const store = newStore();
  const r = runAuditScenario({
    store, manifestInput: { ...MANIFEST, runId: 'rc7', stopAfter: 'T1' },
    executorScript: [{ type: 'DSH_QUOTA' }, { type: 'READY' }],
    auditorScript: [{ type: 'APPROVE' }],
  });
  assert.equal(r.run.s.state, 'STOPPED_TARGET_REACHED');
  const events = store.loadRun('rc7').events.map((e) => e.event);
  assert.ok(events.includes('DSH_QUOTA_WAIT'));
  assert.ok(events.includes('DSH_QUOTA_RECOVER'));
});

await ok('crash mid-run then full scenario replay from scratch store keeps history intact', () => {
  const store = newStore();
  // 第一段：crash 在 T1 AUDIT_STARTED
  try {
    runAuditScenario({
      store, manifestInput: { ...MANIFEST, runId: 'rc8' },
      executorScript: [{ type: 'READY' }, { type: 'READY' }, { type: 'READY' }],
      auditorScript: [{ type: 'APPROVE' }, { type: 'APPROVE' }],
      crashOnEvent: { event: 'AUDIT_STARTED' },
    });
  } catch { /* SimulatedCrash */ }
  // 第二段：用新脚本从恢复点续跑完（手工编排恢复后的轮次）
  const open = AuditRun.open(store);
  const run = open('rc8');
  assert.equal(run.s.state, 'AUDITING');
  const v1 = parseAuditorVerdict(buildVerdictText({ state: 'APPROVE', runId: 'rc8', hostId: 'h1', stage: 'T1', iteration: 1 }));
  run.auditorVerdict(v1); // T1 → T2
  assert.equal(run.s.currentStage, 'T2');
  const m2 = parseExecutorMarker(buildExecutorMarkerText({ runId: 'rc8', hostId: 'h1', stage: 'T2', iteration: 1, head: 'c2' }));
  run.executorReady(m2, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  const v2 = parseAuditorVerdict(buildVerdictText({ state: 'APPROVE', runId: 'rc8', hostId: 'h1', stage: 'T2', iteration: 1 }));
  run.auditorVerdict(v2);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  const events = store.loadRun('rc8').events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'RUN_STARTED').length, 1); // 恢复不产生新 RUN_STARTED
  assert.deepEqual(run.manifest.auditedCommits, ['fke0001', 'c2']);
});

// ---------- A1.1 P0-2：两段式转移的持久化中间态收敛 ----------
// 模拟手段：走到稳态后手工把磁盘 state.json 改写为「第一段已落盘、第二段未完成」，
// 再 open() 断言 recoverTransientState 确定性收敛。

const writeState = (store, runId, mutate) => {
  const file = path.join(store.root, 'runs', runId, 'state.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify(mutate(s), null, 2)}\n`);
};
const readStateFile = (store, runId) => JSON.parse(
  fs.readFileSync(path.join(store.root, 'runs', runId, 'state.json'), 'utf8'));

await ok('crash window: state=NEXT_STAGE persisted, manifest NOT yet advanced → open completes advance', () => {
  const store = newStore();
  const run = AuditRun.create(store, { ...MANIFEST, runId: 'rc10' }); // T1→T2
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc10', hostId: 'h1', stage: 'T1', iteration: 1, head: 'cA1',
  }));
  run.executorReady(marker, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  // 手工制造中间态：state=NEXT_STAGE（currentStage 仍 T1；AUDIT_APPROVE 事件已在流中）
  store.appendEvent({
    runId: 'rc10', stage: 'T1', iteration: 1, headCommit: 'cA1', event: 'AUDIT_APPROVE',
    timestamp: 1, elapsedMs: 1, tokens: null, dedupeKey: 'rc10|T1|1|cA1|AUDIT_APPROVE',
  });
  writeState(store, 'rc10', (s) => ({ ...s, state: 'NEXT_STAGE', auditInFlight: null }));

  const reopened = AuditRun.open(store)('rc10'); // open 自动收敛
  assert.equal(reopened.s.state, 'EXECUTING');
  assert.equal(reopened.s.currentStage, 'T2');
  assert.equal(reopened.manifest.currentStage, 'T2');
  assert.equal(reopened.s.iteration, 1);
  assert.equal(reopened.s.revisionCount, 0);
  assert.equal(reopened.s.stageBaseCommit, 'cA1');
  const ev = store.loadRun('rc10').events.map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'STAGE_ADVANCED').length, 1); // 补完，不重复
  assert.equal(ev.filter((e) => e === 'STAGE_STARTED').length, 2); // RUN 起始 + 补完的 T2
});

await ok('crash window: NEXT_STAGE + manifest already advanced → open converges idempotently', () => {
  const store = newStore();
  const run = AuditRun.create(store, { ...MANIFEST, runId: 'rc11' });
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc11', hostId: 'h1', stage: 'T1', iteration: 1, head: 'cB1',
  }));
  run.executorReady(marker, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  store.appendEvent({
    runId: 'rc11', stage: 'T1', iteration: 1, headCommit: 'cB1', event: 'AUDIT_APPROVE',
    timestamp: 1, elapsedMs: 1, tokens: null, dedupeKey: 'rc11|T1|1|cB1|AUDIT_APPROVE',
  });
  // 第一段：manifest 已写新 stage；state 停在 NEXT_STAGE（旧 currentStage）
  writeState(store, 'rc11', (s) => ({ ...s, state: 'NEXT_STAGE', auditInFlight: null }));
  const mfile = path.join(store.root, 'runs', 'rc11', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  fs.writeFileSync(mfile, `${JSON.stringify({ ...m, currentStage: 'T2', stageBaseCommit: 'cB1' }, null, 2)}\n`);
  store.appendEvent({
    runId: 'rc11', stage: 'T2', iteration: 1, headCommit: 'cB1', event: 'STAGE_ADVANCED',
    timestamp: 2, elapsedMs: 2, tokens: null, dedupeKey: 'rc11|T2|1|cB1|STAGE_ADVANCED',
  });

  const reopened = AuditRun.open(store)('rc11');
  assert.equal(reopened.s.state, 'EXECUTING');
  assert.equal(reopened.s.currentStage, 'T2');
  assert.equal(reopened.s.stageBaseCommit, 'cB1');
  const ev = store.loadRun('rc11').events.map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'STAGE_ADVANCED').length, 1); // 已发事件被 dedupe 吞，不重复
});

await ok('crash window: REVISE_LOOP_EXHAUSTED persisted → open finishes PAUSED_NEEDS_USER', () => {
  const store = newStore();
  const run = AuditRun.create(store, { ...MANIFEST, runId: 'rc12' }, { maxReviewIterations: 1 });
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc12', hostId: 'h1', stage: 'T1', iteration: 1, head: 'cC1',
  }));
  run.executorReady(marker, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  // 真实顺序：emit AUDIT_REVISE → revisionCount=1 → transition(EXHAUSTED) 落盘 → [crash here]
  store.appendEvent({
    runId: 'rc12', stage: 'T1', iteration: 1, headCommit: 'cC1', event: 'AUDIT_REVISE',
    timestamp: 1, elapsedMs: 1, tokens: null, dedupeKey: 'rc12|T1|1|cC1|AUDIT_REVISE',
  });
  writeState(store, 'rc12', (s) => ({
    ...s, state: 'REVISE_LOOP_EXHAUSTED', auditInFlight: null, revisionCount: 1, iteration: 2,
  }));

  const reopened = AuditRun.open(store)('rc12');
  assert.equal(reopened.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(reopened.s.cause, 'REVISE_LOOP_EXHAUSTED');
  assert.equal(reopened.s.revisionCount, 1); // 不归零
  const ev = store.loadRun('rc12').events.map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'REVISE_LOOP_EXHAUSTED').length, 1); // 恰一次
  // 收敛后 resumeFromHuman 正常可用（不再卡在 resume 不接受的非 PAUSED_NEEDS_USER 状态）；
  // cause=EXHAUSTED 不要求 newBaseline；不加 bump 则计数保持（下次 REVISE 立即再耗尽）
  const r = reopened.resumeFromHuman({});
  assert.equal(r.resumed, 'EXECUTING');
  assert.equal(reopened.s.revisionCount, 1);
});

await ok('crash window: HISTORY_REWRITTEN persisted → open finishes PAUSED_NEEDS_USER, baseline rule intact', () => {
  const store = newStore();
  AuditRun.create(store, { ...MANIFEST, runId: 'rc13' });
  store.appendEvent({
    runId: 'rc13', stage: 'T1', iteration: 1, headCommit: 'base00', event: 'HISTORY_REWRITTEN',
    timestamp: 1, elapsedMs: 1, tokens: null, dedupeKey: 'rc13|T1|1|base00|HISTORY_REWRITTEN',
  });
  writeState(store, 'rc13', (s) => ({ ...s, state: 'HISTORY_REWRITTEN' }));

  const reopened = AuditRun.open(store)('rc13');
  assert.equal(reopened.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(reopened.s.cause, 'HISTORY_REWRITTEN');
  // G11 规则在恢复后依然完整：无显式 baseline 不得 resume
  assert.throws(() => reopened.resumeFromHuman({}), (e) => e.code === 'AUDIT_BASELINE_REQUIRED');
  const r = reopened.resumeFromHuman({ newBaselineCommit: 'fixed-base' });
  assert.equal(r.resumed, 'EXECUTING');
});

await ok('crash window: auditedCommits written, AUDITING state not yet → replay gate no double-append', () => {
  const store = newStore();
  const run = AuditRun.create(store, { ...MANIFEST, runId: 'rc14' });
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc14', hostId: 'h1', stage: 'T1', iteration: 1, head: 'cD1',
  }));
  run.executorReady(marker, {});
  const done = run.remoteSyncResult({ ok: true, tipMatches: true }); // 正常完成（manifest 含 cD1）
  assert.equal(done.auditing, true);
  // 手工回退磁盘 state 到 gate 前（模拟 crash 在 saveManifest 之后、saveState 之前）
  const before = readStateFile(store, 'rc14');
  writeState(store, 'rc14', (s) => ({
    ...s, state: 'EXECUTING', auditInFlight: null,
    pendingRemoteSync: { stage: 'T1', iteration: 1, head: 'cD1' },
  }));
  assert.deepEqual(store.loadRun('rc14').manifest.auditedCommits, ['cD1']);

  const reopened = AuditRun.open(store)('rc14');
  assert.equal(reopened.s.state, 'EXECUTING');
  assert.ok(reopened.s.pendingRemoteSync); // gate 待补
  const r = reopened.remoteSyncResult({ ok: true, tipMatches: true }); // 重放同一 gate 成功
  assert.equal(r.auditing, true);
  assert.deepEqual(store.loadRun('rc14').manifest.auditedCommits, ['cD1']); // 集合语义：不重复 append
  const ev = store.loadRun('rc14').events.map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'AUDIT_REMOTE_READY').length, 1); // dedupe
  assert.equal(ev.filter((e) => e === 'AUDIT_STARTED').length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
