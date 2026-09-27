#!/usr/bin/env node
/**
 * audit/protocol.test.mjs — [DSH-AUDIT] 冻结协议解析器的针对性单元测试（纯 Node）。
 *
 *  G1 Protocol strict parsing：
 *  1. executor marker / auditor verdict 合法往返（prose 前缀、段落、HOST_ID 可选）；
 *  2. 缺必填键、非法 ITERATION、非法 STATE、重复键、空值 → 全部拒绝，绝不补默认；
 *  3. 无块 / 双块 / 段落后出现头段键 / 头段前未知键行 → 拒绝；
 *  4. prose 中的 "APPROVE" 不构成 verdict；
 *  5. validateIdentity 四元组 fail-closed；
 *  6. handoff 含 v0.3 REPO/BRANCH/TARGET_COMMIT。
 */
import assert from 'node:assert';
import {
  parseExecutorMarker, parseAuditorVerdict, validateIdentity,
  buildExecutorMarkerText, buildVerdictText, buildHandoff, MARKER_TAG,
} from '../../src/audit/protocol.js';
import { ProtocolParseError, IdentityMismatchError } from '../../src/audit/errors.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 4).join('\n  ')}`); });
const throws = (name, fn, code) => ok(name, () => fn().then(
  () => { throw new Error('expected throw'); },
  (e) => { assert.equal(e.code, code, `code ${e.code} != ${code}`); return true; },
));

const marker = (over = {}) => buildExecutorMarkerText({
  runId: 'audit_t1', stage: 'T1', iteration: 1, head: 'fke0001', ...over,
});
const verdict = (over = {}) => buildVerdictText({
  state: 'APPROVE', runId: 'audit_t1', stage: 'T1', iteration: 1, ...over,
});

// ---------- 1. 合法往返 ----------
await ok('executor marker roundtrip（prose 前缀 + 段落）', () => {
  const text = `I think the stage is done.\n\n${marker({ summary: ['impl X', 'add tests'], tests: ['18/18 PASS'] })}\n`;
  const m = parseExecutorMarker(text);
  assert.equal(m.state, 'READY_FOR_AUDIT');
  assert.equal(m.runId, 'audit_t1');
  assert.equal(m.stage, 'T1');
  assert.equal(m.iteration, 1);
  assert.equal(m.head, 'fke0001');
  assert.deepEqual(m.summary, ['impl X', 'add tests']);
  assert.deepEqual(m.tests, ['18/18 PASS']);
  assert.equal(m.hostId, null);
});

await ok('executor marker with HOST_ID', () => {
  const m = parseExecutorMarker(marker({ hostId: 'ubuntu-01' }));
  assert.equal(m.hostId, 'ubuntu-01');
});

await ok('verdict APPROVE/REVISE/NEED_USER 三态往返 + 段落', async () => {
  for (const st of ['APPROVE', 'REVISE', 'NEED_USER']) {
    const v = parseAuditorVerdict(verdict({
      state: st,
      summary: ['s'], evidence: ['e'], residualRisks: ['r'],
      p0: ['P0 item'], p1: ['P1 item'], testsRequired: ['test Y'],
      reason: ['冻结任务书冲突'], question: ['要改目标吗？'],
    }));
    assert.equal(v.state, st);
    assert.deepEqual(v.p0, ['P0 item']);
    assert.deepEqual(v.testsRequired, ['test Y']);
    assert.deepEqual(v.reason, ['冻结任务书冲突']);
  }
});

// ---------- 2. 结构非法 ----------
await throws('missing tag throws', async () => parseExecutorMarker('stage done, trust me'), 'AUDIT_PROTOCOL_PARSE');

await throws('double tag = ambiguous', async () => {
  await parseExecutorMarker(`${marker()}\n\n${marker()}`);
}, 'AUDIT_PROTOCOL_PARSE');

for (const key of ['RUN_ID', 'STAGE', 'ITERATION', 'HEAD']) {
  await throws(`missing required key ${key}`, async () => {
    const lines = marker().split('\n').filter((l) => !l.startsWith(`${key}:`));
    await parseExecutorMarker(lines.join('\n'));
  }, 'AUDIT_PROTOCOL_PARSE');
}

for (const bad of ['0', '02', '2x', 'two', '-1', '']) {
  await throws(`illegal ITERATION "${bad}"`, async () => {
    await parseExecutorMarker(marker({ iteration: bad }));
  }, 'AUDIT_PROTOCOL_PARSE');
}

await throws('executor STATE=APPROVE rejected', async () => {
  await parseExecutorMarker(marker().replace('STATE: READY_FOR_AUDIT', 'STATE: APPROVE'));
}, 'AUDIT_PROTOCOL_PARSE');

await throws('auditor STATE=READY_FOR_AUDIT rejected', async () => {
  await parseAuditorVerdict(verdict().replace('STATE: APPROVE', 'STATE: READY_FOR_AUDIT'));
}, 'AUDIT_PROTOCOL_PARSE');

