#!/usr/bin/env node
/**
 * audit/commands.test.mjs — A2：/audit 子命令解析与文案（纯函数层，离线）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { handleAuditCommand } from '../../src/audit/commands.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });

let tick = 1000;
const newCtrl = () => new AuditController({
  store: new AuditStore(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cmd-'))),
  hostId: 'h1', cwd: '/w', repo: 'stub://t', branch: 'main',
  now: () => (tick += 1),
});

await ok('空参数 → usage 卡', () => {
  const r = handleAuditCommand(newCtrl(), '');
  assert.equal(r.title, '/audit 用法');
  assert.match(r.body, /audit <阶段>/);
  assert.match(r.body, /A2 阶段/);
});

await ok('/audit T2 → 创建卡（EXECUTING + 停止点 + A2 披露）', () => {
  const r = handleAuditCommand(newCtrl(), 'T2');
  assert.equal(r.title, '🧾 审计运行已创建');
  assert.match(r.body, /EXECUTING/);
  assert.match(r.body, /\*\*T2\*\*/);
  assert.match(r.body, /RUN_ID\/STAGE\/ITERATION\/HOST_ID/);
});

await ok('/audit t2 小写也建（阶段名规范化为原表名）', () => {
  const r = handleAuditCommand(newCtrl(), 't2');
  assert.equal(r.title, '🧾 审计运行已创建');
});

await ok('/audit T9（不在表）→ 明确错误卡', () => {
  const r = handleAuditCommand(newCtrl(), 'T9');
  assert.equal(r.title, '❌ 创建失败');
  assert.match(r.body, /T9/);
});

await ok('/audit status → 状态卡（无 run / 有 run 两态）', () => {
  const ctrl = newCtrl();
  const none = handleAuditCommand(ctrl, 'status');
  assert.equal(none.title, '没有审计运行');
  assert.match(none.body, /audit <阶段>/);
  handleAuditCommand(ctrl, 'T2');
  const s = handleAuditCommand(ctrl, 'status');
  assert.equal(s.title, '📊 审计状态');
  assert.match(s.body, /EXECUTING/);
  assert.match(s.body, /A2 stub/);
  assert.match(s.body, /停止点：\*\*T2\*\*/);
});

await ok('/audit pause → 暂停卡；再 /audit resume → 恢复卡', () => {
  const ctrl = newCtrl();
  handleAuditCommand(ctrl, 'T2');
  const p = handleAuditCommand(ctrl, 'pause');
  assert.equal(p.title, '⏸ 已暂停');
  assert.match(p.body, /PAUSED/);
  const rm = handleAuditCommand(ctrl, 'resume');
  assert.equal(rm.title, '▶️ 已恢复');
  assert.match(rm.body, /EXECUTING/);
});

await ok('/audit stop → 终止卡（终态提示可新建）', () => {
  const ctrl = newCtrl();
  handleAuditCommand(ctrl, 'T2');
  const s = handleAuditCommand(ctrl, 'stop');
  assert.equal(s.title, '🛑 已终止');
  assert.match(s.body, /STOPPED/);
  assert.match(s.body, /重新 .audit <阶段>/);
});

await ok('/audit until T3 → 修改卡；until 缺参 → 用法', () => {
  const ctrl = newCtrl();
  handleAuditCommand(ctrl, 'T2');
  const u = handleAuditCommand(ctrl, 'until T3');
  assert.equal(u.title, '🎯 停止点');
  assert.match(u.body, /T3/);
  assert.match(u.body, /§6.2/);
  const miss = handleAuditCommand(ctrl, 'until');
  assert.equal(miss.title, '用法');
});

await ok('未识别子命令（如 /audit frobnicate）→ 引导卡不崩溃', () => {
  const r = handleAuditCommand(newCtrl(), 'frobnicate');
  assert.equal(r.title, '未识别的 /audit 子命令');
  assert.match(r.body, /frobnicate/);
  assert.match(r.body, /audit <阶段>/);
});

await ok('错误路径模板：无活跃 run 时 pause → 红卡而非静默', () => {
  const r = handleAuditCommand(newCtrl(), 'pause');
  assert.equal(r.title, '❌ 暂停失败');
  assert.equal(r.template, 'red');
  assert.match(r.body, /没有活跃/);
});

// ---------- 装配集成：Commands.handle('/audit …') 真实命令路径 ----------
await ok('Commands.handle(/audit …) → sendCard 收到命令面卡片（真实装配路径）', async () => {
  const { Commands } = await import('../../src/commands.js');
  const { MockTransport } = await import('../../src/transport/mock.js');
  const ctrl = newCtrl();
  const transport = new MockTransport({});
  const commands = new Commands({
    config: { approval: 'read-only' }, store: null, driver: null, renderer: null,
    transport, permissionPresets: {}, llm: null, agentPresets: {}, auditController: ctrl,
  });
  assert.equal(await commands.handle('oc_x', '/audit T2'), true);
  assert.equal(await commands.handle('oc_x', '/audit status'), true);
  assert.equal(await commands.handle('oc_x', '/audit pause'), true);
  assert.equal(await commands.handle('oc_x', '/audit resume'), true);
  assert.equal(await commands.handle('oc_x', '/audit until T3'), true);
  assert.equal(await commands.handle('oc_x', '/audit stop'), true);
  assert.equal(transport.sent.length, 6);
  const json = transport.sent.map((s) => JSON.stringify(s.card));
  assert.match(json[0], /审计运行已创建/);
  assert.match(json[1], /审计状态/);
  assert.match(json[5], /已终止/);
  // 未注入 controller 的旧装配 → 友好错误卡而非崩溃
  const bare = new Commands({
    config: {}, store: null, driver: null, renderer: null,
    transport, permissionPresets: {}, llm: null, agentPresets: {},
  });
  assert.equal(await commands2Check(bare), true);
  assert.match(JSON.stringify(transport.sent.at(-1).card), /未启用/);
});
async function commands2Check(bare) {
  return bare.handle('oc_x', '/audit status');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
