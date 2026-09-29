#!/usr/bin/env node
/**
 * audit/preauth-acceptance.test.mjs — P-D 验收（离线）：三场景 × 重启持久性 × 撤销即时性。
 *
 *  d1  PreauthStore 重启持久性：新实例读同一 records.jsonl —— 待用记录仍可用、
 *      已消费/已撤销状态保留（append-only，无内存态）。
 *  d2  撤销即时性：eligible 记录 revoke 后，布防自动放行立即失效（同进程写盘）。
 *  d3  lifecycle 重启：run 停在 WAITING_FOR_human → 新 AuditLifecycle（同一 store
 *      根）restoreActive 恢复 → 布防自动消费仍工作；消费状态跨重启单次有效。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { PreauthStore } from '../../src/audit/preauth-store.js';
import { PREAUTH_TEMPLATE_EXACT } from '../../src/audit/preauth-protocol.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log(`PASS ${name}`);
}).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pd-acc-'));
const isoNoMs = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const exactText = (rootRunId, hash) => PREAUTH_TEMPLATE_EXACT
  .replaceAll('<rootRunId>', rootRunId)
  .replaceAll('<expiresAt>', isoNoMs(Date.now() + 12 * 3600_000))
  .replaceAll('<64hex>', hash);

const buildWorld = (worldRoot) => {
  const store = new AuditStore(path.join(worldRoot, 'audit-store'));
  const controller = new AuditController({ store, hostId: 'h1', cwd: worldRoot, repo: 'unused', branch: 'main' });
  const agent = { id: 's-a', status: 'idle', cancel() {} };
  const prompts = [];
  const driver = { ensure: async () => agent, submit: (_a, t) => { prompts.push(t); return 'followup'; } };
  const gate = {
    inspect: async () => ({ cwd: worldRoot, repo: 'real-origin', branch: 'main', head: 'b'.repeat(40) }),
    isAncestor: async () => true,
    pushAndVerify: async ({ head }) => ({ ok: true, tipMatches: true, tip: head }),
  };
  const mkLife = (preauthStore) => {
    const life = new AuditLifecycle({
      controller, driver,
      bindings: new Map([['chat-a', { sessionId: 's-a', cwd: worldRoot }]]),
      gitGateFactory: () => gate,
      taskPacketLoader: () => ({
        goal: 'g', approvedPlan: 'p', stages: ['B4', 'G'], stageRequirements: {},
        stageGates: { B4: { kind: 'SEAL', bindings: ['EXACT'] } },
        preauthorization: { version: 1, gates: { B4: { binding: ['EXACT'] } } },
        taskPacketHash: 'hash',
      }),
      onProgress: () => {},
      reviewTimeoutMs: 200,
      preauthStore,
    });
    controller.lifecycle = life;
    return life;
  };
  return { controller, mkLife, agent, prompts, store };
};

const assistantText = (m, text) => m.onEvent({ id: 's-a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const waitBlock = (run, hash) =>
  `[DSH-AUDIT]\nSTATE: WAIT_HUMAN_APPROVAL\nRUN_ID: ${run.runId}\nSTAGE: B4\nITERATION: 1\nHOST_ID: h1\nQUESTION:\nreceipt_sha256: ${hash}\n等待人工批准（仅授权本 receipt）`;

// ---------------------------------------------------------------- d1
await ok('d1 PreauthStore 重启持久性：新实例同一 root —— 待用/已消费/已撤销状态保留', async () => {
  const dir = mkTemp();
  const ps1 = new PreauthStore(dir);
  const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64), hashC = 'c'.repeat(64);
  const recA = ps1.append({ chatId: 'c', messageRef: 'm', humanText: 't', binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: hashA, expiresAt: Date.now() + 3600e3, runScope: { rootRunId: 'r1' } });
  const recB = ps1.append({ chatId: 'c', messageRef: 'm', humanText: 't', binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: hashB, expiresAt: Date.now() + 3600e3, runScope: { rootRunId: 'r1' } });
  const recC = ps1.append({ chatId: 'c', messageRef: 'm', humanText: 't', binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: hashC, expiresAt: Date.now() + 3600e3, runScope: { rootRunId: 'r1' } });
  ps1.markConsumed(recB.preauthId, { runId: 'r1', stage: 'B4', ordinal: 1, receiptHash: hashB });
  ps1.revoke(recC.preauthId);

  const ps2 = new PreauthStore(dir); // “重启”
  const elig = ps2.findEligible({ stage: 'B4', gateKind: 'SEAL_ANNOTATION_ONLY', rootRunId: 'r1' });
  assert.equal(elig.length, 1, '仅未消费未撤销未过期的 recA 可用');
  assert.equal(elig[0].preauthId, recA.preauthId);
  const gotB = ps2.get(recB.preauthId);
  assert.ok(gotB.consumedAt >= 1, '已消费状态跨重启保留');
  const gotC = ps2.get(recC.preauthId);
  assert.ok(gotC.revokedAt >= 1, '已撤销状态跨重启保留');
  // 已消费的记录在重启后不得再消费（PreauthAlreadyConsumed fail loud）
  let threw = null;
  try { ps2.markConsumed(recB.preauthId, { runId: 'r1', stage: 'B4', ordinal: 2, receiptHash: hashB }); } catch (e) { threw = e; }
  assert.ok(threw, '二次消费必须抛错');
});

// ---------------------------------------------------------------- d2
await ok('d2 撤销即时性：revoke 后布防自动放行立即失效', async () => {
  const w = buildWorld(mkTemp());
  const ps = new PreauthStore(mkTemp());
  const life = w.mkLife(ps);
  const started = await life.start({ chatId: 'chat-a', stopAfter: 'G' });
  const run = started.run;
  const hash = 'd'.repeat(64);
  const rec = ps.append({ chatId: 'chat-a', messageRef: 'm', humanText: 't', binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: hash, expiresAt: Date.now() + 3600e3, runScope: { rootRunId: run.runId } });
  ps.revoke(rec.preauthId); // 布防前撤销
  await assistantText(life, waitBlock(run, hash));
  assert.equal(run.s.waitingForHuman, true, '撤销后的记录不得自动放行（同进程写盘即时生效）');

  // 登记新记录 → 撤销 → 发送同话术（登记+消费）：新登记发生在撤销后，应放行
  const phrase = exactText(run.runId, hash);
  const res = await life.submitHumanResponse('chat-a', phrase);
  assert.equal(res.byPreauth, true, '撤销后再发送话术=新授权，放行');
});

// ---------------------------------------------------------------- d3
await ok('d3 lifecycle 重启：WAITING 持久 → restoreActive 恢复 → 话术消费跨重启单次有效', async () => {
  const w = buildWorld(mkTemp());
  const psDir = mkTemp();
  const ps1 = new PreauthStore(psDir);
  const life1 = w.mkLife(ps1);
  const started = await life1.start({ chatId: 'chat-a', stopAfter: 'G' });
  const run = started.run;
  const hash = 'e'.repeat(64);
  // 预登记（旧进程视角）+ 布防（不自动放行 —— hash 不符的等待）
  await assistantText(life1, waitBlock(run, hash));
  assert.equal(run.s.waitingForHuman, true);
  // “重启”：全新 lifecycle + 全新 PreauthStore 实例（同根）
  const ps2 = new PreauthStore(psDir);
  const life2 = w.mkLife(ps2);
  const r = await life2.restoreActive();
  assert.equal(r.restored.length, 1, '等待中的 run 被恢复');
  assert.equal(r.errors.length, 0);
  const restored = life2.liveRuns.get(run.runId);
  assert.ok(restored, 'liveRuns 重建');
  assert.equal(restored.s.waitingForHuman, true, '等待状态跨重启保留');
  assert.equal(restored.s.waitingApprovalHash, hash);

  // 发送话术（登记+消费）→ 放行；事件写入同一持久 store
  const res = await life2.submitHumanResponse('chat-a', exactText(run.runId, hash));
  assert.equal(res.byPreauth, true, '重启后话术消费可用');
  assert.equal(restored.s.waitingForHuman, false);
  const evts = w.store.loadRun(run.runId).events.map((e) => e.event);
  assert.ok(evts.includes('GATE_PASSED_BY_PREAUTH') && evts.includes('GATE_PASSED'), '事件持久化');

  // 再次重启：已消费记录不复活 —— 新布防不再自动放行
  const life3 = w.mkLife(new PreauthStore(psDir));
  await life3.restoreActive();
  const r3 = life3.liveRuns.get(run.runId);
  await life3.onEvent({ id: 's-a' }, { type: 'turn/start', data: { turn: 2 } });
  const armResult = await assistantText(life3, waitBlock(r3, hash));
  assert.ok(Array.isArray(armResult) && armResult.some((x) => x?.waitingForHuman === true), '恢复后的 executor 能再次布防');
  assert.equal(r3.s.waitingForHuman, true, '消费过的授权不跨重启复活');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