await throws('duplicate header key', async () => {
  await parseExecutorMarker(`${marker()}\nSTAGE: T9`);
}, 'AUDIT_PROTOCOL_PARSE');

await throws('empty header value', async () => {
  await parseExecutorMarker(marker().replace('STAGE: T1', 'STAGE:'));
}, 'AUDIT_PROTOCOL_PARSE');

await throws('header key after sections', async () => {
  const text = marker({ summary: ['x'] }).replace('SUMMARY:', 'SUMMARY:').concat('\nRUN_ID: other');
  await parseExecutorMarker(text);
}, 'AUDIT_PROTOCOL_PARSE');

await throws('unknown key line before any section = stray', async () => {
  await parseExecutorMarker(`${MARKER_TAG}\nSTATE: READY_FOR_AUDIT\nRUN_ID: r\nSTAGE: T1\nITERATION: 1\nHEAD: h\nFOO: bar`);
}, 'AUDIT_PROTOCOL_PARSE');

await throws('missing all headers', async () => parseExecutorMarker(`${MARKER_TAG}\njust prose`), 'AUDIT_PROTOCOL_PARSE');

// ---------- 3. prose 不得推断 ----------
await throws('prose APPROVE is not a verdict', async () => {
  await parseAuditorVerdict('Everything looks great. I APPROVE this stage!');
}, 'AUDIT_PROTOCOL_PARSE');

await ok('SUMMARY 段落里的 "APPROVE:" 行只是段落内容', () => {
  // APPROVE 不是段落白名单键；出现在段落内部会被当作该段落的内容行 —— 不构成 verdict 状态。
  const v = verdict({ state: 'REVISE', p0: ['line', 'APPROVE: fake'] });
  const parsed = parseAuditorVerdict(v);
  assert.equal(parsed.state, 'REVISE');
  assert.ok(parsed.p0.includes('APPROVE: fake'));
});

// ---------- 4. 身份校验 ----------
await ok('identity all-match passes (incl. hostId)', () => {
  assert.equal(validateIdentity(
    { runId: 'r', stage: 'T1', iteration: 1, hostId: 'h1' },
    { runId: 'r', stage: 'T1', iteration: 1, hostId: 'h1' },
  ), true);
});

for (const [field, claimed] of [['RUN_ID', { runId: 'r2' }], ['STAGE', { stage: 'T9' }], ['ITERATION', { iteration: 2 }]]) {
  await throws(`identity mismatch on ${field}`, async () => {
    validateIdentity(
      { runId: 'r', stage: 'T1', iteration: 1 },
      { runId: 'r', stage: 'T1', iteration: 1, ...claimed },
    );
  }, 'AUDIT_IDENTITY_MISMATCH');
}

await ok('expected without hostId: comparison skipped (bare-call boundary; formal paths always pass hostId)', () => {
  // 边界文档化：只有直接调用 validateIdentity 且 expected 未带 hostId 时才跳过比较。
  // 正式路径（executorReady / auditorVerdict）的 expected.hostId 来自 manifest（必填），
  // 因此正式 marker/verdict 一律受 HOST_ID 约束 —— 见 state-machine 测试的 omitted 用例。
  assert.equal(validateIdentity(
    { runId: 'r', stage: 'T1', iteration: 1 },
    { runId: 'r', stage: 'T1', iteration: 1, hostId: 'whatever' },
  ), true);
});

await throws('hostId omitted while expected has one → HOST_ID mismatch (A1.1 P0-1 fail closed)', async () => {
  validateIdentity(
    { runId: 'r', stage: 'T1', iteration: 1, hostId: 'h1' },
    { runId: 'r', stage: 'T1', iteration: 1 }, // 无 hostId
  );
}, 'AUDIT_IDENTITY_MISMATCH');

await throws('hostId mismatch when both present', async () => {
  validateIdentity(
    { runId: 'r', stage: 'T1', iteration: 1, hostId: 'h1' },
    { runId: 'r', stage: 'T1', iteration: 1, hostId: 'h2' },
  );
}, 'AUDIT_IDENTITY_MISMATCH');

// ---------- 5. handoff（v0.3） ----------
await ok('handoff carries GitHub fact source', () => {
  const h = buildHandoff({
    runId: 'r', stage: 'T2', iteration: 1,
    repo: 'https://github.com/itsnone-liu/x.git', branch: 'main',
    targetCommit: 'def456', baseCommit: 'abc123',
    goal: ['g'], stageRequirements: ['s'], completed: ['T1 approved @ abc123'],
  });
  assert.ok(h.includes('REPO: https://github.com/itsnone-liu/x.git'));
  assert.ok(h.includes('BRANCH: main'));
  assert.ok(h.includes('TARGET_COMMIT: def456'));
  assert.ok(h.includes('inspect the GitHub repo at TARGET_COMMIT'));
  assert.ok(!h.includes('inspect the workspace'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
