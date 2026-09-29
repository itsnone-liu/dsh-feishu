#!/usr/bin/env node
/**
 * audit/preauth-gate.test.mjs — P-B 门位通用化 + 预授权消费（全部离线）。
 *
 *  g1  任务书声明 stageGates（B4 SEAL / C2 REVEAL）：WAIT 块 reason 通用化、
 *      legacy 回退（无 stageGates 的 manifest，/^B4$/ 推断 SEAL）不回归。
 *  g2  D5 防绕过：门未放行时 READY_FOR_AUDIT 被拒（gateBypassBlocked），不发
 *      审核也不耗 marker 重试；人工批准（hash 相等）后 READY 不再被门拦截；
 *      二次 WAIT 重新布防（旧放行作废）。
 *  g3  hash 相等校验：话术合法但 hash ≠ waitingApprovalHash → 拒绝（旧代码只查
 *      话术格式的失配缺口）。
 *  g4  EXACT 预授权：匹配 → GATE_PASSED_BY_PREAUTH + GATE_PASSED 事件、规范
 *      批准话术注入 session、单次消费（重放 → 失配）；hash 不符 → GATE_PREAUTH_
 *      MISMATCH，仍等待，人工话术并行可用。
 *  g5  CONSTRAINT 预授权：上游 GATE_PASSED 证据 + git blob sha256 溯源 + ordinal
 *      上限全过 → 放行；上游缺失 / blob 不符 / ordinal 超限 / 绑定型不符 → 失配。
 *  g6  未装配 preauthStore：预授权话术按普通文本处理（人工路径拒绝），不崩。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { GitRemoteGate } from '../../src/audit/git-gate.js';
import { PreauthStore } from '../../src/audit/preauth-store.js';
import { PREAUTH_TEMPLATE_EXACT, PREAUTH_TEMPLATE_CONSTRAINT } from '../../src/audit/preauth-protocol.js';
import {
  buildSealApprovalText, buildRevealApprovalText,
  sealApprovalHash, revealApprovalHash,
} from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log(`PASS ${name}`);
}).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pb-'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 真实小 git 仓库（含一个 origin bare），为 CONSTRAINT blob 溯源服务。 */
const mkRepo = (files) => {
  const dir = mkTemp();
  const git = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  git(['add', '.']); git(['commit', '-q', '-m', 'c1']);
  return { dir, head: git(['rev-parse', 'HEAD']).trim() };
};

const STAGE_GATES = {
  B4: { kind: 'SEAL', bindings: ['EXACT'] },
  C2: { kind: 'REVEAL', bindings: ['CONSTRAINT'] },
};

/** harness：task packet 声明 stageGates + 可选 preauthStore。 */
const makeLife = (opts = {}) => {
  const root = mkTemp();
  const store = new AuditStore(path.join(root, 'audit-store'));
  const stages = opts.stages ?? ['B4', 'G'];
  const stageGates = opts.stageGates === null ? {} : (opts.stageGates ?? STAGE_GATES);
  const controller = new AuditController({ store, hostId: 'h1', cwd: root, repo: 'unused', branch: 'main', now: () => Date.now() });
  const agent = { id: 's-a', status: 'idle', cancel() {} };
  const prompts = [];
  const driver = { ensure: async () => agent, submit: (_a, t) => { prompts.push(t); return 'followup'; } };
  const gate = {
    inspect: async () => ({ cwd: opts.repoDir ?? root, repo: 'real-origin', branch: 'main', head: 'b'.repeat(40) }),
    isAncestor: async () => true,
    pushAndVerify: async ({ head }) => ({ ok: true, tipMatches: true, tip: head }),
  };
  const preauthStore = opts.preauthStore === undefined ? null : opts.preauthStore;
  const progress = [];
  const life = new AuditLifecycle({
    controller, driver,
    bindings: new Map([['chat-a', { sessionId: 's-a', cwd: root }]]),
    gitGateFactory: () => gate,
    taskPacketLoader: () => ({
      goal: 'g', approvedPlan: 'p', stages, stageRequirements: {},
      stageGates, preauthorization: Object.keys(stageGates).length ? { version: 1, gates: stageGates } : null,
      taskPacketHash: 'hash',
    }),
    onProgress: (p) => progress.push(p),
    reviewTimeoutMs: 200,
    preauthStore,
  });
  life.reviewer = opts.reviewer ?? null;
  controller.lifecycle = life;
  return { life, controller, store, agent, prompts, progress, gate, root, stages, preauthStore };
};

