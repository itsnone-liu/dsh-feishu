#!/usr/bin/env node
/**
 * autocontinue.test.mjs — 额度自动继续模块的针对性单元测试（纯 Node）。
 *
 *  1. classifyFailure：quota 长等待 / 瞬时限流 / 无关错误三类。
 *  2. parseRetryHint：retry-after 时长、ISO 时刻、HH:MM 时刻、无提示。
 *  3. AutoContinue 全流程：quota 错误 → 等待卡 → 到点补发「继续」→
 *     回合成功 → 恢复卡，watcher 清空。
 *  4. 用户消息接管：cancelForChat 清 watcher、不再补发。
 *  5. 等待期间非额度错误 → 放弃卡。
 *  6. 瞬时限流：指数退避、超过 shortMax 放弃。
 *  7. inspect_image 的 attachment 参数：readImage 优先、裸 id 直读回退。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, parseRetryHint, AutoContinue } from '../src/autocontinue.js';
import { attachmentDataUrl, resolveVisionConfig } from '../src/vision-tool.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.log(`FAIL ${name}: ${e?.stack ?? e}`); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- 1 分类
await ok('classifyFailure: quota → long', () => {
  assert.equal(classifyFailure('Prompts quota exhausted, will reset'), 'long');
  assert.equal(classifyFailure('当前 API 免费额度已用完'), 'long');
  assert.equal(classifyFailure('Insufficient balance'), 'long');
  assert.equal(classifyFailure('配额不足'), 'long');
});
await ok('classifyFailure: transient → short', () => {
  assert.equal(classifyFailure('HTTP 429 too many requests'), 'short');
  assert.equal(classifyFailure('当前API上游负载已饱和，请稍后重试'), 'short');
  assert.equal(classifyFailure('rate limit reached'), 'short');
});
await ok('classifyFailure: unrelated → null', () => {
  assert.equal(classifyFailure('no credential for provider'), null);
  assert.equal(classifyFailure(''), null);
  assert.equal(classifyFailure('connection reset by peer'), null);
});
await ok('classifyFailure: extra patterns honored', () => {
  assert.equal(classifyFailure('MYPLAN.EXPIRED today', ['myplan\\.expired']), 'long');
});

// ------------------------------------------------------------- 2 提示解析
await ok('parseRetryHint: retry after duration', () => {
  assert.deepEqual(parseRetryHint('please try again in 30s'), { inMs: 30_000 });
  assert.deepEqual(parseRetryHint('retry after 2 min'), { inMs: 120_000 });
});
await ok('parseRetryHint: absolute time', () => {
  const h = parseRetryHint('will reset at 2026-08-25 20:00 (UTC+8)');
  assert.ok(h?.at && h.at instanceof Date);
});
await ok('parseRetryHint: HH:MM rolls to tomorrow when past', () => {
  const h = parseRetryHint('额度将在 00:05 重置');
  assert.ok(h?.at);
  assert.ok(h.at.getTime() > Date.now());
});
await ok('parseRetryHint: none', () => {
  assert.equal(parseRetryHint('just failed'), null);
});

// -------------------------------------------------- 3 AutoContinue harness
function harness(cfgOver = {}) {
  const cards = [];
  const submitted = [];
  const cfg = {
    autoContinue: true,
    autoContinueMessage: '继续',
    autoContinueFirstMs: 150,
    autoContinuePollMs: 300,
    autoContinueMaxMs: 5_000,
    autoContinueShortMax: 2,
    autoContinuePatterns: [],
    ...cfgOver,
  };
  const agent = {
    id: 'session-test',
    status: 'idle',
    followup(m) { submitted.push(m); this.status = 'idle'; },
    steer(m) { submitted.push(m); },
  };
  const driver = {
    live: new Map([['session-test', { agent }]]),
    submit(a, text) {
      const msg = { content: [{ type: 'text', text }] };
      a.followup(msg);
      return 'followup';
    },
  };
  const renderer = { chatOf: (id) => (id === 'session-test' ? 'chat-1' : null) };
  const transport = {
    async sendCard(_c, card) { cards.push(card); return { messageId: `m${cards.length}` }; },
  };
  const ac = new AutoContinue({ config: cfg, driver, renderer, transport });
  const turnEnd = (reason) => ac.onEvent({ id: 'session-test' }, { type: 'turn/end', data: { reason } });
  return { ac, cards, submitted, agent, turnEnd };
}

await ok('quota error → wait card → auto continue → success card', async () => {
  const { ac, cards, submitted, turnEnd } = harness();
  turnEnd({ kind: 'error', error: { code: '429', message: 'Prompts quota used up (额度已用完)' } });
  assert.equal(cards.length, 1, 'exactly one wait card');
  assert.match(cards[0].header.title.content, /自动等待/);
  assert.equal(submitted.length, 0);
  await sleep(400); // firstMs=150ms fires, fake turn completes
  turnEnd({ kind: 'completed' });
  assert.equal(submitted.length, 1, 'auto continue submitted once');
  const text = submitted[0].content.map((b) => b.text).join('');
  assert.match(text, /继续/);
  assert.equal(cards.length, 2, 'success card sent');
  assert.match(cards[1].header.title.content, /已自动恢复/);
  assert.equal(ac.watchers.size, 0, 'watcher cleared');
  ac.dispose();
});

await ok('user takeover cancels the watcher', async () => {
  const { ac, cards, submitted, turnEnd } = harness();
  turnEnd({ kind: 'error', error: { code: '429', message: 'Prompts quota used up' } });
  ac.cancelForChat('chat-1');
  assert.equal(ac.watchers.size, 0);
  await sleep(400);
  assert.equal(submitted.length, 0, 'no auto continue after takeover');
  assert.equal(cards.length, 1, 'no extra cards');
  ac.dispose();
});

await ok('non-quota error while waiting → gives up', async () => {
  const { ac, cards, submitted, turnEnd } = harness();
  turnEnd({ kind: 'error', error: { code: '429', message: 'Prompts quota used up (额度已用完)' } });
  await sleep(300); // fires, submits; that turn then errors non-quota
  turnEnd({ kind: 'error', error: { code: 'MOCK_ERROR', message: 'connection reset' } });
  assert.ok(cards.some((c) => /已停止/.test(c.header.title.content)), 'give-up card');
  assert.equal(ac.watchers.size, 0);
  ac.dispose();
});

await ok('transient limit: backoff then give up after shortMax', async () => {
  const { ac, cards, turnEnd } = harness();
  const transient = () => turnEnd({ kind: 'error', error: { code: '429', message: 'rate limit reached' } });
  transient(); // attempt 1 scheduled (30s away) — compress by simulating fire
  assert.equal(cards.length, 1, 'wait card for transient too');
  // force-fire attempt 1 → its turn errors again transient → attempt 2 → again → give up
  const w = ac.watchers.get('session-test');
  assert.ok(w, 'watcher armed');
  clearTimeout(w.timer); w.timer = null;
  ac.onEvent({ id: 'session-test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: '429', message: 'rate limit reached' } } } });
  assert.equal(ac.watchers.size, 1, 'attempt 2 scheduled');
  const w2 = ac.watchers.get('session-test');
  assert.equal(w2.attempts, 2);
  clearTimeout(w2.timer); w2.timer = null;
  ac.onEvent({ id: 'session-test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: '429', message: 'rate limit reached' } } } });
  assert.equal(ac.watchers.size, 0, 'gave up after shortMax=2 retries');
  assert.ok(cards.some((c) => /自动重试已放弃/.test(c.header.title.content)));
  ac.dispose();
});

await ok('unknown chat session is ignored', () => {
  const { ac, cards } = harness();
  const renderer = { chatOf: () => null };
  const transport = { async sendCard() { throw new Error('should not send'); } };
  const ac2 = new AutoContinue({ config: { autoContinue: true }, driver: { live: new Map() }, renderer, transport });
  ac2.onEvent({ id: 'session-other' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'quota' } } } });
  assert.equal(ac2.watchers.size, 0);
  assert.equal(cards.length, 0);
  ac.dispose(); ac2.dispose();
});

// ----------------------------------------------- 7 inspect_image attachment
await ok('attachmentDataUrl: readImage preferred', async () => {
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: png1x1.length };
  const attachments = {
    async readImage(r) {
      assert.equal(r.attachmentId, ref.attachmentId);
      return { ref: r, data: new Uint8Array(png1x1) };
    },
  };
  const url = await attachmentDataUrl(attachments, JSON.stringify(ref), 10 * 1024 * 1024);
  assert.match(url, /^data:image\/png;base64,/);
});

await ok('attachmentDataUrl: bare id falls back to direct read', async () => {
  // write a real 1x1 png into a temp DSH_HOME attachment layout
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-att-'));
  process.env.DSH_HOME = home;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const crypto = await import('node:crypto');
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  const dir = path.join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sha), png);
  const url = await attachmentDataUrl(null, `sha256:${sha}`, 10 * 1024 * 1024);
  assert.match(url, /^data:image\/png;base64,/);
  fs.rmSync(home, { recursive: true, force: true });
});

await ok('resolveVisionConfig: defaults + inline key override', () => {
  const d = resolveVisionConfig(null);
  assert.equal(d.model, 'qwen3-vl-plus');
  assert.equal(d.baseURL, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  const c = resolveVisionConfig({ apiKey: 'sk-x', model: 'qwen-vl-max' });
  assert.equal(c.apiKey, 'sk-x');
  assert.equal(c.model, 'qwen-vl-max');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
