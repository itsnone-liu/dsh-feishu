#!/usr/bin/env node
/**
 * hardening.test.mjs — 2026-08-23 事故加固项的针对性测试（纯 Node，无外部依赖）
 *
 *  1. 稀疏 blocks（tool-call 块在 index 0，text 在 index 2 → index 1 是空洞）
 *     不得让 renderer 崩溃 —— 旧代码在 #onAssistantMessage 的
 *     `for (const b of st.blocks) if (b.kind...)` 上同步抛 TypeError，
 *     而 session.append 同步调监听器 → 进程级死亡。
 *  2. buildTurnCard 元素上限：60 块的回合 → ≤ 30 个元素 + 折叠标记。
 *  3. 卡片更新连续失败 → 有界退避重试 + 第 5 次后换发新卡（messageId 置空）。
 *  4. selfguard：杀宿主命令被识别，普通命令/杀无关进程不误伤（宽界限内）。
 *  5. inspect_image：本地文件 → data URL 构造 + mock fetch 往返（不发真请求）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TurnRenderer } from '../src/renderer.js';
import { buildTurnCard } from '../src/cards.js';
import { threatensHost } from '../src/selfguard.js';
import { callVisionEndpoint, sniffImageMediaType } from '../src/vision-tool.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.log(`FAIL ${name}: ${e?.stack ?? e}`); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1 稀疏块
await ok('sparse blocks: tool-call@0 + text@2 no crash', async () => {
  const cards = [];
  const transport = {
    async sendCard(_c, card) { cards.push(card); return { messageId: `m${cards.length}` }; },
    async updateCard(id, card) { cards.push(card); return { messageId: id }; },
  };
  const r = new TurnRenderer({ transport, config: { throttleMs: 0, cardTextLimit: 4000 }, store: null });
  r.attach('s1', 'chat1');
  const ev = (type, data) => r.onEvent({ id: 's1' }, { type, data });
  ev('turn/start', { turn: 1 });
  // step: tool-call block at index 0 (skipped by renderer), text block at 2
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } });
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call_x', name: 'pwsh', argumentsDelta: '{"command":"ls"}' } });
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 2, blockType: 'text' } });
  ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 2, text: '你好' } });
  // 这一步在旧代码里同步抛 TypeError（b 为 undefined）
  ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [
    { type: 'tool-call', id: 'call_x', name: 'pwsh', arguments: '{"command":"ls"}' },
    { type: 'text', text: '你好' },
  ] } });
  ev('tool/call', { turn: 1, step: 1, callId: 'call_x', name: 'pwsh', arguments: '{"command":"ls"}' });
  ev('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call_x' }, content: [{ type: 'tool-result', toolCallId: 'call_x', content: [{ type: 'text', text: 'file1' }] }] } });
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await sleep(80);
  assert.ok(cards.length >= 1, '至少渲染出一张卡');
  const last = cards[cards.length - 1];
  const flat = JSON.stringify(last);
  assert.ok(flat.includes('你好'), '文本块被渲染');
  assert.ok(flat.includes('pwsh'), '工具块被渲染');
});

// ---------------------------------------------------------------- 2 元素上限
await ok('card element cap: 60 blocks fold to <= 30 elements', async () => {
  const blocks = Array.from({ length: 60 }, (_, i) => ({ kind: 'text', text: `block-${i} ` + 'x'.repeat(50) }));
  const card = buildTurnCard({ phase: 'working', turnNo: 3, title: 't', blocks, usage: {}, footer: 'f' }, 4000);
  const mdCount = card.elements.filter((e) => e.tag === 'div').length;
  assert.ok(mdCount <= 30, `div 元素 ${mdCount} <= 30`);
  assert.ok(JSON.stringify(card).includes('已折叠'), '折叠标记存在');
});

await ok('card builder tolerates sparse/undefined blocks', async () => {
  const blocks = [{ kind: 'text', text: 'a' }, undefined, { kind: 'text', text: 'b' }];
  blocks[5] = { kind: 'text', text: 'c' }; // 制造真空洞
  const card = buildTurnCard({ phase: 'done', turnNo: 1, title: 't', blocks, usage: {} }, 4000);
  const flat = JSON.stringify(card);
  assert.ok(flat.includes('a') && flat.includes('b') && flat.includes('c'));
});

// ---------------------------------------------------------------- 3 失败重试
await ok('flush retry: update failures back off then fall back to a new card', async () => {
  const events = [];
  let failUpdates = 0;
  const transport = {
    async sendCard(_c, card) { events.push({ op: 'send', card }); return { messageId: `m${events.length}` }; },
    async updateCard(id, card) {
      events.push({ op: 'update', id });
      if (failUpdates > 0) { failUpdates--; throw new Error('feishu update 230001: param invalid'); }
      return { messageId: id };
    },
  };
  const r = new TurnRenderer({ transport, config: { throttleMs: 0, cardTextLimit: 4000, cardRetryBaseMs: 20 }, store: null });
  r.attach('s2', 'chat2');
  const ev = (type, data) => r.onEvent({ id: 's2' }, { type, data });
  ev('turn/start', { turn: 1 });
  ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  await sleep(50);
  assert.ok(events.filter((e) => e.op === 'send').length === 1, '初始卡已发');

  // 连续 5 次 update 失败 → 有界退避（基数 20ms）+ 第 5 次后换发新卡
  failUpdates = 5;
  ev('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'again' }] } });
  await sleep(900); // 20+40+80+160+320ms 的重试链在此窗口内全部发生
  const st = r.states.get('s2');
  assert.ok(st, 'state 存在');
  assert.ok(events.filter((e) => e.op === 'update').length >= 2, '存在重试更新');
  const sends = events.filter((e) => e.op === 'send').length;
  assert.ok(sends >= 2, `第 5 次失败后换发新卡（send=${sends}）`);
});

// ---------------------------------------------------------------- 4 selfguard
await ok('selfguard detects host-killing commands', async () => {
  const incident = "git add -A; git commit -m x; $p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'profile feishu' }; if ($p) { Stop-Process -Id $p.ProcessId -Force }; & D:\\dsh-install\\start_bridge.ps1";
  assert.ok(threatensHost(incident, 4242), '事故命令被识别');
  assert.ok(threatensHost('taskkill /IM node.exe /F', 4242), 'taskkill node 被识别');
  assert.ok(threatensHost(`Stop-Process -Id 9999 -Force`, 9999), '杀自身 PID 被识别');
  assert.ok(!threatensHost('Get-ChildItem node_modules', 4242), '普通命令不误伤');
  assert.ok(!threatensHost('Stop-Process -Name notepad -Force', 4242), '杀无关进程不拦（提示走终端）');
  assert.ok(!threatensHost('', 4242), '空命令安全');
  assert.ok(!threatensHost(undefined, 4242), 'undefined 安全');
});

// ---------------------------------------------------------------- 5 vision
await ok('sniffImageMediaType magic bytes', async () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMediaType(new Uint8Array(12)), null);
  assert.equal(sniffImageMediaType(null), null);
});

await ok('callVisionEndpoint request shape (mock fetch)', async () => {
  const tmp = path.join(os.tmpdir(), `vision-test-${Date.now()}.png`);
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await fsp.writeFile(tmp, png);

  let captured;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '图里是一只猫' } }] }),
    };
  };
  process.env.TEST_VISION_KEY = 'sk-test';
  try {
    const cfg = { baseURL: 'https://example.com/v4', apiKeyEnv: 'TEST_VISION_KEY', model: 'glm-4.5v', maxTokens: 512, timeoutMs: 5000 };
    const answer = await callVisionEndpoint(cfg, 'https://example.com/x.png', '这是什么', undefined);
    assert.equal(answer, '图里是一只猫');
    assert.ok(captured.url === 'https://example.com/v4/chat/completions');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'glm-4.5v');
    assert.equal(body.messages[0].content[0].type, 'image_url');
    assert.equal(body.messages[0].content[1].text, '这是什么');
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(tmp, { force: true });
    delete process.env.TEST_VISION_KEY;
  }
});

await ok('callVisionEndpoint surfaces http errors without throwing raw', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'Too Many Requests' } }) });
  process.env.TEST_VISION_KEY = 'sk-test';
  try {
    await assert.rejects(
      () => callVisionEndpoint({ baseURL: 'https://e.com', apiKeyEnv: 'TEST_VISION_KEY', model: 'm', timeoutMs: 1000 }, 'https://x/y.png', '', undefined),
      /HTTP 429.*Too Many Requests/,
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TEST_VISION_KEY;
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