const startRun = (m, o = {}) => m.life.start({ chatId: 'chat-a', stopAfter: o.stopAfter ?? m.stages.at(-1) });
const event = (m, type, data) => m.life.onEvent({ id: m.agent.id }, { type, data });
const assistantText = (m, text) => event(m, 'assistant/message', { message: { content: [{ type: 'text', text }] } });
const waitBlock = (run, stage, hash, noun = 'receipt') =>
  `[DSH-AUDIT]\nSTATE: WAIT_HUMAN_APPROVAL\nRUN_ID: ${run.runId}\nSTAGE: ${stage}\nITERATION: 1\nHOST_ID: h1\nQUESTION:\n${noun}_sha256: ${hash}\n等待人工批准（仅授权本 ${noun}）`;
const events = (m, run) => m.store.loadRun(run.runId).events.map((e) => e.event);
const eventFind = (m, run, name) => m.store.loadRun(run.runId).events.filter((e) => e.event === name);

const exactText = (rootRunId, hash, gateKind = 'SEAL_ANNOTATION_ONLY', stage = 'B4') =>
  PREAUTH_TEMPLATE_EXACT
    .replaceAll('SEAL_ANNOTATION_ONLY', gateKind).replaceAll('于阶段 B4', `于阶段 ${stage}`)
    .replaceAll('<rootRunId>', rootRunId)
    .replaceAll('<expiresAt>', new Date(Date.now() + 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    .replaceAll('<64hex>', hash);

const constraintText = (upstreamHash, commit, file) =>
  PREAUTH_TEMPLATE_CONSTRAINT
    .replaceAll('<64hex>', upstreamHash)
    .replaceAll('<commit>', commit)
    .replaceAll('<path>', file);

const appendPreauth = (ps, input) => ps.append({
  chatId: 'chat-a', messageRef: 'msg-test', humanText: 'registered-in-test',
  expiresAt: Date.now() + 24 * 3600_000, ...input,
});

// ---------------------------------------------------------------- g1
await ok('g1 门位通用化：声明 stageGates（B4 SEAL / C2 REVEAL）reason 正确；legacy B4 回退不回归', async () => {
  const hashS = 'a'.repeat(64);
  const m = makeLife({ stages: ['B4', 'G'] });
  const started = await startRun(m); const run = started.run;
  await assistantText(m, waitBlock(run, 'B4', hashS));
  assert.equal(run.s.waitingForHuman, true);
  assert.equal(run.s.waitingReason, 'B4_SEAL_APPROVAL');
  assert.equal(run.s.waitingApprovalHash, hashS);

  const hashR = 'b'.repeat(64);
  const m2 = makeLife({ stages: ['C2', 'G'] });
  const started2 = await startRun(m2); const run2 = started2.run;
  await assistantText(m2, waitBlock(run2, 'C2', hashR, 'proposal'));
  assert.equal(run2.s.waitingReason, 'C2_REVEAL_APPROVAL');
  assert.equal(run2.s.waitingApprovalHash, hashR);

  // legacy：manifest 无 stageGates（旧任务书）→ /^B4$/ 推断 SEAL（老 run 不丢闸门）
  const m3 = makeLife({ stages: ['B4', 'G'], stageGates: null });
  const started3 = await startRun(m3); const run3 = started3.run;
  assert.equal(Object.keys(run3.manifest.stageGates ?? {}).length, 0, '旧任务书 manifest 无 stageGates 声明');
  await assistantText(m3, waitBlock(run3, 'B4', hashS));
  assert.equal(run3.s.waitingForHuman, true);
  assert.equal(run3.s.waitingReason, 'B4_SEAL_APPROVAL');
});

// ---------------------------------------------------------------- g2
await ok('g2 D5 防绕过：门未放行 READY 被拒；人工批准后放行；二次 WAIT 重新布防', async () => {
  const hash = 'c'.repeat(64);
  const m = makeLife({ stages: ['B4', 'G'] });
  const started = await startRun(m); const run = started.run;
  await event(m, 'turn/start', { turn: 1 });
  const readyText = `[DSH-AUDIT]\nSTATE: READY_FOR_AUDIT\nRUN_ID: ${run.runId}\nSTAGE: B4\nITERATION: 1\nHEAD: ${'d'.repeat(40)}\nHOST_ID: h1`;
  const blockedArr = await assistantText(m, readyText);
  assert.equal(blockedArr.some((r) => r?.gateBypassBlocked === true), true, 'READY 必须被人闸拦截');
  assert.equal(run.s.state, 'EXECUTING');
  assert.equal(run.s.waitingForHuman, false, '拦截不等于布防');

  // 人工批准（hash 相等）→ 门放行
  await assistantText(m, waitBlock(run, 'B4', hash));
  assert.equal(run.s.waitingForHuman, true);
  const resp = await m.life.submitHumanResponse('chat-a', buildSealApprovalText(hash));
  assert.equal(resp.handled, true);
  assert.equal(run.s.waitingForHuman, false);
  assert.deepEqual(run.s.humanGatePassed, { stage: 'B4', iteration: 1 });
  const afterArr = await assistantText(m, readyText);
  assert.equal(afterArr.some((r) => r?.gateBypassBlocked === true), false, '放行后 READY 不再被门拦截');
  // 注意：READY 受理后 run 推进（executorReady→push→AUDITING），"二次 WAIT 重新布防"
  // 用独立 run 验证（同 run 在 READY 受理后 re-WAIT 被忽略是正确行为）。
  const hash2 = '6'.repeat(64);
  const m2 = makeLife({ stages: ['B4', 'G'] });
  const started2 = await startRun(m2); const run2 = started2.run;
  await assistantText(m2, waitBlock(run2, 'B4', hash2));
  await m2.life.submitHumanResponse('chat-a', buildSealApprovalText(hash2));
  assert.deepEqual(run2.s.humanGatePassed, { stage: 'B4', iteration: 1 });
  await assistantText(m2, waitBlock(run2, 'B4', hash2));
  assert.equal(run2.s.humanGatePassed, null, '二次 WAIT（同 stage/iteration）旧放行作废');
  assert.equal(run2.s.waitingForHuman, true);
  const ready2 = `[DSH-AUDIT]\nSTATE: READY_FOR_AUDIT\nRUN_ID: ${run2.runId}\nSTAGE: B4\nITERATION: 1\nHEAD: ${'d'.repeat(40)}\nHOST_ID: h1`;
  const blocked2Arr = await assistantText(m2, ready2);
  assert.equal(blocked2Arr.some((r) => r?.gateBypassBlocked === true), true);
});

// ---------------------------------------------------------------- g3
await ok('g3 hash 相等校验：话术合法但 hash 不符 → 拒绝；REVEAL 门用 REVEAL 话术', async () => {
  const hash = 'e'.repeat(64);
  const m = makeLife({ stages: ['B4', 'G'] });
  const started = await startRun(m); const run = started.run;
  await assistantText(m, waitBlock(run, 'B4', hash));
  const wrong = await m.life.submitHumanResponse('chat-a', buildSealApprovalText('f'.repeat(64)));
  assert.equal(wrong.handled, false);
  assert.equal(wrong.invalidApproval, true);
  assert.match(wrong.reason, /hash/);
  assert.equal(run.s.waitingForHuman, true, 'hash 不符不放行');

  const right = await m.life.submitHumanResponse('chat-a', buildSealApprovalText(hash));
  assert.equal(right.handled, true);

  const hashR = '9'.repeat(64);
  const m2 = makeLife({ stages: ['C2', 'G'] });
  const s2 = await startRun(m2); const r2 = s2.run;
  await assistantText(m2, waitBlock(r2, 'C2', hashR, 'proposal'));
  const sealOnReveal = await m2.life.submitHumanResponse('chat-a', buildSealApprovalText(hashR));
  assert.equal(sealOnReveal.handled, false, 'REVEAL 门不收 SEAL 话术');
  const reveal = await m2.life.submitHumanResponse('chat-a', buildRevealApprovalText(hashR));
  assert.equal(reveal.handled, true);
  assert.equal(revealApprovalHash(buildRevealApprovalText(hashR)), hashR);
});

// ---------------------------------------------------------------- g4
await ok('g4 EXACT 预授权：放行+事件+单次消费；hash 不符 → MISMATCH 且人工路径并行可用', async () => {
  const hash = '1'.repeat(64);
  const ps = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const m = makeLife({ stages: ['B4', 'G'], preauthStore: ps });
  const started = await startRun(m); const run = started.run;
  await assistantText(m, waitBlock(run, 'B4', hash));
  const rec = appendPreauth(ps, {
    binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: hash,
    runScope: { rootRunId: run.runId },
  });
  const res = await m.life.submitHumanResponse('chat-a', exactText(run.runId, hash));
  assert.equal(res.byPreauth, true);
  assert.equal(res.preauthId, rec.preauthId);
  assert.equal(run.s.waitingForHuman, false);
  assert.ok(events(m, run).includes('GATE_PASSED_BY_PREAUTH'));
  assert.ok(events(m, run).includes('GATE_PASSED'));
  // 规范批准话术已注入绑定 session（与人工路径同一下游语义）
  assert.ok(m.prompts.some((t) => sealApprovalHash(t) === hash));
  assert.ok(m.progress.some((p) => p.event === 'GATE_PASSED_BY_PREAUTH'));
  // 话术即登记：首次 submit 除消费预置记录外还落了同 hash 新记录 → re-WAIT
  // 布防时被自动消费（g7 语义），门再次被预授权放行。
  await assistantText(m, waitBlock(run, 'B4', hash));
  assert.equal(run.s.waitingForHuman, false, '重复登记的记录在布防时自动放行');
  assert.equal(eventFind(m, run, 'GATE_PASSED_BY_PREAUTH').length, 2);

  // 第三次布防：无可用记录 → 正常等待；hash 不符的 EXACT → MISMATCH；人工并行。
  await assistantText(m, waitBlock(run, 'B4', hash));
  assert.equal(run.s.waitingForHuman, true);

  // hash 不符的 EXACT → MISMATCH；随后人工话术仍可放行（并行原则）
  const wrongHash = '2'.repeat(64);
  await appendPreauth(ps, {
    binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: wrongHash,
    runScope: { rootRunId: run.runId },
  });
  const mm = await m.life.submitHumanResponse('chat-a', exactText(run.runId, wrongHash));
  assert.notEqual(mm.byPreauth, true);
  assert.equal(run.s.waitingForHuman, true);
  const manual = await m.life.submitHumanResponse('chat-a', buildSealApprovalText(hash));
  assert.equal(manual.handled, true, '人工话术与预授权并行，失配不阻断');
});

// ---------------------------------------------------------------- g5
await ok('g5 CONSTRAINT 预授权：上游+blob+ordinal 全过放行；各失败维度失配', async () => {
  const proposalContent = 'proposal-exact-bytes-v1';
  const { dir, head } = mkRepo({ 'next_reveal/proposal.json': proposalContent });
  const blobHash = sha256(Buffer.from(proposalContent));
  const upstreamHash = '3'.repeat(64);

  const setUpC2 = async (ps) => {
    const m = makeLife({ stages: ['C2', 'G'], preauthStore: ps, repoDir: dir });
    const started = await startRun(m); const run = started.run;
    await assistantText(m, waitBlock(run, 'C2', blobHash, 'proposal'));
    return { m, run };
  };

  // 上游证据：本链 B4 GATE_PASSED（approvalHash = upstreamHash）
  const passUpstream = (m, run) => m.store.appendEvent({
    runId: run.runId, stage: 'B4', iteration: 1, headCommit: null,
    event: 'GATE_PASSED', timestamp: Date.now(), elapsedMs: null, tokens: null,
    dedupeKey: `t|${run.runId}|B4|gate`, approvalHash: upstreamHash,
  });

  const ps = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));

  // 注意 runScope.rootRunId 必须等于门位运行链 root —— 逐 case 显式建记录。
  const caseA = await setUpC2(ps);
  passUpstream(caseA.m, caseA.run);
  const recA = appendPreauth(ps, {
    binding: 'CONSTRAINT', gateKind: 'NEXT_REVEAL_ONLY', stage: 'C2',
    constraints: {
      maxOrdinal: 1,
      upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: upstreamHash }],
      receiptSource: { path: 'next_reveal/proposal.json', commit: head, fromCommitBlob: true },
    },
    runScope: { rootRunId: caseA.run.runId },
  });
  const resA = await caseA.m.life.submitHumanResponse('chat-a', constraintText(upstreamHash, head, 'next_reveal/proposal.json'));
  assert.equal(resA.byPreauth, true, '上游+blob+ordinal 全过应放行');
  assert.equal(resA.preauthId, recA.preauthId);
  assert.equal(caseA.run.s.waitingForHuman, false);

  // 上游缺失
  const ps2 = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const caseB = await setUpC2(ps2);
  appendPreauth(ps2, {
    binding: 'CONSTRAINT', gateKind: 'NEXT_REVEAL_ONLY', stage: 'C2',
    constraints: {
      maxOrdinal: 1,
      upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: upstreamHash }],
      receiptSource: { path: 'next_reveal/proposal.json', commit: head, fromCommitBlob: true },
    },
    runScope: { rootRunId: caseB.run.runId },
  });
  const resB = await caseB.m.life.submitHumanResponse('chat-a', constraintText(upstreamHash, head, 'next_reveal/proposal.json'));
  assert.notEqual(resB.byPreauth, true);
  assert.equal(caseB.run.s.waitingForHuman, true);
  assert.ok(events(caseB.m, caseB.run).includes('GATE_PREAUTH_MISMATCH'));

  // blob 不符（门位 hash ≠ blob sha256）
  const ps3 = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const caseC = await setUpC2(ps3);
  passUpstream(caseC.m, caseC.run);
  await assistantText(caseC.m, waitBlock(caseC.run, 'C2', '7'.repeat(64), 'proposal')); // 重布防为不匹配 hash
  appendPreauth(ps3, {
    binding: 'CONSTRAINT', gateKind: 'NEXT_REVEAL_ONLY', stage: 'C2',
    constraints: {
      maxOrdinal: 2,
      upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: upstreamHash }],
      receiptSource: { path: 'next_reveal/proposal.json', commit: head, fromCommitBlob: true },
    },
    runScope: { rootRunId: caseC.run.runId },
  });
  const resC = await caseC.m.life.submitHumanResponse('chat-a', constraintText(upstreamHash, head, 'next_reveal/proposal.json'));
  assert.notEqual(resC.byPreauth, true);
  assert.equal(caseC.run.s.waitingForHuman, true);

  // ordinal 超限：C2 第二次布防（ordinal=2，两次 NEED_USER 事件）而 maxOrdinal=1
  const ps4 = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const caseD = await setUpC2(ps4);
  passUpstream(caseD.m, caseD.run);
  await assistantText(caseD.m, waitBlock(caseD.run, 'C2', '0'.repeat(64), 'proposal')); // 第二次布防
  appendPreauth(ps4, {
    binding: 'CONSTRAINT', gateKind: 'NEXT_REVEAL_ONLY', stage: 'C2',
    constraints: {
      maxOrdinal: 1,
      upstream: [{ gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: upstreamHash }],
      receiptSource: { path: 'next_reveal/proposal.json', commit: head, fromCommitBlob: true },
    },
    runScope: { rootRunId: caseD.run.runId },
  });
  const resD = await caseD.m.life.submitHumanResponse('chat-a', constraintText(upstreamHash, head, 'next_reveal/proposal.json'));
  assert.notEqual(resD.byPreauth, true, 'ordinal=2 > maxOrdinal=1 必须失配');
  assert.equal(caseD.run.s.waitingForHuman, true);

  // 绑定型不符：门声明 bindings ['CONSTRAINT']，话术为 EXACT → 失配
  const caseE = await setUpC2(ps);
  const resE = await caseE.m.life.submitHumanResponse('chat-a', exactText(caseE.run.runId, blobHash, 'NEXT_REVEAL_ONLY', 'C2'));
  assert.notEqual(resE.byPreauth, true);
  assert.equal(caseE.run.s.waitingForHuman, true);
});

