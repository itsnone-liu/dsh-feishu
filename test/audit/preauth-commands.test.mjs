#!/usr/bin/env node
/**
 * audit/preauth-commands.test.mjs — P-C 命令面与溯源注入（离线）。
 *
 *  c1  registerPreauthPhrase：EXACT 逐字话术 → 记录（hash/运行链/有效期取自话术）；
 *      非话术文本 → ok:false；CONSTRAINT 无活跃运行链 → fail-closed。
 *  c2  /audit preauth 子命令：list/revoke/add 三态（未启用、无运行、阶段未声明、
 *      EXACT 等待中预填、CONSTRAINT 模板）。
 *  c3  gateProvenance：过门后的评审 packet 携带 declaredGate + GATE_PASSED 事件
 *      （approvalHash）；无门阶段不注入。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { PreauthStore } from '../../src/audit/preauth-store.js';
import { PREAUTH_TEMPLATE_EXACT, PREAUTH_TEMPLATE_CONSTRAINT } from '../../src/audit/preauth-protocol.js';
import { buildSealApprovalText, buildVerdictText, parseAuditorVerdict } from '../../src/audit/protocol.js';
import { handleAuditCommand, registerPreauthPhrase } from '../../src/audit/commands.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log(`PASS ${name}`);
}).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cmd-'));
const isoNoMs = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

const exactText = (rootRunId, hash) => PREAUTH_TEMPLATE_EXACT
  .replaceAll('<rootRunId>', rootRunId)
  .replaceAll('<expiresAt>', isoNoMs(Date.now() + 12 * 3600_000))
  .replaceAll('<64hex>', hash);

const makeLife = (opts = {}) => {
  const root = mkTemp();
  const store = new AuditStore(path.join(root, 'audit-store'));
  const controller = new AuditController({ store, hostId: 'h1', cwd: root, repo: 'unused', branch: 'main' });
  const agent = { id: 's-a', status: 'idle', cancel() {} };
  const prompts = [];
  const driver = { ensure: async () => agent, submit: (_a, t) => { prompts.push(t); return 'followup'; } };
  const gate = {
    inspect: async () => ({ cwd: opts.repoDir ?? root, repo: 'real-origin', branch: 'main', head: 'b'.repeat(40) }),
    isAncestor: async () => true,
    pushAndVerify: async ({ head }) => ({ ok: true, tipMatches: true, tip: head }),
  };
  const preauthStore = opts.preauthStore === undefined ? new PreauthStore(mkTemp()) : opts.preauthStore;
  const reviewPackets = [];
  const life = new AuditLifecycle({
    controller, driver,
    bindings: new Map([['chat-a', { sessionId: 's-a', cwd: root }]]),
    gitGateFactory: () => gate,
    taskPacketLoader: () => ({
      goal: 'g', approvedPlan: 'p', stages: opts.stages ?? ['B4', 'G'], stageRequirements: {},
      stageGates: opts.stageGates === null ? {} : (opts.stageGates ?? { B4: { kind: 'SEAL', bindings: ['EXACT'] } }),
      preauthorization: { version: 1, gates: { B4: { binding: ['EXACT'] } }, semantics: 'sem-test' },
      taskPacketHash: 'hash',
    }),
    onProgress: () => {},
    reviewTimeoutMs: 200,
    preauthStore,
  });
  life.reviewer = opts.reviewer ?? {
    review: async (packet) => {
      reviewPackets.push(packet);
      return parseAuditorVerdict(buildVerdictText({ state: 'APPROVE', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration }));
    },
  };
  controller.lifecycle = life;
  return { life, controller, store, agent, prompts, preauthStore, reviewPackets, root };
};

const assistantText = (m, text) => m.life.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const waitBlock = (run, stage, hash, noun = 'receipt') =>
  `[DSH-AUDIT]\nSTATE: WAIT_HUMAN_APPROVAL\nRUN_ID: ${run.runId}\nSTAGE: ${stage}\nITERATION: 1\nHOST_ID: h1\nQUESTION:\n${noun}_sha256: ${hash}\n等待人工批准（仅授权本 ${noun}）`;
const readyBlock = (run, stage) =>
  `[DSH-AUDIT]\nSTATE: READY_FOR_AUDIT\nRUN_ID: ${run.runId}\nSTAGE: ${stage}\nITERATION: 1\nHEAD: ${'d'.repeat(40)}\nHOST_ID: h1`;

// ---------------------------------------------------------------- c1
await ok('c1 registerPreauthPhrase：EXACT 话术登记；非话术拒绝；CONSTRAINT 无运行链拒绝', async () => {
  const ps = new PreauthStore(mkTemp());
  const hash = 'a'.repeat(64);
  const reg = registerPreauthPhrase({ preauthStore: ps }, exactText('audit_x_root', hash), 'chat-a', 'msg-1');
  assert.equal(reg.ok, true);
  assert.equal(reg.record.binding, 'EXACT');
  assert.equal(reg.record.stage, 'B4');
  assert.equal(reg.record.gateKind, 'SEAL_ANNOTATION_ONLY');
  assert.equal(reg.record.receiptHash, hash);
  assert.equal(reg.record.runScope.rootRunId, 'audit_x_root');
  assert.equal(reg.record.messageRef, 'msg-1');
  // 话术内 12h 有效期被采纳（不是命令层默认 24h）
  const expect = Date.now() + 12 * 3600_000;
  assert.ok(Math.abs(reg.record.expiresAt - expect) < 5_000, 'expiresAt 取自话术文本');

  const notPhrase = registerPreauthPhrase({ preauthStore: ps }, '随便一句话', 'chat-a');
  assert.equal(notPhrase.ok, false);

  const constraintPhrase = PREAUTH_TEMPLATE_CONSTRAINT
    .replaceAll('<64hex>', 'b'.repeat(64))
    .replaceAll('<commit>', 'c'.repeat(40))
    .replaceAll('<path>', 'next_reveal/proposal.json');
  const noChain = registerPreauthPhrase({ preauthStore: ps, lifecycle: null }, constraintPhrase, 'chat-a');
  assert.equal(noChain.ok, false, 'CONSTRAINT 无活跃运行链 → fail-closed');
});

// ---------------------------------------------------------------- c2
await ok('c2 /audit preauth 子命令：add/list/revoke 全路径', async () => {
  const noStore = await handleAuditCommand(null, 'preauth list', 'chat-a', {});
  assert.ok(/未启用/.test(noStore.title) || /PreauthStore/.test(noStore.body));

  const m = makeLife();
  const started = await m.life.start({ chatId: 'chat-a', stopAfter: 'G' });
  const run = started.run;
  const ctx = { preauthStore: m.preauthStore, lifecycle: m.life };

  // 阶段未声明
  const undeclared = await handleAuditCommand(m.controller, 'preauth add D', 'chat-a', ctx);
  assert.match(undeclared.title, /未声明/);

  // 等待中 → EXACT 预填（hash = waitingApprovalHash）
  const hash = 'e'.repeat(64);
  await assistantText(m, waitBlock(run, 'B4', hash));
  const addCard = await handleAuditCommand(m.controller, 'preauth add B4', 'chat-a', ctx);
  assert.match(addCard.title, /EXACT/);
  assert.ok(addCard.body.includes(hash), '预填话术含当前门位 hash');
  assert.ok(addCard.body.includes(run.manifest.rootRunId ?? run.runId));

  // 发送预填话术 → 等待中被消费路径放行
  const phrase = addCard.body.split('```\n')[1].split('\n```')[0];
  const res = await m.life.submitHumanResponse('chat-a', phrase);
  assert.equal(res.byPreauth, true, '登记话术在等待中直接消费放行');

  // list 显示已消费
  const listCard = await handleAuditCommand(m.controller, 'preauth list', 'chat-a', ctx);
  assert.match(listCard.body, /已消费@B4/);

  // 无等待时再登记一条 → revoke 生效
  const hash2 = 'f'.repeat(64);
  const reg2 = registerPreauthPhrase({ preauthStore: m.preauthStore, lifecycle: m.life }, exactText(run.runId, hash2), 'chat-a');
  assert.equal(reg2.ok, true);
  const revokeCard = await handleAuditCommand(m.controller, `preauth revoke ${reg2.record.preauthId}`, 'chat-a', ctx);
  assert.match(revokeCard.title, /撤销/);
  const list2 = await handleAuditCommand(m.controller, 'preauth list', 'chat-a', ctx);
  assert.match(list2.body, /已撤销/);
  const badRevoke = await handleAuditCommand(m.controller, 'preauth revoke pa_nope', 'chat-a', ctx);
  assert.match(badRevoke.title, /撤销失败/);

  // CONSTRAINT-only 门 → 待填模板
  const m2 = makeLife({ stages: ['C2', 'G'], stageGates: { C2: { kind: 'REVEAL', bindings: ['CONSTRAINT'] } } });
  const s2 = await m2.life.start({ chatId: 'chat-a', stopAfter: 'G' });
  const tmplCard = await handleAuditCommand(m2.controller, 'preauth add C2', 'chat-a', { preauthStore: m2.preauthStore, lifecycle: m2.life });
  assert.match(tmplCard.title, /CONSTRAINT/);
  assert.ok(tmplCard.body.includes('<commit>') || tmplCard.body.includes('<64hex>'), '模板保留待填占位符');
});

// ---------------------------------------------------------------- c3
await ok('c3 gateProvenance：过门阶段评审包携带 declaredGate + GATE_PASSED(approvalHash)；无门阶段不注入', async () => {
  const hash = '9'.repeat(64);
  const m = makeLife({ stages: ['B4', 'G'] });
  const started = await m.life.start({ chatId: 'chat-a', stopAfter: 'G' });
  const run = started.run;
  // 过门（人工话术）→ READY → turn/end → 推送 → 自动评审
  await assistantText(m, waitBlock(run, 'B4', hash));
  await m.life.submitHumanResponse('chat-a', buildSealApprovalText(hash));
  await m.life.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await assistantText(m, readyBlock(run, 'B4'));
  await m.life.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, usage: { totalTokens: 10 } } });
  await new Promise((r) => setTimeout(r, 50));
  const gated = m.reviewPackets.find((p) => p.stage === 'B4');
  assert.ok(gated, 'B4 阶段已触发评审');
  assert.equal(gated.gateProvenance.declaredGate.kind, 'SEAL');
  const gatePassed = gated.gateProvenance.events.find((e) => e.event === 'GATE_PASSED');
  assert.equal(gatePassed.approvalHash, hash, '人工批准的 hash 进入溯源');
  assert.equal(gated.gateProvenance.preauthorizationSemantics, 'sem-test');

  // 无门阶段（G）不注入
  const m2 = makeLife({ stages: ['G'], stageGates: null });
  const s2 = await m2.life.start({ chatId: 'chat-a', stopAfter: 'G' });
  const run2 = s2.run;
  await m2.life.onEvent({ id: m2.agent.id }, { type: 'turn/start', data: { turn: 1 } });
  await assistantText(m2, readyBlock(run2, 'G'));
  await m2.life.onEvent({ id: m2.agent.id }, { type: 'turn/end', data: { turn: 1, usage: { totalTokens: 10 } } });
  await new Promise((r) => setTimeout(r, 50));
  const noGate = m2.reviewPackets.at(-1);
  assert.ok(noGate, 'G 阶段已触发评审');
  assert.equal(noGate.gateProvenance, undefined, '无门阶段不注入 gateProvenance');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
