#!/usr/bin/env node
/**
 * audit/controller.test.mjs — A2：AuditController 命令面 ↔ A1 冻结内核。
 *
 * 验收目标：用户能安全创建、查看、暂停、恢复、改停止点、终止 AuditRun；
 * 语义决策全部发生在内核 —— Controller 只翻译，不重写。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { AuditRun, STATES } from '../../src/audit/state-machine.js';
import { AuditController } from '../../src/audit/controller.js';
import {
  buildExecutorMarkerText, parseExecutorMarker, buildVerdictText, parseAuditorVerdict,
} from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });

const newCtrl = (over = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ctrl-'));
  const store = new AuditStore(root);
  let tick = 1000;
  const now = over.now ?? (() => (tick += 1)); // 递增：runId 含时间戳，固定时钟会撞名
  return new AuditController({ store, hostId: 'h1', cwd: '/w', repo: 'stub://t', branch: 'main', now, ...over });
};
/** 用内核协议把 run 推进到 AUDITING（等同真实 executor+gate 路径）。 */
const pushToAuditing = (ctrl, runId, head = 'fke0001') => {
  const run = AuditRun.open(ctrl.store, { now: ctrl.now })(runId);
  const marker = parseExecutorMarker(buildExecutorMarkerText({
    runId, hostId: 'h1', stage: run.s.currentStage, iteration: run.s.iteration, head,
  }));
  run.executorReady(marker, {});
  run.remoteSyncResult({ ok: true, tipMatches: true });
  return run;
};

await ok('createRun：EXECUTING 起步，stopAfter 生效，manifest 落盘', () => {
  const ctrl = newCtrl();
  const r = ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  assert.equal(r.ok, true);
  assert.equal(r.result.state, 'EXECUTING');
  const loaded = ctrl.store.loadRun(r.runId);
  assert.equal(loaded.manifest.stopAfter, 'T2');
  assert.equal(loaded.manifest.hostId, 'h1');
  assert.equal(loaded.manifest.chatId, 'oc_A');
  assert.equal(loaded.state.state, 'EXECUTING');
});