// ---------------------------------------------------------------- g6
await ok('g6 未装配 preauthStore：预授权话术走人工路径被拒，不崩', async () => {
  const hash = '5'.repeat(64);
  const m = makeLife({ stages: ['B4', 'G'], preauthStore: null });
  const started = await startRun(m); const run = started.run;
  await assistantText(m, waitBlock(run, 'B4', hash));
  const res = await m.life.submitHumanResponse('chat-a', exactText(run.runId, hash));
  assert.equal(res.byPreauth, false, '未装配 store 时无预授权路径（byPreauth 显式 false）');
  assert.equal(res.handled, false);
  assert.equal(run.s.waitingForHuman, true, '未装配即无人放行，fail-closed');
  const manual = await m.life.submitHumanResponse('chat-a', buildSealApprovalText(hash));
  assert.equal(manual.handled, true);
});

// ---------------------------------------------------------------- g7
await ok('g7 无人值守：WAIT 布防即自动尝试预授权（无需用户消息）；无记录则正常 NEED_USER', async () => {
  const hash = '8'.repeat(64);
  const ps = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const m = makeLife({ stages: ['B4', 'G'], preauthStore: ps });
  const started = await startRun(m); const run = started.run;
  appendPreauth(ps, {
    binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: hash,
    runScope: { rootRunId: run.runId },
  });
  await assistantText(m, waitBlock(run, 'B4', hash));
  assert.equal(run.s.waitingForHuman, false, '布防后预授权立即自动放行');
  assert.equal(run.s.humanGatePassed?.stage, 'B4');
  assert.ok(events(m, run).includes('GATE_PASSED_BY_PREAUTH'), '事件：GATE_PASSED_BY_PREAUTH');
  assert.ok(events(m, run).includes('GATE_PASSED'));
  assert.ok(m.prompts.some((t) => sealApprovalHash(t) === hash), '规范批准话术已注入 session');

  // 无记录 → 正常 NEED_USER 等待（§3 步骤 5），不产生事件噪音
  const ps2 = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const m2 = makeLife({ stages: ['B4', 'G'], preauthStore: ps2 });
  const s2 = await startRun(m2); const r2 = s2.run;
  await assistantText(m2, waitBlock(r2, 'B4', hash));
  assert.equal(r2.s.waitingForHuman, true, '无候选 → 现状 NEED_USER 路径');
  assert.ok(!events(m2, r2).includes('GATE_PASSED_BY_PREAUTH'));

  // 有记录但 hash 不符 → 布防不被自动放行（自动路径静默，等 NEED_USER 卡）
  const ps3 = new PreauthStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')));
  const m3 = makeLife({ stages: ['B4', 'G'], preauthStore: ps3 });
  const s3 = await startRun(m3); const r3 = s3.run;
  appendPreauth(ps3, {
    binding: 'EXACT', gateKind: 'SEAL_ANNOTATION_ONLY', stage: 'B4', receiptHash: '4'.repeat(64),
    runScope: { rootRunId: r3.runId },
  });
  await assistantText(m3, waitBlock(r3, 'B4', hash));
  assert.equal(r3.s.waitingForHuman, true, 'EXACT hash 不符不放行（fail-closed）');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
