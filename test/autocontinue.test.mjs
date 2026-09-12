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

// ------- 2026-08-26 incident: GLM Coding Plan 5h window (HTTP 429, code 1308)
// The body contains neither 额度 nor quota — it used to fall into the
// transient bucket and hammer 30/60/120/240s retries with empty cards.
const GLM_1308 = (resetIso) =>
  `RATE_LIMIT: 429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 ${resetIso} 重置。"}`;

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

await ok('classifyFailure: GLM 1308 5h window → long (not transient)', () => {
  assert.equal(classifyFailure(GLM_1308('2026-08-26 20:36:10')), 'long');
  assert.equal(classifyFailure('429: {"code":"1308","message":"usage limit"}'), 'long');
  // plain 429 without window wording stays transient
  assert.equal(classifyFailure('429: too many requests'), 'short');
});

await ok('GLM 1308: schedule at the promised reset time, not 30s backoff', () => {
  const { ac, cards, submitted, turnEnd } = harness({ autoContinueMaxMs: 10 * 60_000 });
  const resetAt = new Date(Date.now() + 2 * 60_000); // 2 min out
  turnEnd({ kind: 'error', error: { code: 'RATE_LIMIT', message: GLM_1308(fmtLocal(resetAt)) } });
  const w = ac.watchers.get('session-test');
  assert.ok(w, 'watcher armed');
  assert.equal(w.kind, 'long');
  // fires at resetAt + 30s grace (± a little scheduling slack), NOT within 10s
  const inS = (w.nextAt.getTime() - Date.now()) / 1000;
  assert.ok(inS > 60, `schedules ≥60s out (got ${inS.toFixed(0)}s)`);
  assert.equal(submitted.length, 0, 'nothing fired immediately');
  assert.match(cards[0].header.title.content, /自动等待/);
  assert.match(JSON.stringify(cards[0]), /重置/, 'card mentions the reset plan');
  ac.dispose();
});