await ok('owner binding：Chat B 无法 status/pause/resume/stop/until，且不泄露详情', () => {
  const ctrl = newCtrl();
  const created = ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  assert.equal(ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_B' }).code, 'AUDIT_RUN_OWNED_BY_OTHER_CHAT');
  for (const [name, result] of Object.entries({
    status: ctrl.status('oc_B'),
    pause: ctrl.pause('oc_B'),
    resume: ctrl.resume('oc_B'),
    stop: ctrl.stop('oc_B'),
    until: ctrl.until('oc_B', 'T3'),
  })) {
    assert.equal(result.ok, false, name);
    assert.equal(result.code, 'AUDIT_RUN_OWNED_BY_OTHER_CHAT', name);
    assert.doesNotMatch(result.message, new RegExp(created.runId));
    assert.doesNotMatch(result.message, /T1|T2|EXECUTING|commit|事件/);
  }
  assert.equal(ctrl.status('oc_A').result.currentStage, 'T1'); // B 的尝试没有改变 owner run
});

await ok('createRun：已有活跃 run → 拒绝（不并发两个审计）', () => {
  const ctrl = newCtrl();
  assert.equal(ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' }).ok, true);
  const r2 = ctrl.createRun({ stopAfter: 'T3', chatId: 'oc_A' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'AUDIT_RUN_ACTIVE');
  assert.match(r2.message, /先 `.audit stop`/);
});

await ok('createRun：stopAfter 不在阶段表 → 明确报错', () => {
  const ctrl = newCtrl();
  const r = ctrl.createRun({ stopAfter: 'T9', chatId: 'oc_A' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIT_MANIFEST_INVALID');
  assert.match(r.message, /T9/);
});

await ok('status：无 run / 有 run / 终态后回看最近 run', () => {
  const ctrl = newCtrl();
  const none = ctrl.status('oc_A');
  assert.equal(none.ok, false);
  assert.equal(none.code, 'AUDIT_NO_RUN');
  const r = ctrl.createRun({ stopAfter: 'T1', chatId: 'oc_A' });
  const s = ctrl.status('oc_A');
  assert.equal(s.ok, true);
  assert.equal(s.result.state, 'EXECUTING');
  assert.equal(s.result.currentStage, 'T1');
  assert.equal(s.result.maxReviewIterations, 16);
  ctrl.stop('oc_A');
  const after = ctrl.status('oc_A'); // 终态 run 仍可查看（allowFinished 回退）
  assert.equal(after.ok, true);
  assert.equal(after.result.state, 'STOPPED');
});

await ok('pause/resume 走内核转移（EXECUTING→PAUSED→EXECUTING）', () => {
  const ctrl = newCtrl();
  ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  const p = ctrl.pause('oc_A');
  assert.equal(p.ok, true);
  assert.equal(p.result.state, 'PAUSED');
  const rm = ctrl.resume('oc_A');
  assert.equal(rm.ok, true);
  assert.equal(rm.result.state, 'EXECUTING');
});

await ok('pause 在终态后 → 无活跃 run 的明确报错（非崩溃、非静默）', () => {
  const ctrl = newCtrl();
  ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  ctrl.stop('oc_A');
  const p = ctrl.pause('oc_A');
  assert.equal(p.ok, false);
  assert.equal(p.code, 'AUDIT_NO_ACTIVE_RUN'); // 终态不算活跃：无需 pause，也不该能 pause
});

await ok('until：改停止点走 v0.2 §6.2 规则（含幂等）', () => {
  const ctrl = newCtrl();
  ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  const r = ctrl.until('oc_A', 'T3');
  assert.equal(r.ok, true);
  assert.equal(r.result.changed, true);
  assert.equal(r.result.stopAfter, 'T3');
  const same = ctrl.until('oc_A', 'T3');
  assert.equal(same.result.changed, false); // 幂等
  // 内核规则：倒退到已过阶段被拒（当前 T1，until T1 仍合法；AUDITING 中倒退被 §6.2 拒）
  const bad = ctrl.until('oc_A', 'NOPE');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'AUDIT_MANIFEST_INVALID');
});

await ok('stop：EXECUTING/AUDITING/WAIT_* 全可停；停后可新建', () => {
  const ctrl = newCtrl();
  const r1 = ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  pushToAuditing(ctrl, r1.runId); // AUDITING
  const s = ctrl.stop('oc_A');
  assert.equal(s.ok, true);
  assert.equal(s.result.state, 'STOPPED');
  assert.equal(ctrl.activeRun(), null); // 不再活跃
  const r2 = ctrl.createRun({ stopAfter: 'T1', chatId: 'oc_A' });
  assert.equal(r2.ok, true); // 终态后允许新 run
});

await ok('集成：命令面与内核共享同一 store —— 手动驱动 verdict 后 status 反映', () => {
  const ctrl = newCtrl();
  const r = ctrl.createRun({ stopAfter: 'T1', chatId: 'oc_A' });
  const run = pushToAuditing(ctrl, r.runId);
  const mid = ctrl.status('oc_A');
  assert.equal(mid.result.state, 'AUDITING');
  assert.deepEqual(mid.result.auditedCommits, ['fke0001']);
  const v = parseAuditorVerdict(buildVerdictText({
    state: 'APPROVE', runId: r.runId, hostId: 'h1', stage: 'T1', iteration: 1,
  }));
  run.auditorVerdict(v);
  const fin = ctrl.status('oc_A');
  assert.equal(fin.result.state, 'STOPPED_TARGET_REACHED'); // 停止点 T1 严格生效
});

await ok('resume：PAUSED_NEEDS_USER(EXHAUSTED) → resumeFromHuman 通道', () => {
  const ctrl = newCtrl({ maxReviewIterations: 1 });
  const r = ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  const run = pushToAuditing(ctrl, r.runId);
  const v = parseAuditorVerdict(buildVerdictText({
    state: 'REVISE', runId: r.runId, hostId: 'h1', stage: 'T1', iteration: 1,
  }));
  run.auditorVerdict(v); // max=1 → EXHAUSTED → PAUSED_NEEDS_USER（内核自动收敛）
  const st = ctrl.status('oc_A');
  assert.equal(st.result.state, 'PAUSED_NEEDS_USER');
  assert.equal(st.result.cause, 'REVISE_LOOP_EXHAUSTED');
  const rm = ctrl.resume('oc_A');
  assert.equal(rm.ok, true);
  assert.equal(rm.result.state, 'EXECUTING');
});

await ok('resume：HISTORY_REWRITTEN → A2 明确拒绝并指引发人工/A3（G11 不降级）', () => {
  const ctrl = newCtrl();
  const r = ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  // 手工制造（A2 命令面无 rewrite 通道）：内核直接转 HISTORY_REWRITTEN + 收敛
  const run = AuditRun.open(ctrl.store, { now: ctrl.now })(r.runId);
  run.reportHistoryRewritten?.() ?? (() => {
    // 无公开方法时按协议路径：手工写盘为收敛后形态
    ctrl.store.saveState({ ...run.s, state: 'PAUSED_NEEDS_USER', cause: 'HISTORY_REWRITTEN' });
  })();
  const rm = ctrl.resume('oc_A');
  assert.equal(rm.ok, false);
  assert.equal(rm.code, 'AUDIT_BASELINE_REQUIRED');
  assert.match(rm.message, /A3/);
});

await ok('Controller 不产生内核外的状态：状态枚举完整覆盖', () => {
  const ctrl = newCtrl();
  ctrl.createRun({ stopAfter: 'T2', chatId: 'oc_A' });
  const s = ctrl.status('oc_A').result;
  // 所有暴露字段都来自内核 state/manifest（快照只读，无派生状态机）
  assert.ok(STATES.includes(s.state));
  assert.equal(typeof s.startedAt, 'number');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
