#!/usr/bin/env node
/**
 * audit/store.test.mjs — AuditStore 持久化与恢复测试（纯 Node）。
 *
 *  - 正常 roundtrip / 重复 runId / 事件幂等 / 必填字段校验 / tokens=null；
 *  - .tmp 残留、manifest/state 损坏（fail loud）、events 末行不完整（容忍）/ 中间坏行（fail loud）；
 *  - runs.json 损坏、多 run 隔离、G10 无凭据落盘断言；
 *  - A1.1 P0-3：manifest schema 校验（createRun 存前 + loadRun 读后）、state 结构/枚举/
 *    一致性校验、events 逐行必填结构校验、NEXT_STAGE 瞬态豁免。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { StoreCorruptionError } from '../../src/audit/errors.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 4).join('\n  ')}`); });
const throws = (name, fn, code) => ok(name, () => Promise.resolve().then(fn).then(
  () => { throw new Error('expected throw'); },
  (e) => { assert.equal(e.code, code, `code ${e.code} != ${code}`); return true; },
));

const tmpStore = () => new AuditStore(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-')));

/** 合法完整 manifest（持久化形态：含 schemaVersion，与 AuditRun.create 传入的 createManifest 产物一致）。 */
const M = (over = {}) => ({
  schemaVersion: 1,
  runId: 'r1', hostId: 'h1', cwd: '/w', repo: 'https://github.com/x/y.git', branch: 'main',
  stages: ['T1', 'T2'], stopAfter: 'T2', startingCommit: 'base00', goal: 'g', approvedPlan: 'p',
  createdAt: 1, updatedAt: 1,
  ...over,
});
/** 合法持久化 state。 */
const S = (over = {}) => ({
  schemaVersion: 1, runId: 'r1', state: 'EXECUTING', currentStage: 'T1', stopAfter: 'T2',
  iteration: 1, revisionCount: 0, startedAt: 1000, ...over,
});

const baseEvent = (runId, dedupeKey, over = {}) => ({
  runId, stage: 'T1', iteration: 1, headCommit: 'fke0001', event: 'AUDIT_STARTED',
  timestamp: 1000, elapsedMs: 10, tokens: null, dedupeKey, ...over,
});

await ok('createRun + loadRun roundtrip', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  s.appendEvent(baseEvent('r1', 'k1'));
  const loaded = s.loadRun('r1');
  assert.equal(loaded.manifest.runId, 'r1');
  assert.equal(loaded.state.state, 'EXECUTING');
  assert.equal(loaded.events.length, 1);
  assert.ok(loaded.seenKeys.has('k1'));
});

await throws('duplicate runId rejected', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  return Promise.resolve().then(() => s.createRun(M(), S()));
}, 'AUDIT_RUN_EXISTS');

// ---------- A1.1 P0-3：存前/读后 schema 校验 ----------
await throws('createRun rejects manifest missing repo (schema, not just JSON)', () => {
  const s = tmpStore();
  const { repo, ...noRepo } = M();
  return Promise.resolve().then(() => s.createRun(noRepo, S()));
}, 'AUDIT_MANIFEST_INVALID');

await throws('createRun rejects illegal state', () => {
  const s = tmpStore();
  return Promise.resolve().then(() => s.createRun(M(), S({ state: 'VIBING' })));
}, 'AUDIT_STORE_CORRUPTION');

await throws('createRun rejects iteration 0', () => {
  const s = tmpStore();
  return Promise.resolve().then(() => s.createRun(M(), S({ iteration: 0 })));
}, 'AUDIT_STORE_CORRUPTION');

await ok('loadRun rejects structurally-invalid manifest (missing stages) even though JSON is legal', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete m.stages; // 语法合法、结构非法
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  assert.throws(() => s.loadRun('r1'), (e) => e.code === 'AUDIT_STORE_CORRUPTION');
});

await ok('loadRun rejects unknown persisted state name', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'state.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.state = 'PAUSED_FOR_COFFEE';
  fs.writeFileSync(file, `${JSON.stringify(st, null, 2)}\n`);
  assert.throws(() => s.loadRun('r1'), (e) => e.code === 'AUDIT_STORE_CORRUPTION');
});

await ok('loadRun rejects runId mismatch across dir/manifest/state', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'state.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.runId = 'OTHER';
  fs.writeFileSync(file, `${JSON.stringify(st, null, 2)}\n`);
  assert.throws(() => s.loadRun('r1'), (e) => e.code === 'AUDIT_STORE_CORRUPTION'
    && /runId mismatch/.test(e.message));
});

