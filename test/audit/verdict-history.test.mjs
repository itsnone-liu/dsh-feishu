#!/usr/bin/env node
/**
 * audit/verdict-history.test.mjs — 裁决全文持久化（v0.4.4）测试。
 *
 * 背景：state.lastVerdict 只留最近一次裁决，历史文本随覆盖丢失；
 * CSR-8 run 的评审员明确拒绝采信"无法独立验证来源的裁决转录"。
 * verdicts.jsonl 让每次被接受的裁决全文成为运行目录内机器可引用证据。
 *
 * 覆盖：
 *  - store.appendVerdict/listVerdicts roundtrip + 必填字段校验；
 *  - 末行不完整容忍截断 / 中间坏行 fail loud；
 *  - 新 store 实例（重启后）读同一目录历史完整；
 *  - 集成：runAuditScenario 走 REVISE→…→APPROVE 后 verdicts.jsonl
 *    按序含全部裁决全文（含 summary/evidence/residualRisks 字段）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { StoreCorruptionError } from '../../src/audit/errors.js';
import { runAuditScenario } from '../../src/audit/fake-runner.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 4).join('\n  ')}`); });

const tmpStore = () => new AuditStore(fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-hist-')));

const M = (over = {}) => ({
  schemaVersion: 1,
  runId: 'r1', hostId: 'h1', cwd: '/w', repo: 'https://github.com/x/y.git', branch: 'main',
  stages: ['T1'], stopAfter: 'T1', startingCommit: 'base00', goal: 'g', approvedPlan: 'p',
  createdAt: 1, updatedAt: 1,
  ...over,
});

const V = (state, over = {}) => ({
  state, stage: 'T1', iteration: 1, runId: 'r1', hostId: 'h1',
  summary: ['s1'], evidence: ['e1'], residualRisks: ['r1'], p0: [], p1: [],
  ...over,
});

await ok('appendVerdict + listVerdicts roundtrip（含全文字段）', () => {
  const s = tmpStore();
  s.createRun(M(), { schemaVersion: 1, runId: 'r1', state: 'EXECUTING', currentStage: 'T1', stopAfter: 'T1', iteration: 1, revisionCount: 0, startedAt: 1 });
  s.appendVerdict({ runId: 'r1', stage: 'T1', iteration: 1, headCommit: 'c1', verdict: V('REVISE') });
  s.appendVerdict({ runId: 'r1', stage: 'T1', iteration: 2, headCommit: 'c2', verdict: V('APPROVE', { iteration: 2 }) });
  const list = s.listVerdicts('r1');
  assert.equal(list.length, 2);
  assert.equal(list[0].verdict.state, 'REVISE');
  assert.deepEqual(list[0].verdict.summary, ['s1']);
  assert.deepEqual(list[1].verdict.residualRisks, ['r1']);
  assert.equal(list[1].headCommit, 'c2');
  assert.ok(Number.isInteger(list[0].ts));
});

await ok('必填字段缺失 → fail loud', () => {
  const s = tmpStore();
  s.createRun(M(), { schemaVersion: 1, runId: 'r1', state: 'EXECUTING', currentStage: 'T1', stopAfter: 'T1', iteration: 1, revisionCount: 0, startedAt: 1 });
  assert.throws(() => s.appendVerdict({ runId: 'r1', stage: 'T1', iteration: 1, headCommit: 'c1' }));
  assert.throws(() => s.appendVerdict({ runId: 'r1', stage: 'T1', iteration: 'x', headCommit: 'c1', verdict: V('REVISE') }));
  assert.equal(s.listVerdicts('nope').length, 0); // 不存在的 run → 空（读取面宽容）
});

await ok('末行写一半容忍截断 / 中间坏行 fail loud', () => {
  const s = tmpStore();
  s.createRun(M(), { schemaVersion: 1, runId: 'r1', state: 'EXECUTING', currentStage: 'T1', stopAfter: 'T1', iteration: 1, revisionCount: 0, startedAt: 1 });
  s.appendVerdict({ runId: 'r1', stage: 'T1', iteration: 1, headCommit: 'c1', verdict: V('REVISE') });
  const f = path.join(s.root, 'runs', 'r1', 'verdicts.jsonl');
  fs.appendFileSync(f, '{"ts":999,"runId":"r1"'); // 写一半（无换行）
  assert.equal(s.listVerdicts('r1').length, 1); // 完整行保留，半行截断
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/}\n\{"ts":999[^\n]*$/, '}\n{BROKEN\n{"ts":999,"runId":"r1"}\n'));
  // 中间坏行 → StoreCorruptionError
  assert.throws(() => s.listVerdicts('r1'), (e) => e instanceof StoreCorruptionError);
});

await ok('重启后新实例读取完整历史', () => {
  const s = tmpStore();
  s.createRun(M(), { schemaVersion: 1, runId: 'r1', state: 'EXECUTING', currentStage: 'T1', stopAfter: 'T1', iteration: 1, revisionCount: 0, startedAt: 1 });
  s.appendVerdict({ runId: 'r1', stage: 'T1', iteration: 1, headCommit: 'c1', verdict: V('REVISE') });
  const s2 = new AuditStore(s.root);
  assert.equal(s2.listVerdicts('r1').length, 1);
  assert.equal(s2.listVerdicts('r1')[0].verdict.state, 'REVISE');
});

await ok('集成：完整场景裁决按序全量落盘', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-e2e-'));
  const store = new AuditStore(root);
  const { aborted, mismatch } = runAuditScenario({
    store,
    manifestInput: {
      runId: 'scn1', hostId: 'h1', cwd: '/w', repo: 'https://github.com/x/y.git',
      branch: 'main', stages: ['T1'], stopAfter: 'T1', startingCommit: 'base00',
      goal: 'g', approvedPlan: 'p',
    },
    executorScript: [
      { type: 'READY', head: 'c1', pushAll: [{ ok: true, tipMatches: true }] },
      { type: 'READY', head: 'c2', pushAll: [{ ok: true, tipMatches: true }] },
    ],
    auditorScript: [
      { type: 'REVISE', summary: ['修 X'], evidence: ['ev1'], p1: ['p1x'] },
      { type: 'APPROVE', summary: ['过'], evidence: ['ev2'] },
    ],
  });
  assert.equal(aborted, undefined);
  assert.equal(mismatch, undefined);
  const list = store.listVerdicts('scn1');
  assert.equal(list.length, 2);
  assert.equal(list[0].verdict.state, 'REVISE');
  assert.deepEqual(list[0].verdict.summary, ['修 X']);
  assert.equal(list[1].verdict.state, 'APPROVE');
  assert.equal(list[1].stage, 'T1');
  assert.equal(list[1].iteration, 2);
  assert.equal(list[1].headCommit, 'c2');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