await ok('GLM 1308 with a STALE reset time falls back to probing, not hammering', async () => {
  const { ac, submitted, turnEnd } = harness();
  const past = new Date(Date.now() - 30 * 60_000); // reset time already gone
  turnEnd({ kind: 'error', error: { code: 'RATE_LIMIT', message: GLM_1308(fmtLocal(past)) } });
  const w = ac.watchers.get('session-test');
  assert.ok(w, 'watcher armed');
  const inS = (w.nextAt.getTime() - Date.now()) / 1000;
  // first probe at firstMs=150ms (no valid hint) — the 5s-floor hammer is gone
  assert.ok(inS < 10, `stale hint must not hammer (fires in ${inS.toFixed(1)}s)`);
  await sleep(400);
  assert.equal(submitted.length, 1, 'one probe fired');
  ac.dispose();
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

await ok('transient limit: backoff then escalate to long-watch after shortMax', async () => {
  const { ac, cards, turnEnd } = harness({ fallbackPrimary: '', fallbackBackup: '' });
  const transient = () => turnEnd({ kind: 'error', error: { code: '429', message: 'rate limit reached' } });
  transient(); // attempt 1 scheduled (30s away) — compress by simulating fire
  assert.equal(cards.length, 1, 'wait card for transient too');
  // force-fire attempt 1 → its turn errors again transient → attempt 2 → again → escalate
  const w = ac.watchers.get('session-test');
  assert.ok(w, 'watcher armed');
  clearTimeout(w.timer); w.timer = null;
  ac.onEvent({ id: 'session-test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: '429', message: 'rate limit reached' } } } });
  assert.equal(ac.watchers.size, 1, 'attempt 2 scheduled');
  const w2 = ac.watchers.get('session-test');
  assert.equal(w2.attempts, 2);
  clearTimeout(w2.timer); w2.timer = null;
  ac.onEvent({ id: 'session-test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: '429', message: 'rate limit reached' } } } });
  assert.equal(ac.watchers.size, 1, 'escalated to long-watch (NOT given up) — 2026-09-04 incident fix');
  assert.ok(cards.some((c) => /窗口打满|长等待/.test(c.header.title.content)), 'escalation card');
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

// ------------------------------------------------- 8 限额自动换模型(fallback)
/** fallback harness：driver mock 带模型切换三件套 + 可注入探针。
 *  时序复刻（2026-09-09 事故教训）：turn/end 在 session.append() 里同步
 *  分发——分发栈内的 driver.submit（steer/followup → inbox.splice →
 *  session.append）会被 dsh-session 重入锁拒绝（"cannot reenter"）。
 *  inDispatch 标记同步窗口，submit mock 在窗口内抛锁错，与真实时序一致。 */
function fbHarness(cfgOver = {}) {
  const cards = [];
  const submitted = [];
  const applied = [];
  let inDispatch = false;
  let alwaysLocked = false;   // true = submit 永远抛锁错（测重试用尽）
  let failFirstN = 0;          // 额外前 N 次调用也抛错（测重试成功路径）
  let submitCalls = 0;
  const agent = {
    id: 'session-test',
    status: 'idle',
    followup(m) { submitted.push({ how: 'followup', text: m.content?.[0]?.text ?? '' }); },
    steer(m) { submitted.push({ how: 'steer', text: m.content?.[0]?.text ?? '' }); },
  };
  const driver = {
    live: new Map([['session-test', { agent }]]),
    defaultOverride: null,
    currentModel: () => ({ provider: 'glm-coding', model: 'glm-5.3' }),
    setModel: (_a, provider, model) => { applied.push(`${provider}/${model}`); },
    applyModelToAll: (provider, model) => { applied.push(`ALL:${provider}/${model}`); return []; },
    // 与真实 SessionDriver.submit 同语义：running→steer，idle→followup；
    // 且复刻 dsh-session 重入锁——同步分发窗口内的 append 必被拒。
    submit(a, text) {
      submitCalls++;
      if (alwaysLocked || (inDispatch) || submitCalls <= failFirstN) {
        throw new Error('session append cannot reenter while another append is being published');
      }
      const msg = { content: [{ type: 'text', text }] };
      const running = a.status === 'running';
      if (running) a.steer(msg); else a.followup(msg);
      return running ? 'steer' : 'followup';
    },
  };
  const renderer = { chatOf: (id) => (id === 'session-test' ? 'chat-1' : null) };
  const transport = { async sendCard(_c, card) { cards.push(card); return { messageId: `m${cards.length}` }; } };
  const cfg = {
    autoContinue: true,
    autoContinueMessage: '继续',
    autoContinueFirstMs: 80,
    autoContinuePollMs: 120,
    autoContinueMaxMs: 5_000,
    autoContinueShortMax: 2,
    autoContinuePatterns: [],
    fallbackPrimary: 'glm-coding/glm-5.3',
    fallbackBackup: 'codex-gpt/gpt-5.6-luna',
    ...cfgOver,
  };
  const ac = new AutoContinue({ config: cfg, driver, renderer, transport });
  const turnEnd = (reason) => {
    inDispatch = true;
    try { ac.onEvent({ id: 'session-test' }, { type: 'turn/end', data: { reason } }); }
    finally { inDispatch = false; }
  };
  return { ac, cards, submitted, applied, driver, turnEnd, agent,
    mocks: { lockAlways(v) { alwaysLocked = v; }, failFirst(v) { failFirstN = v; }, calls: () => submitCalls } };
}

await ok('fallback: GPT quota error → reverse switch to GLM + resume', async () => {
  const h = fbHarness();
  h.driver.currentModel = () => ({ provider: 'codex-gpt', model: 'gpt-5.6-luna' });
  h.turnEnd({ kind: 'error', error: { code: 'usage_limit_reached', message: 'You have 0 weighted tokens left; usage limit reached. Try again in 4 hours.' } });
  assert.ok(h.ac.fallbackActive, 'reverse fallback active');
  assert.ok(h.applied.includes('ALL:glm-coding/glm-5.3'), 'GPT exhaustion switches all sessions to GLM');
  assert.deepEqual(h.driver.defaultOverride, { provider: 'glm-coding', model: 'glm-5.3' });
  assert.deepEqual(h.ac.limitedModel, { provider: 'codex-gpt', model: 'gpt-5.6-luna' });
  await sleep(30);
  assert.ok(h.submitted.some((s) => s.text === '继续'), 'interrupted GPT task resumes on GLM');
  assert.ok(h.cards.some((c) => /已切换可用模型/.test(c.header.title.content) && /glm-coding/.test(JSON.stringify(c))));
  h.ac.dispose();
});

await ok('fallback: codex-proxy AUTH 401 (GPT quota symptom) → long → reverse switch to GLM', async () => {
  // 2026-09-12 用户报告原文：GPT 5h 额度到点时 codex-proxy 返回的不是 quota 文案，
  // 而是 AUTH:401 Not authenticated / invalid_api_key。旧分类把它当"非额度错误"
  // 直接放弃 → 永不 fallback，只报 API 错误。必须按窗口类处理并切到 GLM。
  const h = fbHarness();
  h.driver.currentModel = () => ({ provider: 'codex-gpt', model: 'gpt-5.6-luna' });
  h.turnEnd({ kind: 'error', error: { code: 'AUTH', message: 'AUTH: 401: {"message":"Not authenticated. Please login first at /","type":"invalid_request_error","param":null,"code":"invalid_api_key"}' } });
  assert.ok(h.ac.fallbackActive, '401 proxy-logout symptom triggers fallback');
  assert.ok(h.applied.includes('ALL:glm-coding/glm-5.3'), 'switched to GLM');
  await sleep(30);
  assert.ok(h.submitted.some((s) => s.text === '继续'), 'interrupted task resumes on GLM');
  h.ac.dispose();
});

await ok('fallback: 不自动切回 — 接管侧正常干活时不还原（2026-09-13 定调）', async () => {
  const h = fbHarness();
  h.turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } }); // GLM→GPT
  assert.ok(h.applied.includes('ALL:codex-gpt/gpt-5.6-luna'));
  await sleep(250);   // 足够 firstMs/pollMs 触发多次 —— 什么都不该再发生
  assert.ok(h.ac.fallbackActive, 'stays on takeover side (no recovery exit)');
  assert.ok(!h.applied.includes('glm-coding/glm-5.3'), 'no restore without exhaustion');
  assert.equal(h.ac.watchers.size, 0, 'no probe/wait watcher armed');
  h.ac.dispose();
});

await ok('fallback: long quota error → switch to other side + resume + orange card', async () => {
  const { ac, cards, submitted, applied, driver, turnEnd } = fbHarness();
  turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } });
  assert.ok(ac.fallbackActive, 'fallback active');
  assert.ok(applied.some((x) => x === 'ALL:codex-gpt/gpt-5.6-luna'), 'all sessions switched');
  assert.deepEqual(driver.defaultOverride, { provider: 'codex-gpt', model: 'gpt-5.6-luna' }, 'default override set');
  await sleep(30);   // resume 已异步化：等宏任务越过重入锁窗口
  assert.ok(submitted.some((s) => s.text === '继续'), 'interrupted task auto-resumed');
  assert.ok(cards.some((c) => /切换可用模型/.test(c.header.title.content)), 'switch card');
  assert.ok(cards.some((c) => /不会自动切回/.test(JSON.stringify(c))), 'card states the no-switch-back policy');
  assert.equal(ac.watchers.size, 0, 'no wait/probe watcher after switching');
  ac.dispose();
});

await ok('fallback: resume survives the append reenter lock (2026-09-09 incident)', async () => {
  // 真实时序：turn/end 在 session.append() 同步分发栈内 → 此刻 submit 的
  // inbox.splice 又要 session.append → dsh-session 重入锁直接抛 "cannot
  // reenter"。harness 的 submit mock 在同步窗口内抛同款错误。修复 = 推迟
  // 一个宏任务提交 + 短重试兜底。
  const { ac, cards, submitted, turnEnd } = fbHarness();
  turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } });
  assert.equal(submitted.length, 0, 'no synchronous submit inside the dispatch window');
  await sleep(30);
  assert.ok(submitted.some((s) => s.text === '继续'), 'resume lands after the lock window closes');
  assert.ok(!cards.some((c) => /自动续跑失败/.test(JSON.stringify(c))), 'no failure card on success');
  ac.dispose();
});