await ok('loadRun rejects manifest/state currentStage divergence in steady states', () => {
  const s = tmpStore();
  s.createRun(M(), S()); // manifest.currentStage = T1
  const file = path.join(s.root, 'runs', 'r1', 'state.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.currentStage = 'T2'; // 与 manifest 分歧，且 state 不是 NEXT_STAGE
  fs.writeFileSync(file, `${JSON.stringify(st, null, 2)}\n`);
  assert.throws(() => s.loadRun('r1'), (e) => e.code === 'AUDIT_STORE_CORRUPTION'
    && /currentStage/.test(e.message));
});

await ok('loadRun tolerates currentStage divergence ONLY for NEXT_STAGE (mid-advance window)', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'state.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.state = 'NEXT_STAGE'; // 瞬态：manifest 可能领先，由 recoverTransientState 收敛
  fs.writeFileSync(file, `${JSON.stringify(st, null, 2)}\n`);
  const loaded = s.loadRun('r1'); // 不抛
  assert.equal(loaded.state.state, 'NEXT_STAGE');
});

await ok('NEXT_STAGE window: manifest.currentStage may only be same or immediate next (A1.2-5)', () => {
  const s = tmpStore();
  s.createRun(M({ stages: ['T1', 'T2', 'T3'], stopAfter: 'T3' }), S());
  const sfile = path.join(s.root, 'runs', 'r1', 'state.json');
  const st = JSON.parse(fs.readFileSync(sfile, 'utf8'));
  st.state = 'NEXT_STAGE';
  fs.writeFileSync(sfile, `${JSON.stringify(st, null, 2)}\n`);

  // immediate next（T2）：放行 —— 推进已完成 manifest 写、未完成 state 写的窗口
  const mfile = path.join(s.root, 'runs', 'r1', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  fs.writeFileSync(mfile, `${JSON.stringify({ ...m, currentStage: 'T2' }, null, 2)}\n`);
  assert.equal(s.loadRun('r1').manifest.currentStage, 'T2');

  // 非相邻（T3）：拒绝 —— 任意其他分歧视为外部篡改
  fs.writeFileSync(mfile, `${JSON.stringify({ ...m, currentStage: 'T3' }, null, 2)}\n`);
  assert.throws(() => s.loadRun('r1'), (e) => e.code === 'AUDIT_STORE_CORRUPTION'
    && /NEXT_STAGE window/.test(e.message));
});

await ok('loadRun validates every event line schema (not just JSON parse)', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'events.jsonl');
  fs.appendFileSync(file, `${JSON.stringify({ runId: 'r1', event: 'X', timestamp: 1 })}\n`); // 缺 stage/iteration/headCommit/elapsedMs/dedupeKey
  assert.throws(() => s.loadRun('r1'), (e) => e.code === 'AUDIT_STORE_CORRUPTION'
    && /event schema/.test(e.message));
});

// ---------- 事件 ----------
await ok('appendEvent idempotent on same dedupeKey', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const r1 = s.appendEvent(baseEvent('r1', 'k1', { event: 'AUDIT_STARTED' }));
  const r2 = s.appendEvent(baseEvent('r1', 'k1', { event: 'AUDIT_STARTED', timestamp: 9999 }));
  assert.equal(r1.appended, true);
  assert.equal(r2.appended, false);
  const lines = fs.readFileSync(path.join(s.root, 'runs', 'r1', 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).timestamp, 1000); // 第一次的写入保留，第二次被吞
});

await ok('repeatSeq keys are distinct events', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  assert.equal(s.appendEvent(baseEvent('r1', 'k#1')).appended, true);
  assert.equal(s.appendEvent(baseEvent('r1', 'k#2')).appended, true);
  assert.equal(s.appendEvent(baseEvent('r1', 'k#1')).appended, false);
});

for (const f of ['runId', 'stage', 'iteration', 'headCommit', 'event', 'timestamp', 'elapsedMs', 'dedupeKey']) {
  await throws(`event missing field ${f} rejected`, () => {
    const s = tmpStore();
    s.createRun(M(), S());
    const e = baseEvent('r1', 'k1'); delete e[f];
    return Promise.resolve().then(() => s.appendEvent(e));
  }, 'AUDIT_EVENT_INVALID');
}

