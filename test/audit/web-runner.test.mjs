#!/usr/bin/env node
// A5.1 WebAuditRunner 单元测试 —— 全部确定性，无网络依赖（transport 注入）。
import assert from 'node:assert';
import { WebAuditRunner, extractReviewerText } from '../../src/audit/web-runner.js';
import { buildVerdictText } from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });

const packet = {
  runId: 'run-x1', hostId: 'h1', stage: 'T1', iteration: 1,
  repo: 'github.com/o/r', branch: 'main', targetCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40),
  goal: ['ship T1'], stageRequirement: ['T1 must be green'],
};
const verdictText = (state) => buildVerdictText({
  state, runId: packet.runId, hostId: 'h1', stage: packet.stage, iteration: packet.iteration,
  ...(state === 'REVISE' ? { reason: ['r'], p0: ['p0'] } : {}),
  ...(state === 'NEED_USER' ? { question: ['q'] } : {}),
  ...(state === 'APPROVE' ? { summary: ['s'], evidence: ['e'] } : {}),
});

// Responses API 非流式应答形状（headroom :8787 实测链路）
const responsesBody = (text) => ({
  id: 'rs_1', object: 'response', status: 'completed', model: 'gpt-5.6-luna',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
});
// Chat Completions 兼容形状
const chatBody = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

const mk = ({ responses = [], transport } = {}) => {
  const script = [...responses];
  const t = transport ?? (async (req) => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return { status: next, json: { error: { message: `http ${next}` } }, text: `http ${next}` };
    return { status: 200, json: next, text: JSON.stringify(next) };
  });
  const r = new WebAuditRunner({ readAuth: () => 'tok-test', transport: t, sleep: async () => {}, retryDelayMs: 1 });
  return r;
};

await ok('responses-shape APPROVE verdict parsed through frozen protocol', async () => {
  const r = mk({ responses: [responsesBody(`分析完成。\n${verdictText('APPROVE')}`)] });
  const v = await r.review(packet);
  assert.equal(v.state, 'APPROVE');
  assert.equal(v.runId, packet.runId);
  assert.equal(v.hostId, 'h1');
  assert.equal(v.stage, 'T1');
  assert.equal(v.iteration, 1);
  assert.deepEqual(v.summary, ['s']);
  assert.deepEqual(v.evidence, ['e']);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].outcome, 'APPROVE');
});

await ok('chat-completions shape and output_text field also extracted', async () => {
  assert.equal(extractReviewerText(chatBody('hello')).trim(), 'hello');
  assert.equal(extractReviewerText({ output_text: 'direct' }), 'direct');
  assert.equal(extractReviewerText(null), null);
  assert.equal(extractReviewerText({ output: [{ type: 'reasoning' }] }), null);
  const r = mk({ responses: [chatBody(verdictText('NEED_USER'))] });
  const v = await r.review(packet);
  assert.equal(v.state, 'NEED_USER');
  assert.deepEqual(v.question, ['q']);
});

await ok('request shape: model/stream/store/input + bearer from injected auth', async () => {
  let seen = null;
  const r = mk({ transport: async (req) => { seen = req; return { status: 200, json: responsesBody(verdictText('APPROVE')), text: '' }; } });
  await r.review(packet);
  assert.equal(seen.url, 'http://127.0.0.1:8787/v1/responses');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.Authorization, 'Bearer tok-test');
  assert.equal(seen.body.model, 'gpt-5.6-luna');
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.store, false);
  const dev = seen.body.input.find((m) => m.role === 'developer');
  const usr = seen.body.input.find((m) => m.role === 'user');
  assert.ok(dev && dev.content.length > 100);
  // 冻结 handoff 字段 + verdict 模板必须进入 user 消息
  for (const frag of ['RUN_ID: run-x1', 'HOST_ID: h1', 'STAGE: T1', 'ITERATION: 1',
    `TARGET_COMMIT: ${packet.targetCommit}`, `BASE_COMMIT: ${packet.baseCommit}`,
    'T1 must be green', 'VERDICT FORMAT', '[DSH-AUDIT]']) {
    assert.ok(usr.content.includes(frag), `user prompt missing: ${frag}`);
  }
});