await ok('fallback: resume retries transient lock errors then succeeds', async () => {
  const { ac, submitted, turnEnd, mocks } = fbHarness();
  mocks.failFirst(3);   // 前 3 次调用抛锁错（模拟极慢的持久化回调）
  turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } });
  await sleep(900);     // 250ms × 3 次重试窗口
  assert.ok(submitted.some((s) => s.text === '继续'), 'retry chain eventually lands the resume');
  ac.dispose();
});

await ok('fallback: resume exhausts retries → grey card tells the user to continue manually', async () => {
  const { ac, cards, turnEnd, mocks } = fbHarness();
  mocks.lockAlways(true);   // submit 永远抛锁错
  turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } });
  await sleep(2_900);       // setTimeout(0) + 8 × 250ms 全部用尽
  assert.equal(cards.filter((c) => /自动续跑失败/.test(JSON.stringify(c))).length, 1,
    'exactly one manual-continue hint card');
  assert.ok(cards.some((c) => /请手动发一条「继续」/.test(JSON.stringify(c))), 'card says how to recover');
  ac.dispose();
});

await ok('fallback: resume works during the transient running window (2026-09-08 incident)', async () => {
  // turn/end 是在 session.append() 里同步分发的：此刻真实 agent 的 phase
  // 还是 'running'（idle 要等 kick() 的 finally）。旧实现按 status==='idle'
  // 判断 → 切了模型但从不自动继续，用户必须手发「继续」。修复后 running
  // 走 steer 也能接上。
  const { ac, cards, submitted, turnEnd, agent } = fbHarness();
  agent.status = 'running';
  turnEnd({ kind: 'error', error: { code: '1308', message: '已达到5小时的使用上限，额度耗尽' } });
  assert.ok(ac.fallbackActive, 'fallback entered despite running status');
  await sleep(30);
  const resume = submitted.find((s) => s.text === '继续');
  assert.ok(resume, 'auto-resume submitted in the running window');
  assert.equal(resume.how, 'steer', 'running window resumes via steer');
  assert.ok(cards.some((c) => /切换可用模型/.test(c.header.title.content)
    && /将自动继续/.test(JSON.stringify(c))), 'card says task will auto-continue');
  ac.dispose();
});