await ok('tokens:null is legal (explicit structured empty)', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  assert.equal(s.appendEvent(baseEvent('r1', 'k1', { tokens: null })).appended, true);
});

// ---------- 损坏路径 ----------
await ok('.tmp leftover swept; main file wins', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  fs.writeFileSync(path.join(s.root, 'runs', 'r1', 'state.json.tmp'), '{"runId": "BROKEN"');
  const loaded = s.loadRun('r1');
  assert.equal(loaded.state.runId, 'r1');
  assert.ok(!fs.existsSync(path.join(s.root, 'runs', 'r1', 'state.json.tmp')));
});

await throws('manifest.json corrupt → fail loud', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  fs.writeFileSync(path.join(s.root, 'runs', 'r1', 'manifest.json'), '{ broken');
  return Promise.resolve().then(() => s.loadRun('r1'));
}, 'AUDIT_STORE_CORRUPTION');

await throws('state.json null → fail loud (structure check)', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  fs.writeFileSync(path.join(s.root, 'runs', 'r1', 'state.json'), 'null');
  return Promise.resolve().then(() => s.loadRun('r1'));
}, 'AUDIT_STORE_CORRUPTION');

await ok('events trailing partial line tolerated + truncated flag', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'events.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(baseEvent('r1', 'k1'))}\n`);
  fs.appendFileSync(file, '{"runId":"r1","event":"AUDIT_STA'); // 写一半 crash
  const loaded = s.loadRun('r1');
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.eventsTruncated, true);
});

await throws('events corrupt middle line → fail loud', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  const file = path.join(s.root, 'runs', 'r1', 'events.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(baseEvent('r1', 'k1'))}\n`);
  fs.appendFileSync(file, 'NOT JSON\n');
  fs.appendFileSync(file, `${JSON.stringify(baseEvent('r1', 'k2'))}\n`);
  return Promise.resolve().then(() => s.loadRun('r1'));
}, 'AUDIT_STORE_CORRUPTION');

await throws('runs.json corrupt → listRuns fail loud', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  fs.writeFileSync(path.join(s.root, 'runs.json'), 'nope');
  return Promise.resolve().then(() => s.listRuns());
}, 'AUDIT_STORE_CORRUPTION');

// ---------- 隔离与凭据 ----------
await ok('multi-run isolation: events and dedupe sets separate', () => {
  const s = tmpStore();
  s.createRun(M({ runId: 'a' }), S({ runId: 'a' }));
  s.createRun(M({ runId: 'b' }), S({ runId: 'b' }));
  s.appendEvent(baseEvent('a', 'shared-key'));
  s.appendEvent(baseEvent('b', 'shared-key')); // 同 key 不同 run：不得被 a 的 seen 吞掉
  const la = s.loadRun('a'); const lb = s.loadRun('b');
  assert.equal(la.events.length, 1);
  assert.equal(lb.events.length, 1);
  assert.notEqual(la.events[0].runId, lb.events[0].runId, 'same runId?!');
});

await ok('seenKeys rebuilt from events.jsonl on reload (dedupe survives restart)', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  s.appendEvent(baseEvent('r1', 'k1'));
  const s2 = new AuditStore(s.root); // 新实例 = 进程重启
  const r = s2.appendEvent(baseEvent('r1', 'k1'));
  assert.equal(r.appended, false);
});

await ok('G10: no credentials persisted anywhere', () => {
  const s = tmpStore();
  s.createRun(M(), S());
  s.appendEvent(baseEvent('r1', 'k1'));
  s.updateIndex('r1', { state: 'EXECUTING' });
  const files = ['runs.json', 'runs/r1/manifest.json', 'runs/r1/state.json', 'runs/r1/events.jsonl'];
  // 注意：协议自身的 "tokens"（额度统计字段）是合法字段，不在敏感词之列。
  const secrets = ['cookie', 'secret', 'oauth', 'password', 'bearer',
    'cf_clearance', 'access_token', 'refresh_token', 'api_key', 'sessionstorage'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(s.root, f), 'utf8').toLowerCase();
    for (const kw of secrets) {
      assert.ok(!text.includes(kw), `${f} contains "${kw}"`);
    }
  }
});

await ok('loadRun returns null for unknown run', () => {
  const s = tmpStore();
  assert.equal(s.loadRun('ghost'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
