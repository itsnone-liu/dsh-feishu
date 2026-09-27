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
    state: 'APPROVE', runId: 'rc1', stage: 'T1', iteration: 1,
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
    runId: 'rc2', stage: 'T1', iteration: 1, head: 'c1',
  }));
  run.executorReady(marker, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  assert.equal(run.s.state, 'AUDITING');

  // 模拟：内存中先 emit AUDIT_APPROVE 再崩溃（不 saveState）。
  // 用一个代理 store 捕获，简单方式：直接调用 auditorVerdict 前丢弃 saveState ——
  // 改为复现真实顺序：emit 先于 transition。手工模拟：
  const evt = {
    runId: 'rc2', stage: 'T1', iteration: 1, headCommit: 'c1', event: 'AUDIT_APPROVE',
    timestamp: 1, elapsedMs: 1, tokens: null,
    dedupeKey: 'rc2|T1|1|c1|AUDIT_APPROVE',
  };
  store.appendEvent(evt); // 事件落盘
  // 状态仍是 AUDITING（未执行 transition —— 崩溃）

  const reopened = AuditRun.open(store)('rc2');
  assert.equal(reopened.s.state, 'AUDITING'); // 恢复到崩溃前状态
  // 重放同一 verdict：
  const v = parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: 'rc2', stage: 'T1', iteration: 1,
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
    state: 'APPROVE', runId: 'rc3', stage: 'T1', iteration: 1,
  }))), (e) => e.code === 'AUDIT_ILLEGAL_TRANSITION');
  // executor 重放同一 READY（事件被 dedupe 吞），gate 补跑 → 正常进入审计
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId: 'rc3', stage: 'T1', iteration: 1, head: 'fke0001',
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
  store.createRun({ runId: 'rc5' }, { runId: 'rc5', state: 'EXECUTING' });
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
  const v1 = parseAuditorVerdict(buildVerdictText({ state: 'APPROVE', runId: 'rc8', stage: 'T1', iteration: 1 }));
  run.auditorVerdict(v1); // T1 → T2
  assert.equal(run.s.currentStage, 'T2');
  const m2 = parseExecutorMarker(buildExecutorMarkerText({ runId: 'rc8', stage: 'T2', iteration: 1, head: 'c2' }));
  run.executorReady(m2, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  const v2 = parseAuditorVerdict(buildVerdictText({ state: 'APPROVE', runId: 'rc8', stage: 'T2', iteration: 1 }));
  run.auditorVerdict(v2);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  const events = store.loadRun('rc8').events.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'RUN_STARTED').length, 1); // 恢复不产生新 RUN_STARTED
  assert.deepEqual(run.manifest.auditedCommits, ['fke0001', 'c2']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
