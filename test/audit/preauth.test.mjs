#!/usr/bin/env node
/**
 * audit/preauth.test.mjs — [PREAUTH v1] P-A 批次测试：话术解析器 + PreauthStore（纯 Node）。
 *
 * 覆盖（PREAUTH_DESIGN.md §2 不变量在 P-A 可执行范围 + §4 话术）：
 *  - 两种话术正例逐字段解析；模板占位符填充 roundtrip（锁模板与正则逐字同步）；
 *  - 空白宽容（增/删/换行）正例；空白语义漂移（单元内插空白）拒绝；
 *  - 六类畸形话术拒绝：错 gateKind / 错 hash 长度 / 越权措辞改写 / 缺撤销句 /
 *    ordinal 缺失 / 空白语义漂移；另加非法日历、stage 自指失配、ordinal 0；
 *  - I1 单次消费（含重启后从盘）：append→findEligible→markConsumed→再消费抛错、
 *    findEligible 不再返回；
 *  - I4 过期/撤销：findEligible 不返回；markConsumed fail loud；revoke 幂等；
 *  - 存储损坏路径：末行截断容忍、中间坏行 fail loud（JSON 与 schema 两级）、
 *    跨行不可变字段篡改 / un-consume 篡改 fail loud；
 *  - append 输入校验（键集封闭、EXACT/CONSTRAINT 互斥字段、默认 24h 窗）。
 *
 * 惯例对齐 test/audit/store.test.mjs：ok()/throws()、mkdtemp、全离线。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PREAUTH_RE_EXACT, PREAUTH_RE_CONSTRAINT,
  PREAUTH_TEMPLATE_EXACT, PREAUTH_TEMPLATE_CONSTRAINT,
  parsePreauthText, PreauthParseError,
} from '../../src/audit/preauth-protocol.js';
import {
  PreauthStore, DEFAULT_PREAUTH_EXPIRY_MS,
  PreauthValidationError, PreauthNotFoundError,
  PreauthAlreadyConsumedError, PreauthRevokedError, PreauthExpiredError,
} from '../../src/audit/preauth-store.js';
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

const tmpStore = (now) => new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'preauth-')), now ? { now } : undefined);

// ---------- 话术夹具（硬编码自 §4 逐字模板，兼作模板常量漂移的独立防线） ----------

const ROOT = 'run_20260929_ab12cd';
const HASH64 = 'ab'.repeat(32);
const COMMIT40 = 'cd'.repeat(20);
const EXPIRES_ISO = '2026-09-30T12:00:00+08:00';
const EXPIRES_MS = Date.UTC(2026, 8, 30, 4, 0, 0); // 12:00+08:00 == 04:00Z

const EXACT_TEXT =
  '我预授权 SEAL_ANNOTATION_ONLY 于阶段 B4：仅当运行链 ' + ROOT + ' 在 ' + EXPIRES_ISO
  + ' 前到达该门且门位 receipt sha256 精确等于 ' + HASH64
  + ' 时放行一次；不授权其他 receipt、REVEAL、outcome 或 ordinal；可随时 /audit preauth revoke 撤销。';

const CT_TEXT =
  '我预授权 NEXT_REVEAL_ONLY 于阶段 C2：仅当本运行链 B4 已按规通过且其 SEAL receipt sha256 精确等于 '
  + HASH64 + '、C2 ordinal ≤ 1、且门位 receipt 等于提交 ' + COMMIT40
  + ' 内 .dsh/seal-receipt.json 的 blob 时放行一次；不授权其他阶段、receipt 或 ordinal；可随时 /audit preauth revoke 撤销。';

// ---------- 解析器：正例 ----------

await ok('EXACT 逐字话术逐字段解析', () => {
  const r = parsePreauthText(EXACT_TEXT);
  assert.equal(r.binding, 'EXACT');
  assert.equal(r.gateKind, 'SEAL_ANNOTATION_ONLY');
  assert.equal(r.stage, 'B4');
  assert.equal(r.receiptHash, HASH64);
  assert.equal(r.expiresAt, EXPIRES_MS);
  assert.deepEqual(r.runScope, { rootRunId: ROOT });
  assert.ok(!('constraints' in r), 'EXACT 不携带 constraints 键');
});

await ok('CONSTRAINT 逐字话术逐字段解析（constraints 深度断言）', () => {
  const r = parsePreauthText(CT_TEXT);
  assert.equal(r.binding, 'CONSTRAINT');
  assert.equal(r.gateKind, 'NEXT_REVEAL_ONLY');
  assert.equal(r.stage, 'C2');
  assert.deepEqual(r.constraints, {
    maxOrdinal: 1,
    upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: HASH64 }],
    receiptSource: { path: '.dsh/seal-receipt.json', commit: COMMIT40, fromCommitBlob: true },
  });
  assert.equal(r.expiresAt, null, '话术不含时间窗 → 登记时补默认');
  assert.deepEqual(r.runScope, { rootRunId: null }, '“本运行链” → 登记命令层绑定');
  assert.ok(!('receiptHash' in r), 'CONSTRAINT 不携带 receiptHash 键');
});

await ok('模板占位符填充 roundtrip：导出模板本身可解析（锁模板↔正则同步）', () => {
  const ex = parsePreauthText(PREAUTH_TEMPLATE_EXACT
    .replaceAll('<rootRunId>', ROOT)
    .replaceAll('<expiresAt>', EXPIRES_ISO)
    .replaceAll('<64hex>', HASH64));
  assert.equal(ex.binding, 'EXACT');
  assert.equal(ex.receiptHash, HASH64);

  const ct = parsePreauthText(PREAUTH_TEMPLATE_CONSTRAINT
    .replaceAll('<64hex>', HASH64)
    .replaceAll('<commit>', COMMIT40)
    .replaceAll('<path>', '.dsh/seal-receipt.json'));
  assert.equal(ct.binding, 'CONSTRAINT');
  assert.equal(ct.constraints.receiptSource.commit, COMMIT40);
});

await ok('空白宽容：折行/多空格/去空格均可解析且语义不变（EXACT）', () => {
  const wrapped = EXACT_TEXT
    .replace('我预授权', '我预授权\n')
    .replaceAll('；', '\n；\n\n')
    .replaceAll(' ', '  ');
  const r1 = parsePreauthText(`\n  ${wrapped}  \n`);
  const r2 = parsePreauthText(EXACT_TEXT.replaceAll(' ', ''));
  for (const r of [r1, r2]) {
    assert.equal(r.receiptHash, HASH64);
    assert.equal(r.runScope.rootRunId, ROOT);
    assert.equal(r.expiresAt, EXPIRES_MS);
  }
});

await ok('空白宽容：折行/去空格（CONSTRAINT）+ 大小写归一 + 全称上游 + 64hex commit', () => {
  const r0 = parsePreauthText(CT_TEXT.replaceAll(' ', ''));
  assert.equal(r0.constraints.maxOrdinal, 1);
  assert.equal(r0.constraints.upstream[0].receiptHash, HASH64);

  const full = CT_TEXT
    .replace('其 SEAL receipt', '其 seal_annotation_only receipt') // 大小写归一 + 上游全称
    .replace(COMMIT40, 'ef'.repeat(32)) // sha256 形态 commit
    .toUpperCase(); // 整体大写仍可解析（/i 对齐 SEAL_APPROVAL_RE 惯例）
  const r = parsePreauthText(full);
  assert.equal(r.gateKind, 'NEXT_REVEAL_ONLY');
  assert.deepEqual(r.constraints.upstream, [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: HASH64 }]);
  assert.equal(r.constraints.receiptSource.commit, 'ef'.repeat(32));
});

// ---------- 解析器：六类畸形拒绝 ----------

await throws('畸形1 错 gateKind：枚举外的标识符', () =>
  Promise.resolve().then(() => parsePreauthText(EXACT_TEXT.replace('SEAL_ANNOTATION_ONLY', 'APPROVE_ANYTHING'))),
'AUDIT_PREAUTH_PARSE');

await throws('畸形1 错 gateKind：非法标识符形态（连字符/中文）', () => Promise.resolve().then(() => {
  parsePreauthText(EXACT_TEXT.replace('SEAL_ANNOTATION_ONLY', 'seal-annotation-only'));
  parsePreauthText(EXACT_TEXT.replace('SEAL_ANNOTATION_ONLY', '随便批'));
}), 'AUDIT_PREAUTH_PARSE');

await throws('畸形2 错 hash 长度：63/65 hex', () => Promise.resolve().then(() => {
  parsePreauthText(EXACT_TEXT.replace(HASH64, HASH64.slice(1)));
  parsePreauthText(CT_TEXT.replace(HASH64, HASH64 + 'a'));
}), 'AUDIT_PREAUTH_PARSE');

await throws('畸形3 越权措辞改写：放行一次→放行多次 / 删除 REVEAL、outcome 限制', () => Promise.resolve().then(() => {
  parsePreauthText(EXACT_TEXT.replace('时放行一次', '时放行多次'));
  parsePreauthText(EXACT_TEXT.replace('不授权其他 receipt、REVEAL、outcome 或 ordinal', '不授权其他 receipt'));
}), 'AUDIT_PREAUTH_PARSE');

await throws('畸形3 越权措辞改写（CONSTRAINT）：弱化“不授权其他阶段”', () => Promise.resolve().then(() =>
  parsePreauthText(CT_TEXT.replace('不授权其他阶段、receipt 或 ordinal', '不授权其他 receipt 或 ordinal'))),
'AUDIT_PREAUTH_PARSE');

await throws('畸形4 缺撤销句', () => Promise.resolve().then(() => {
  parsePreauthText(EXACT_TEXT.replace('；可随时 /audit preauth revoke 撤销。', '。'));
  parsePreauthText(CT_TEXT.replace('；可随时 /audit preauth revoke 撤销。', '。'));
}), 'AUDIT_PREAUTH_PARSE');

await throws('畸形5 ordinal 缺失（CONSTRAINT 删除 ordinal 子句）', () => Promise.resolve().then(() =>
  parsePreauthText(CT_TEXT.replace(`C2 ordinal ≤ 1、`, ''))),
'AUDIT_PREAUTH_PARSE');

await throws('畸形6 空白语义漂移：hash 内断行 / gateKind 内插空格 / sha256 内插空格', () => Promise.resolve().then(() => {
  parsePreauthText(EXACT_TEXT.replace(HASH64, HASH64.slice(0, 32) + '\n' + HASH64.slice(32)));
  parsePreauthText(EXACT_TEXT.replace('SEAL_ANNOTATION_ONLY', 'SEAL_ANNOTATION_ ONLY'));
  parsePreauthText(EXACT_TEXT.replace('sha256', 'sha 256'));
}), 'AUDIT_PREAUTH_PARSE');

// ---------- 解析器：其他负例与错误形状 ----------

await throws('非法日历：02-30 / 25:00 / 无时区', () => Promise.resolve().then(() => {
  parsePreauthText(EXACT_TEXT.replace(EXPIRES_ISO, '2026-02-30T12:00:00+08:00'));
  parsePreauthText(EXACT_TEXT.replace(EXPIRES_ISO, '2026-09-30T25:00:00+08:00'));
  parsePreauthText(EXACT_TEXT.replace(EXPIRES_ISO, '2026-09-30 12:00:00')); // 缺显式时区
}), 'AUDIT_PREAUTH_PARSE');

await throws('CONSTRAINT stage 自指失配（C2 vs C9）', () => Promise.resolve().then(() =>
  parsePreauthText(CT_TEXT.replace('C2 ordinal ≤ 1', 'C9 ordinal ≤ 1'))),
'AUDIT_PREAUTH_PARSE');

await throws('maxOrdinal 0', () => Promise.resolve().then(() =>
  parsePreauthText(CT_TEXT.replace('≤ 1', '≤ 0'))),
'AUDIT_PREAUTH_PARSE');

await throws('非字符串 / 空白输入', () => Promise.resolve().then(() => {
  parsePreauthText(null);
  parsePreauthText('   \n  ');
}), 'AUDIT_PREAUTH_PARSE');

await ok('PreauthParseError 形状：code/template（可复制回显）/detail', () => {
  let e1 = null;
  try { parsePreauthText('我同意放行'); } catch (e) { e1 = e; }
  assert.ok(e1 instanceof PreauthParseError);
  assert.equal(e1.code, 'AUDIT_PREAUTH_PARSE');
  assert.equal(typeof e1.template, 'string');
  assert.ok(e1.template.length > 20, 'template 是可复制模板而非空串');
  assert.equal(e1.detail.reason, 'MISMATCH');

  let e2 = null;
  try { parsePreauthText(CT_TEXT.replace('≤ 1', '≤ 0')); } catch (e) { e2 = e; }
  assert.equal(e2.template, PREAUTH_TEMPLATE_CONSTRAINT, '按内容嗅探回显 CONSTRAINT 模板');
});

await ok('PREAUTH_RE_* 为锚定的多行宽容正则（结构性 sanity）', () => {
  assert.ok(PREAUTH_RE_EXACT.source.startsWith('^') && PREAUTH_RE_EXACT.source.endsWith('$'));
  assert.ok(PREAUTH_RE_CONSTRAINT.source.includes('\\s*'), '单元间 \\\\s* 连接');
  assert.ok(PREAUTH_RE_CONSTRAINT.flags.includes('i'));
});

// ---------- 存储：append / findEligible / I1 ----------

const FAR_FUTURE = 4102444800000; // 2100-01-01T00:00:00Z
const exactInput = (over = {}) => ({
  chatId: 'oc_test', messageRef: 'om_0001', humanText: EXACT_TEXT,
  binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4',
  receiptHash: HASH64, expiresAt: FAR_FUTURE,
  runScope: { rootRunId: ROOT }, ...over,
});
const constraintInput = (over = {}) => ({
  chatId: 'oc_test', messageRef: 'om_0002', humanText: CT_TEXT,
  binding: 'CONSTRAINT', gateKind: 'NEXT_REVEAL_ONLY', stage: 'C2',
  constraints: {
    maxOrdinal: 1,
    upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: HASH64 }],
    receiptSource: { path: '.dsh/seal-receipt.json', commit: COMMIT40, fromCommitBlob: true },
  },
  runScope: { rootRunId: ROOT }, ...over,
});
const consumeAs = (over = {}) => ({ runId: 'run_child_1', stage: 'B4', ordinal: 1, receiptHash: HASH64, ...over });

await ok('append：生成 preauthId/timestamps，单行 JSON 落盘且逐字段相等', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  assert.match(rec.preauthId, /^pa_[0-9]+_[0-9a-f]{8,}$/);
  assert.equal(rec.consumedAt, null);
  assert.equal(rec.consumedBy, null);
  assert.equal(rec.revokedAt, null);
  assert.equal(rec.taskPacketHash, null);
  assert.ok(Number.isFinite(rec.createdAt));
  assert.equal(rec.expiresAt, FAR_FUTURE);
  const file = path.join(s.root, 'preauth', 'records.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), rec);
});

await ok('append：两次生成不同 preauthId；解析产物可直接作为输入（EXACT）', () => {
  const s = tmpStore();
  const a = s.append(exactInput());
  const parsed = parsePreauthText(EXACT_TEXT);
  const b = s.append({ chatId: 'oc_t', messageRef: 'om_x', humanText: EXACT_TEXT, ...parsed });
  assert.notEqual(a.preauthId, b.preauthId);
  assert.equal(b.receiptHash, HASH64);
});

await ok('解析→append 全链路（CONSTRAINT）：默认 24h 窗 + 运行链绑定', () => {
  const NOW = 1780000000000;
  const s = tmpStore(() => NOW);
  const parsed = parsePreauthText(CT_TEXT);
  const rec = s.append({
    chatId: 'oc_t', messageRef: 'om_9', humanText: CT_TEXT, ...parsed,
    runScope: { rootRunId: 'root_9' },
  });
  assert.equal(rec.expiresAt, NOW + DEFAULT_PREAUTH_EXPIRY_MS);
  assert.deepEqual(rec.constraints, parsed.constraints);
  const hits = s.findEligible({ stage: 'C2', gateKind: 'NEXT_REVEAL_ONLY', rootRunId: 'root_9' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].preauthId, rec.preauthId);
});

await ok('append→findEligible→markConsumed：I1 再消费抛错且 findEligible 不再返回', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  const hits = s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].preauthId, rec.preauthId);

  const consumed = s.markConsumed(rec.preauthId, consumeAs());
  assert.ok(Number.isFinite(consumed.consumedAt));
  assert.deepEqual(consumed.consumedBy, consumeAs());
  assert.equal(s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT }).length, 0);
  assert.ok(s.list({ preauthId: rec.preauthId })[0].consumedAt != null);

  let threw = null;
  try { s.markConsumed(rec.preauthId, consumeAs()); } catch (e) { threw = e; }
  assert.ok(threw instanceof PreauthAlreadyConsumedError);
  assert.equal(threw.code, 'AUDIT_PREAUTH_CONSUMED');
});

await ok('I1 含重启后：新实例（同目录）再消费仍抛错、findEligible 仍排除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preauth-restart-'));
  const s1 = new PreauthStore(dir);
  const rec = s1.append(exactInput());
  s1.markConsumed(rec.preauthId, consumeAs());

  const s2 = new PreauthStore(dir); // 进程重启模拟
  assert.throws(() => s2.markConsumed(rec.preauthId, consumeAs()),
    (e) => e.code === 'AUDIT_PREAUTH_CONSUMED');
  assert.equal(s2.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT }).length, 0);
  assert.ok(s2.get(rec.preauthId).consumedAt != null);
});

await ok('I1 双消费竞争不留盘级损坏：消费行只出现一次', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  s.markConsumed(rec.preauthId, consumeAs());
  assert.throws(() => s.markConsumed(rec.preauthId, consumeAs({ ordinal: 2 })));
  const file = path.join(s.root, 'preauth', 'records.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); // 登记行 + 消费行；拒绝的再消费不落盘
  assert.equal(lines[1].consumedBy.ordinal, 1);
});

// ---------- 存储：I4 过期 / 撤销 ----------

await ok('过期：findEligible(now 越过 expiresAt) 不返回', () => {
  const s = tmpStore();
  s.append(exactInput());
  assert.equal(s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT, now: FAR_FUTURE + 1 }).length, 0);
  assert.equal(s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT, now: FAR_FUTURE - 1 }).length, 1);
});

await ok('过期：markConsumed 在过期后 fail loud（I4）', () => {
  let NOW = 1000;
  const s = tmpStore(() => NOW);
  const rec = s.append(exactInput({ expiresAt: 2000 }));
  NOW = 2500;
  assert.throws(() => s.markConsumed(rec.preauthId, consumeAs()),
    (e) => e instanceof PreauthExpiredError && e.code === 'AUDIT_PREAUTH_EXPIRED');
});

await ok('撤销：即时生效（findEligible 不返回）且 revoke 幂等不追加行', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  const r1 = s.revoke(rec.preauthId);
  assert.equal(r1.revoked, true);
  assert.ok(r1.record.revokedAt != null);
  assert.equal(s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT }).length, 0);

  const r2 = s.revoke(rec.preauthId); // 重复撤销幂等
  assert.equal(r2.revoked, false);
  assert.equal(r2.record.revokedAt, r1.record.revokedAt);
  const file = path.join(s.root, 'preauth', 'records.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2); // 无第三行
});

await ok('撤销后 markConsumed fail loud；未知 id revoke/markConsumed 报不存在', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  s.revoke(rec.preauthId);
  assert.throws(() => s.markConsumed(rec.preauthId, consumeAs()),
    (e) => e instanceof PreauthRevokedError && e.code === 'AUDIT_PREAUTH_REVOKED');
  assert.throws(() => s.revoke('pa_1_00000000'), (e) => e instanceof PreauthNotFoundError);
  assert.throws(() => s.markConsumed('pa_1_00000000', consumeAs()), (e) => e instanceof PreauthNotFoundError);
});

await ok('消费→撤销：三行归并（登记/消费/撤销），两状态并存且互不回退（重启后仍成立）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preauth-cr-'));
  const s1 = new PreauthStore(dir);
  const rec = s1.append(exactInput());
  s1.markConsumed(rec.preauthId, consumeAs());
  const rv = s1.revoke(rec.preauthId); // 撤销已消费记录：允许（I1 消费事实不回滚）
  assert.equal(rv.revoked, true);
  const file = path.join(dir, 'preauth', 'records.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);

  const s2 = new PreauthStore(dir); // 重启归并
  const r = s2.get(rec.preauthId);
  assert.ok(r.consumedAt != null && r.revokedAt != null);
  assert.deepEqual(r.consumedBy, consumeAs());
  assert.equal(s2.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT }).length, 0);
  assert.throws(() => s2.markConsumed(rec.preauthId, consumeAs()),
    (e) => e.code === 'AUDIT_PREAUTH_CONSUMED'); // I1 优先于一切
});

// ---------- 存储：findEligible 范围匹配（I3 存储侧） ----------

await ok('findEligible 只返回 stage+gateKind+rootRunId 全匹配的候选（按 createdAt 升序）', () => {
  const s = tmpStore(() => 5000);
  const a = s.append(exactInput()); // B4 / SEAL / ROOT @5000
  const b = s.append(exactInput({ stage: 'C5' })); // 不同 stage
  const c = s.append(exactInput({ gateKind: 'NEXT_REVEAL_ONLY' })); // 不同 gateKind
  const d = s.append(exactInput({ runScope: { rootRunId: 'run_OTHER' } })); // 不同运行链
  const e = s.append(constraintInput()); // C2 / NEXT_REVEAL / ROOT
  const hits = s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT });
  assert.deepEqual(hits.map((r) => r.preauthId), [a.preauthId]);
  const ctHits = s.findEligible({ stage: 'C2', gateKind: 'NEXT_REVEAL_ONLY', rootRunId: ROOT });
  assert.deepEqual(ctHits.map((r) => r.preauthId), [e.preauthId]);
  for (const other of [b, c, d]) {
    assert.ok(!hits.concat(ctHits).some((r) => r.preauthId === other.preauthId));
  }
  assert.throws(() => s.findEligible({ stage: 'B4' }), (err) => err instanceof PreauthValidationError);
});

await ok('list(filter) 子集匹配 / 谓词 / 全量', () => {
  const s = tmpStore();
  s.append(exactInput());
  s.append(constraintInput());
  assert.equal(s.list().length, 2);
  assert.equal(s.list({ binding: 'EXACT' }).length, 1);
  assert.equal(s.list((r) => r.stage === 'C2').length, 1);
  assert.equal(s.list({ binding: 'EXACT', stage: 'C2' }).length, 0);
});

// ---------- 存储：append 输入校验 ----------

await throws('append 输入校验：EXACT 携带 constraints / CONSTRAINT 携带 receiptHash', () => Promise.resolve().then(() => {
  const s = tmpStore();
  s.append(exactInput({ constraints: { maxOrdinal: 1, upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: HASH64 }], receiptSource: { path: 'x', commit: COMMIT40, fromCommitBlob: true } } }));
}), 'AUDIT_PREAUTH_INVALID');

await throws('append 输入校验：CONSTRAINT 带 receiptHash 被拒', () => {
  const s = tmpStore();
  return Promise.resolve().then(() => s.append(constraintInput({ receiptHash: HASH64 })));
}, 'AUDIT_PREAUTH_INVALID');

for (const [name, base, mutate] of [
  ['坏 hash（63hex）', exactInput, (i) => { i.receiptHash = HASH64.slice(1); }],
  ['upstream 缺失', constraintInput, (i) => { delete i.constraints.upstream; }],
  ['receiptSource 坏 commit', constraintInput, (i) => { i.constraints.receiptSource.commit = 'zz'; }],
  ['缺 runScope.rootRunId', exactInput, (i) => { delete i.runScope.rootRunId; }],
  ['缺 humanText 溯源锚点', exactInput, (i) => { delete i.humanText; }],
  ['caller 自带 preauthId', exactInput, (i) => { i.preauthId = 'pa_1_deadbeef'; }],
  ['fresh 记录带 consumedAt', exactInput, (i) => { i.consumedAt = 123; }],
  ['expiresAt 早于当前时刻', exactInput, (i) => { i.expiresAt = 1; }],
  ['未知输入键', exactInput, (i) => { i.whoever = 'executor'; }],
]) {
  await throws(`append 输入校验：${name}`, () => {
    const s = tmpStore(() => 1000);
    const input = base();
    mutate(input);
    return Promise.resolve().then(() => s.append(input));
  }, 'AUDIT_PREAUTH_INVALID');
}

await throws('consumedBy 形状校验（缺 runId / ordinal 0 / 坏 hash）', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  return Promise.resolve().then(() => {
    s.markConsumed(rec.preauthId, { stage: 'B4', ordinal: 1, receiptHash: HASH64 });
    s.markConsumed(rec.preauthId, consumeAs({ ordinal: 0 }));
    s.markConsumed(rec.preauthId, consumeAs({ receiptHash: 'XY'.repeat(32) }));
  });
}, 'AUDIT_PREAUTH_INVALID');

// ---------- 存储：损坏路径（对齐 store.js verdicts 语义） ----------

await ok('末行截断容忍：写一半 crash 尾行被丢弃，list 正常', () => {
  const s = tmpStore();
  s.append(exactInput());
  s.append(exactInput({ stage: 'C5', messageRef: 'om_0003' }));
  fs.appendFileSync(path.join(s.root, 'preauth', 'records.jsonl'), '{"preauthId":"pa_9');
  assert.equal(s.list().length, 2);
  const hits = s.findEligible({ stage: 'C5', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT });
  assert.equal(hits.length, 1); // 截断行之后的存量记录不受影响
});

await throws('中间坏行（非 JSON）fail loud', () => {
  const s = tmpStore();
  s.append(exactInput());
  fs.appendFileSync(path.join(s.root, 'preauth', 'records.jsonl'), 'NOT JSON\n');
  s.append(exactInput({ stage: 'C5', messageRef: 'om_0003' }));
  return Promise.resolve().then(() => s.list());
}, 'AUDIT_STORE_CORRUPTION');

await throws('中间坏行（JSON 合法但 schema 非法）fail loud', () => {
  const s = tmpStore();
  s.append(exactInput());
  fs.appendFileSync(path.join(s.root, 'preauth', 'records.jsonl'), `${JSON.stringify({ hello: 'world' })}\n`);
  return Promise.resolve().then(() => s.list());
}, 'AUDIT_STORE_CORRUPTION');

await throws('跨行不可变字段篡改（改 receiptHash）fail loud', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  const tampered = { ...rec, receiptHash: 'ff'.repeat(32) };
  fs.appendFileSync(path.join(s.root, 'preauth', 'records.jsonl'), `${JSON.stringify(tampered)}\n`);
  return Promise.resolve().then(() => s.list());
}, 'AUDIT_STORE_CORRUPTION');

await throws('un-consume 篡改（消费后又出现无 consumedAt 的行）fail loud', () => {
  const s = tmpStore();
  const rec = s.append(exactInput());
  s.markConsumed(rec.preauthId, consumeAs());
  const unConsumed = { ...rec, consumedAt: null, consumedBy: null };
  fs.appendFileSync(path.join(s.root, 'preauth', 'records.jsonl'), `${JSON.stringify(unConsumed)}\n`);
  return Promise.resolve().then(() => s.list());
}, 'AUDIT_STORE_CORRUPTION');

await ok('空目录 / 无文件：list 与 findEligible 返回空', () => {
  const s = tmpStore();
  assert.deepEqual(s.list(), []);
  assert.deepEqual(s.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: ROOT }), []);
  assert.equal(s.get('pa_0_00000000'), null);
});

await ok('G10：落盘内容不含凭据类字段', () => {
  const s = tmpStore();
  s.append(exactInput());
  s.markConsumed(s.list()[0].preauthId, consumeAs());
  const text = fs.readFileSync(path.join(s.root, 'preauth', 'records.jsonl'), 'utf8').toLowerCase();
  for (const kw of ['cookie', 'secret', 'oauth', 'password', 'bearer', 'access_token', 'api_key']) {
    assert.ok(!text.includes(kw), `records.jsonl contains "${kw}"`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