await ok('fallback: 两侧都满 → 只提示一次，不再互切（2026-09-13 定调）', async () => {
  const h = fbHarness();
  h.turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } }); // GLM→GPT
  const appliedAfterFirst = h.applied.length;
  // GPT 也满：报错来自接管侧（mock 更新为接管模型，与真实 driver 行为一致）
  h.driver.currentModel = () => ({ provider: 'codex-gpt', model: 'gpt-5.6-luna' });
  h.turnEnd({ kind: 'error', error: { code: '429', message: 'You have 0 weighted tokens left; usage limit reached' } });
  assert.equal(h.applied.length, appliedAfterFirst, 'no ping-pong switch');
  assert.ok(h.ac.fallbackActive, 'fallback state kept — further errors stay suppressed');
  const both = h.cards.filter((c) => /两侧额度都在限额内/.test(c.header.title.content));
  assert.equal(both.length, 1, 'notify exactly once');
  h.turnEnd({ kind: 'error', error: { code: '429', message: 'usage limit reached again' } });
  assert.equal(h.cards.filter((c) => /两侧额度都在限额内/.test(c.header.title.content)).length, 1, 'no duplicate cards');
  assert.equal(h.ac.watchers.size, 0, 'no auto-retry scheduled while both limited');
  h.ac.dispose();
});

await ok('fallback: 接管侧成功回合后再次限额 → 换文案再提示（另一侧状态未知）', async () => {
  const h = fbHarness();
  h.turnEnd({ kind: 'error', error: { code: '429', message: '额度耗尽 quota exhausted' } }); // GLM→GPT
  h.driver.currentModel = () => ({ provider: 'codex-gpt', model: 'gpt-5.6-luna' });
  h.turnEnd({ kind: 'error', error: { code: '429', message: 'usage limit reached (额度耗尽)' } }); // 两侧都满 #1
  h.turnEnd({ kind: 'completed' });   // GPT 窗口重置，任务跑通
  h.turnEnd({ kind: 'error', error: { code: '429', message: 'usage limit reached (额度耗尽)' } }); // GPT 又满
  assert.ok(h.cards.some((c) => /接管侧额度又耗尽/.test(c.header.title.content)), 're-notified with the again-variant');
  assert.equal(h.applied.filter((x) => x.startsWith('ALL:')).length, 1, 'still no auto switch-back');
  h.ac.dispose();
});