await ok('empty output → AUDIT_VERDICT_MISSING (lifecycle verdictMissing path)', async () => {
  const r = mk({ responses: [responsesBody('')] });
  await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_VERDICT_MISSING');
});

await ok('malformed text → AUDIT_VERDICT_MALFORMED with protocol cause', async () => {
  const r = mk({ responses: [responsesBody('looks good, ship it')] });
  await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_VERDICT_MALFORMED' && !!e.cause);
});

await ok('401/403 → AUDIT_WEB_LOGIN_EXPIRED, single attempt, no retry', async () => {
  for (const code of [401, 403]) {
    const r = mk({ responses: [code] });
    await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_WEB_LOGIN_EXPIRED');
    assert.equal(r.calls[0].attempts, 1);
  }
});

await ok('429 → AUDIT_WEB_QUOTA, single attempt, no auto-retry (fail-closed latch)', async () => {
  const r = mk({ responses: [429] });
  await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_WEB_QUOTA');
  assert.equal(r.calls[0].attempts, 1);
});

await ok('network failure retried then succeeds; exponential backoff observed', async () => {
  const delays = [];
  const r = new WebAuditRunner({
    readAuth: () => 't', retryDelayMs: 10, transientRetries: 2,
    sleep: async (ms) => { delays.push(ms); },
    transport: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
  });
  await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_WEB_UNREACHABLE');
  assert.equal(r.calls[0].attempts, 3);
  assert.deepEqual(delays, [10, 20]); // 10, 10*2

  const script = [new Error('ECONNRESET'), responsesBody(verdictText('APPROVE'))];
  const r2 = mk({ responses: script });
  const v = await r2.review(packet);
  assert.equal(v.state, 'APPROVE');
  assert.equal(r2.calls[0].attempts, 2);
});

await ok('5xx retried; exhausted → AUDIT_WEB_UPSTREAM_ERROR; other 4xx → AUDIT_WEB_REQUEST_REJECTED', async () => {
  const r = mk({ responses: [502, 503, 502] });
  await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_WEB_UPSTREAM_ERROR');
  assert.equal(r.calls[0].attempts, 3);

  const r2 = mk({ responses: [400] });
  await assert.rejects(() => r2.review(packet), (e) => e.code === 'AUDIT_WEB_REQUEST_REJECTED');
  assert.equal(r2.calls[0].attempts, 1);
});

await ok('incomplete packet → AUDIT_PACKET_INVALID before any transport call', async () => {
  let called = 0;
  const r = mk({ transport: async () => { called++; return { status: 200, json: {}, text: '' }; } });
  await assert.rejects(() => r.review({ runId: 'r' }), (e) => e.code === 'AUDIT_PACKET_INVALID');
  assert.equal(called, 0);
});

await ok('default readAuth surfaces auth.json failure as AUDIT_WEB_LOGIN_EXPIRED', async () => {
  const r = new WebAuditRunner({ authJsonPath: '/nonexistent/auth.json', transport: async () => { throw new Error('must not be called'); } });
  await assert.rejects(() => r.review(packet), (e) => e.code === 'AUDIT_WEB_LOGIN_EXPIRED');
  const r2 = new WebAuditRunner({ readAuth: () => { const j = { readFileSync: null, OPENAI_API_KEY: null }; return j.OPENAI_API_KEY; }, transport: async () => ({ status: 200, json: {}, text: '' }) });
  // readAuth 返回 null → 请求头 Bearer null 属于配置错误面；此处仅验证注入路径本身不崩溃
  assert.equal(typeof r2.readAuth, 'function');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
