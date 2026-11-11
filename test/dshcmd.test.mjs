#!/usr/bin/env node
/**
 * dshcmd.test.mjs — 桥对 dsh 内置命令的转发（2026-11-11）
 *
 * 背景：桥把所有 `/xxx` 都截住自己 switch，没实现的直接回"未知命令"，
 * 导致 dsh 自带的 /compact /plan /goal /export 在飞书里完全用不了。
 *
 * 本测试验证 tryDshCommand 的四种落点：
 *   1. dsh 有该命令 → 执行并把文本回成卡片
 *   2. dsh 没有该命令 → 返回 false（调用方回"未知命令"）
 *   3. 命令服务缺失（老 dsh）→ 返回 false，不抛
 *   4. 执行抛错 → 回错误卡片，不冒泡
 */
import assert from 'node:assert';
import { Commands } from '../src/commands.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.log(`FAIL ${name}: ${e?.stack ?? e}`); });

function mk({ dshCommands = null, agent = { id: 'a1' }, binding = { chatId: 'c', sessionId: 's1', cwd: '/tmp' } } = {}) {
  const cards = [];
  const transport = {
    async sendCard(_c, card) { cards.push(card); return { messageId: 'm' }; },
    async updateCard() { return { messageId: 'm' }; },
    async sendText(_c, t) { cards.push({ text: t }); },
  };
  const store = { get: () => binding, update() {} };
  const driver = { ensure: async () => agent, live: new Map() };
  const cmds = new Commands({
    config: {}, store, driver,
    renderer: { attach() {}, detach() {} },
    transport, permissionPresets: null, llm: null, agentPresets: null,
    dshCommands,
  });
  return { cmds, cards };
}

const json = (c) => JSON.stringify(c);

await ok('dsh 有该命令 → 执行并回卡片', async () => {
  let called = null;
  const dshCommands = {
    find: (_agent, name) => (name === 'compact' ? { name: 'compact', description: 'x' } : undefined),
    execute: async (_agent, line) => { called = line; return { result: { kind: 'ok', text: '已压缩：120k → 40k tokens' } }; },
  };
  const { cmds, cards } = mk({ dshCommands });
  const handled = await cmds.tryDshCommand('c', '/compact');
  assert.equal(handled, true);
  assert.equal(called, '/compact');
  assert.equal(cards.length, 1);
  assert.match(json(cards[0]), /已压缩/);
});

await ok('dsh 没有该命令 → false', async () => {
  const dshCommands = {
    find: () => undefined,
    execute: async () => { throw new Error('不该被调用'); },
  };
  const { cmds, cards } = mk({ dshCommands });
  const handled = await cmds.tryDshCommand('c', '/nosuchcmd');
  assert.equal(handled, false);
  assert.equal(cards.length, 0);
});

await ok('命令服务缺失（老 dsh）→ false 且不抛', async () => {
  const { cmds } = mk({ dshCommands: null });
  const handled = await cmds.tryDshCommand('c', '/compact');
  assert.equal(handled, false);
});

await ok('执行抛错 → 回错误卡片，不冒泡', async () => {
  const dshCommands = {
    find: () => ({ name: 'goal', description: 'x' }),
    execute: async () => { throw new Error('boom'); },
  };
  const { cmds, cards } = mk({ dshCommands });
  const handled = await cmds.tryDshCommand('c', '/goal');
  assert.equal(handled, true);
  assert.equal(cards.length, 1);
  assert.match(json(cards[0]), /boom/);
});

await ok('handle() 里未识别命令走到转发（不是先回未知命令）', async () => {
  const dshCommands = {
    find: (_a, name) => (name === 'plan' ? { name: 'plan', description: 'x' } : undefined),
    execute: async () => ({ result: { kind: 'ok', text: '已进入计划模式' } }),
  };
  const { cmds, cards } = mk({ dshCommands });
  const handled = await cmds.handle('c', '/plan');
  assert.equal(handled, true);
  assert.match(json(cards[0]), /计划模式/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);