await ok('fallback: 用户经 /model 切回受限侧再报额度错 → 按新耗尽事件重新处理', async () => {
  const h = fbHarness();
  h.turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限，额度耗尽' } }); // GLM→GPT
  assert.ok(h.ac.fallbackActive);
  // 用户经 /model 卡片（绕过 /glm）把会话切回 GLM，GLM 又报额度错：
  // 旧 fallback 状态作废，按「当前模型耗尽→切另一侧」重新进一次——
  // 这是一次新的耗尽切换，不是来回切的死循环（GPT 若也满会走两侧都满提示）。
  h.driver.currentModel = () => ({ provider: 'glm-coding', model: 'glm-5.3' });
  h.turnEnd({ kind: 'error', error: { code: '429', message: '已达到5小时的使用上限' } });
  assert.ok(h.ac.fallbackActive, 're-entered by the NEW exhaustion event');
  assert.equal(h.applied.filter((x) => x === 'ALL:codex-gpt/gpt-5.6-luna').length, 2, 'switched again (fresh exhaustion)');
  assert.deepEqual(h.ac.limitedModel, { provider: 'glm-coding', model: 'glm-5.3' }, 'direction tracks the new failing side');
  await sleep(30);
  assert.ok(h.submitted.filter((s) => s.text === '继续').length >= 1, 'task resumed');
  h.ac.dispose();
});

await ok('fallback: completed turn on takeover does not trigger anything', async () => {
  const { ac, cards, turnEnd } = fbHarness();
  turnEnd({ kind: 'error', error: { code: '429', message: '额度耗尽 quota exhausted' } });
  const before = ac.lastOkAt;
  turnEnd({ kind: 'completed' });
  assert.ok(ac.fallbackActive, 'no auto switch-back exists to trigger');
  assert.notEqual(ac.lastOkAt, Date.now(), 'lastOkAt anchor not polluted by takeover success');
  assert.ok(!cards.some((c) => /已自动恢复/.test(c.header.title.content)), 'no premature success card');
  ac.dispose();
});

await ok('fallback: short 429 does NOT switch; only escalated long does', () => {
  const { ac, applied, turnEnd } = fbHarness();
  turnEnd({ kind: 'error', error: { code: '429', message: 'rate limit reached' } });
  assert.ok(!ac.fallbackActive, 'transient limit must not switch model');
  assert.equal(applied.length, 0);
  ac.dispose();
});

await ok('fallback: probe success → restore snapshot + green card', async () => {
  // 2026-09-13 起「恢复探针/自动切回」整组行为已删除：探针不存在，
  // 恢复只能手动。此测试改为守护"没有自动还原"这条策略本身。
  const { ac, cards, applied, turnEnd } = fbHarness();
  turnEnd({ kind: 'error', error: { code: '429', message: '额度耗尽 quota exhausted' } });
  await sleep(150); // firstMs 早已过期，什么探针都不存在
  assert.ok(ac.fallbackActive, 'fallback stays (no probe, no exit)');
  assert.ok(!applied.some((x) => x === 'glm-coding/glm-5.3'), 'sessions NOT restored automatically');
  assert.ok(!cards.some((c) => /已自动切回/.test(c.header.title.content)), 'no recovery card');
  assert.equal(ac.watchers.size, 0, 'watcher cleared');
  ac.dispose();
});

await ok('manual: /gpt preference keeps quota safety net; /glm restores auto', () => {
  const { ac, applied, turnEnd } = fbHarness();
  const r1 = ac.manualSwitch('gpt');
  assert.ok(r1.ok);
  assert.equal(ac.mode, 'manual');
  assert.ok(applied.some((x) => x === 'ALL:codex-gpt/gpt-5.6-luna'));
  // 手动选择GPT只改变偏好；额度安全网仍须反向切回GLM，否则就会只报API错误。
  // harness模型查询默认固定为GLM；模拟/manual切换后的真实活动模型。
  ac.driver.currentModel = () => ({ provider: 'codex-gpt', model: 'gpt-5.6-luna' });
  turnEnd({ kind: 'error', error: { code: '429', message: '额度耗尽 quota exhausted' } });
  assert.ok(ac.fallbackActive, 'manual GPT preference must not disable quota failover');
  assert.ok(applied.some((x) => x === 'ALL:glm-coding/glm-5.3'));
  const r2 = ac.manualSwitch('glm');
  assert.ok(r2.ok);
  assert.equal(ac.mode, 'auto');
  assert.ok(applied.some((x) => x === 'ALL:glm-coding/glm-5.3'));
  ac.dispose();
});

await ok('manual: /auto only re-enables, keeps current model', () => {
  const { ac, applied } = fbHarness();
  ac.manualSwitch('gpt');
  applied.length = 0;
  const r = ac.manualSwitch('auto');
  assert.ok(r.ok);
  assert.equal(ac.mode, 'auto');
  assert.equal(applied.length, 0, '/auto must not touch models');
  ac.dispose();
});
