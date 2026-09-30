#!/usr/bin/env node
/**
 * audit/r1-hotfix.test.mjs — R1 止血批次回归（F1-F7，全部离线，mkdtemp 隔离 store）。
 *
 *  t1  F1：B4 人闸 NEED_USER/WAITING_FOR_HUMAN 通知含 question+hash+可复制批准话术，
 *          话术必须通过 sealApprovalHash 且取回同一 hash；waitingQuestion 随
 *          clearHumanWait 清空；旧 state 无该字段不崩（序列化兼容）。
 *  t2  F2：NEED_USER 裁决 → VERDICT_NEED_USER 通知（verdictState/summary/question/nextStep 指引）。
 *  t3  F3：restoreActive 单 run 恢复失败 → onError(error, runId) 被调，code 透传。
 *  t4  F4：review 硬超时 → 不抛穿、reviewRounds latch 保留、REVIEW_TIMEOUT 通知、
 *          串行队列不被挂死的 review 排死（pause 立即可用）；git-gate/git-evidence
 *          execFileFn 收到 timeout 与 env.GIT_TERMINAL_PROMPT=0。
 *  t5  F5：pause→resume 真恢复 —— PAUSED → EXECUTING 且执行端 idle 时补发 stage prompt。
 *  t6  F5/D1：EXECUTING+pendingRemoteSync 的 run，retry 成功进 AUDITING → 自动审核触发。
 *  t7  F6：真实任务阶段表的 run，until B4 被接受（manifest.stages 校验）；A2 stub
 *          路径保持默认表行为。
 *  t8  F7：stop/pause 传播 agent.cancel({kind:'user'},{keepInbox:true})。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { AuditRun } from '../../src/audit/state-machine.js';
import { GitRemoteGate } from '../../src/audit/git-gate.js';
import { GitEvidenceProvider } from '../../src/audit/git-evidence.js';
import {
  buildExecutorMarkerText, parseExecutorMarker,
} from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log(`PASS ${name}`);
}).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r1-'));

/** 通用 harness：fake driver/gate + 真实 AuditExecutor（默认 executorFactory）。 */
const makeLife = (opts = {}) => {
  const root = mkTemp();
  const store = new AuditStore(path.join(root, 'audit-store'));
  const stages = opts.stages ?? ['T1', 'T2'];
  // controller 保持 A2 默认表（T1/T2/T3）：真实 run 的阶段表只来自任务书 manifest，
  // t7 借此证明 until 走的是 manifest.stages 而非 controller 默认表。
  const controller = new AuditController({ store, hostId: 'h1', cwd: root, repo: 'unused', branch: 'main', now: () => Date.now() });
  const agent = opts.agent ?? { id: 's-a', status: 'idle' };
  const prompts = [];
  const driver = opts.driver ?? {
    ensure: async () => agent,
    submit: (_a, t) => { prompts.push(t); return 'followup'; },
  };
  const gate = opts.gate ?? {
    inspect: async () => ({ cwd: root, repo: 'real-origin', branch: 'main', head: 'b'.repeat(40) }),
    isAncestor: async () => true,
    pushAndVerify: async ({ head }) => ({ ok: true, tipMatches: true, tip: head }),
  };
  const progress = [];
  const life = new AuditLifecycle({
    controller, driver,
    bindings: new Map([['chat-a', { sessionId: 's-a', cwd: root }]]),
    gitGateFactory: () => gate,
    taskPacketLoader: () => ({ goal: 'g', approvedPlan: 'p', stages, stageRequirements: {}, taskPacketHash: 'hash' }),
    onProgress: (p) => progress.push(p),
    onError: opts.onError,
    reviewTimeoutMs: opts.reviewTimeoutMs,
  });
  life.reviewer = opts.reviewer ?? null;
  controller.lifecycle = life;
  return { life, controller, store, agent, prompts, progress, gate, root, stages };
};

const startRun = (m, { stopAfter } = {}) => m.life.start({ chatId: 'chat-a', stopAfter: stopAfter ?? m.stages.at(-1) });

const event = (m, type, data) => m.life.onEvent({ id: m.agent.id }, { type, data });

const assistantText = (m, text) => event(m, 'assistant/message', { message: { content: [{ type: 'text', text }] } });

// ---------------------------------------------------------------- t1 (F1)
// 2026-09-30 业主指令（纯无人值守）：人闸（WAIT_HUMAN_APPROVAL/批准话术/
// submitHumanResponse/clearHumanWait）已整体删除，原 t1 F1 人闸通知用例随之
// 移除。替代回归：旧持久化 waitingForHuman=true 的 state 在加载时被确定性
// 解除（HUMAN_GATE_REMOVED），且不再产生任何等待通知。
await ok('t1 F1(重写): 旧 waitingForHuman state 加载即解除且无等待通知', async () => {
  const m = makeLife({ stages: ['B4', 'G'] });
  const started = await startRun(m, { stopAfter: 'G' });
  const run = started.run;
  assert.equal(run.s.currentStage, 'B4');
  // 手工把持久化 state 摆成旧人闸等待形态（模拟 2026-09-30 卡死事故现场）
  run.s.waitingForHuman = true;
  run.s.waitingReason = 'B4_SEAL_APPROVAL';
  run.s.waitingApprovalHash = 'a'.repeat(64);
  run.s.waitingQuestion = 'receipt_sha256: ...';
  m.store.saveState(run.s);
  const reloaded = AuditRun.open(m.store)(run.runId);
  assert.equal(reloaded.s.waitingForHuman, false, '加载即解除人闸等待');
  assert.equal(reloaded.s.waitingApprovalHash, null);
  assert.equal(reloaded.humanGateCleared, true, '供 lifecycle 补发阶段 prompt');
  const loaded = m.store.loadRun(run.runId);
  const ev = (loaded?.events ?? []).map((e) => e.event);
  assert.ok(ev.includes('HUMAN_GATE_REMOVED'), '解除留事件痕迹');
  assert.ok(!ev.includes('NEED_USER'), '人闸不再发 NEED_USER');
});

// ---------------------------------------------------------------- t2 (F2)
await ok('t2 F2: NEED_USER 裁决 → VERDICT_NEED_USER 通知含指引', async () => {
  const m = makeLife({
    reviewer: {
      review: async (packet) => ({
        state: 'NEED_USER', runId: packet.runId, hostId: packet.hostId,
        stage: packet.stage, iteration: packet.iteration,
        summary: ['需要人工确认依赖范围'], question: ['是否包含第三方依赖？'],
      }),
    },
  });
  const started = await startRun(m, { stopAfter: 'T2' });
  const run = started.run;
  const head = 'c1'.repeat(20);
  await event(m, 'turn/start', { turn: 1 });
  await assistantText(m, buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head }));
  await event(m, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(run.s.cause, 'NEED_USER');

  const p = m.progress.find((x) => x.event === 'VERDICT_NEED_USER');
  assert.ok(p, 'VERDICT_NEED_USER 通知必须发出（裁决结果不得静默）');
  assert.equal(p.verdictState, 'NEED_USER');
  assert.equal(p.summary, '需要人工确认依赖范围');
  assert.equal(p.question, '是否包含第三方依赖？');
  assert.match(p.nextStep, /\/audit resume/);
  assert.match(p.nextStep, /\/audit stop/);
});

await ok('t2b F2: TARGET_REACHED / 阶段推进 / REVISE 轮次耗尽也各发通知', async () => {
  // 到达停止点
  const mA = makeLife({
    reviewer: { review: async (packet) => ({ state: 'APPROVE', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration, summary: ['ok'] }) },
  });
  const a = await startRun(mA, { stopAfter: 'T1' });
  await event(mA, 'turn/start', { turn: 1 });
  await assistantText(mA, buildExecutorMarkerText({ runId: a.run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'aa'.repeat(20) }));
  await event(mA, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(a.run.s.state, 'STOPPED_TARGET_REACHED');
  const pa = mA.progress.find((x) => x.event === 'VERDICT_TARGET_REACHED');
  assert.ok(pa && pa.verdictState === 'APPROVE' && /audit next/.test(pa.nextStep));

  // 阶段推进
  const mB = makeLife({
    reviewer: { review: async (packet) => ({ state: 'APPROVE', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration, summary: ['ok'] }) },
  });
  const b = await startRun(mB, { stopAfter: 'T2' });
  await event(mB, 'turn/start', { turn: 1 });
  await assistantText(mB, buildExecutorMarkerText({ runId: b.run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'bb'.repeat(20) }));
  await event(mB, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(b.run.s.currentStage, 'T2');
  const pb = mB.progress.find((x) => x.event === 'VERDICT_STAGE_ADVANCED');
  assert.ok(pb && pb.stage === 'T2');

  // REVISE 轮次耗尽（maxReviewIterations=1 → 首次 REVISE 即耗尽）
  const mC = makeLife({
    reviewer: { review: async (packet) => ({ state: 'REVISE', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration, summary: ['redo'], reason: ['x'] }) },
  });
  const c = await mC.life.start({
    chatId: 'chat-a', stopAfter: 'T1',
  });
  // 直接压低上限（create 选项走 controller.maxReviewIterations，这里直接改 runOptions 落盘）
  c.run.s.runOptions = { maxReviewIterations: 1 };
  c.run.store.saveState(c.run.s);
  await event(mC, 'turn/start', { turn: 1 });
  await assistantText(mC, buildExecutorMarkerText({ runId: c.run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'cc'.repeat(20) }));
  await event(mC, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(c.run.s.state, 'PAUSED_NEEDS_USER');
  assert.equal(c.run.s.cause, 'REVISE_LOOP_EXHAUSTED');
  const pc = mC.progress.find((x) => x.event === 'VERDICT_REVISE_LOOP_EXHAUSTED');
  assert.ok(pc && /resume/.test(pc.nextStep));
});

// ---------------------------------------------------------------- t3 (F3)
await ok('t3 F3: restoreActive 单 run 失败 → onError(error, runId)，code 透传', async () => {
  let ensureCalls = 0;
  const agent = { id: 's-a', status: 'idle' };
  const driver = {
    ensureAuditSession: async () => {
      ensureCalls += 1;
      if (ensureCalls > 1) throw Object.assign(new Error('dedicated audit session is gone'), { code: 'AUDIT_SESSION_RESUME_FAILED' });
      return agent;
    },
    submit() {},
  };
  const seen = [];
  const m = makeLife({ driver, onError: (error, runId) => seen.push({ code: error?.code, runId }) });
  const started = await startRun(m, { stopAfter: 'T1' });
  assert.equal(ensureCalls, 1);

  const r = await m.life.restoreActive();
  assert.equal(seen.length, 1, 'onError 必须对失败 run 恰好调用一次');
  assert.equal(seen[0].runId, started.run.runId);
  assert.equal(seen[0].code, 'AUDIT_SESSION_RESUME_FAILED', 'error.code 必须原样透传');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'AUDIT_SESSION_RESUME_FAILED');
});

// ---------------------------------------------------------------- t4 (F4)
await ok('t4 F4: review 硬超时 → 不抛穿、latch 保留、通知发生、串行队列不被排死', async () => {
  let calls = 0;
  const m = makeLife({
    reviewTimeoutMs: 1,
    reviewer: { review: () => { calls += 1; return new Promise(() => {}); } }, // 永不 settle
  });
  const started = await startRun(m, { stopAfter: 'T2' });
  const run = started.run;
  await event(m, 'turn/start', { turn: 1 });
  await assistantText(m, buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'dd'.repeat(20) }));
  // 超时不得把 turn/end 的分发任务变成 rejection（此前挂死的 review 会永久占住 #serial）
  const res = await event(m, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.ok(Array.isArray(res));
  assert.equal(run.s.state, 'AUDITING', '超时按 infra 失败处理，不乱改 run 状态');
  assert.equal(calls, 1);

  const p = m.progress.find((x) => x.event === 'REVIEW_TIMEOUT');
  assert.ok(p, 'REVIEW_TIMEOUT 通知必须发出');
  assert.match(p.nextStep, /\/audit resume/);
  assert.match(p.nextStep, /\/audit stop/);

  // latch 保留：重复 turn/end 不再自动发起审核
  await event(m, 'turn/end', { turn: 1, reason: { kind: 'completed' } }).catch(() => {});
  assert.equal(calls, 1);
  assert.ok(m.life.reviewRounds.get(run.runId), 'reviewRounds latch 必须保留');

  // 串行队列未被挂死：pause 立即完成
  await m.life.control(run.runId, (r) => r.pause(), 'pause');
  assert.equal(run.s.state, 'PAUSED');
});

await ok('t4b F4: git-gate execFileFn 收到 timeout 与 env.GIT_TERMINAL_PROMPT=0（env 继承）', async () => {
  const seen = [];
  const fail = async (_cmd, _args, opts) => { seen.push(opts); throw new Error('stop'); };
  const gate = new GitRemoteGate({ cwd: '/w', execFileFn: fail });
  await gate.inspect({}).catch(() => {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeout, 120_000, '默认 gitTimeoutMs=120s');
  assert.equal(seen[0].env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(seen[0].env.PATH, process.env.PATH, 'env 必须继承进程环境（只增不改）');
  const gate2 = new GitRemoteGate({ cwd: '/w', execFileFn: fail, timeoutMs: 5 });
  await gate2.inspect({}).catch(() => {});
  assert.equal(seen.at(-1).timeout, 5, 'timeoutMs 构造参数可注入');
});

await ok('t4c F4: git-evidence execFileFn 收到 timeout 与 env.GIT_TERMINAL_PROMPT=0', async () => {
  const seen = [];
  const prov = new GitEvidenceProvider({ execFileFn: async (_cmd, _args, opts) => { seen.push(opts); return { stdout: Buffer.from('') }; } });
  await prov.build({ cwd: '/w', repo: 'r', branch: 'main', baseCommit: 'b'.repeat(40), targetCommit: 't'.repeat(40) }).catch(() => {});
  assert.equal(seen.length, 1, 'ls-remote 首调用即带超时选项');
  assert.equal(seen[0].timeout, 120_000);
  assert.equal(seen[0].env.GIT_TERMINAL_PROMPT, '0');
  const prov2 = new GitEvidenceProvider({ timeoutMs: 7, execFileFn: async (_c, _a, opts) => { seen.push(opts); return { stdout: Buffer.from('') }; } });
  await prov2.build({ cwd: '/w', branch: 'main', baseCommit: 'b', targetCommit: 't' }).catch(() => {});
  assert.equal(seen.at(-1).timeout, 7, 'timeoutMs 构造参数可注入');
});

// ---------------------------------------------------------------- t5 (F5)
await ok('t5 F5: pause→resume → EXECUTING 且执行端 idle 时补发 stage prompt', async () => {
  const m = makeLife();
  const started = await startRun(m, { stopAfter: 'T2' });
  const run = started.run;
  assert.equal(m.prompts.length, 1, 'start 发出初始 stage prompt');
  run.pause();
  assert.equal(run.s.state, 'PAUSED');

  await m.life.resume(run.runId, { human: true });
  assert.equal(run.s.state === 'EXECUTING' || AuditRun.open(m.store)(run.runId).s.state === 'EXECUTING', true);
  const fresh = AuditRun.open(m.store)(run.runId);
  assert.equal(fresh.s.state, 'EXECUTING', 'PAUSED 必须被真恢复（非 PAUSED_NEEDS_USER 路径）');
  assert.ok(m.prompts.length > 1, '恢复后必须补发 stage prompt（D4：idle 静坐没人管）');
  assert.match(m.prompts.at(-1), /STAGE: T1/);
  assert.match(m.prompts.at(-1), /READY_FOR_AUDIT/);
});

await ok('t5b F5: restoreActive（human=false）不得自动放行用户暂停的 run', async () => {
  const m = makeLife();
  const started = await startRun(m, { stopAfter: 'T1' });
  started.run.pause();
  const r = await m.life.restoreActive();
  assert.equal(r.errors.length, 0);
  assert.equal(AuditRun.open(m.store)(started.run.runId).s.state, 'PAUSED', '重启恢复后仍应保持 PAUSED');
});

// ---------------------------------------------------------------- t6 (F5/D1)
await ok('t6 F5/D1: EXECUTING+pendingRemoteSync 的 retry 成功进 AUDITING → 自动审核触发', async () => {
  let calls = 0;
  const m = makeLife({
    reviewer: {
      review: async (packet) => {
        calls += 1;
        return { state: 'APPROVE', runId: packet.runId, hostId: packet.hostId, stage: packet.stage, iteration: packet.iteration };
      },
    },
  });
  const started = await startRun(m, { stopAfter: 'T1' });
  const run = started.run;
  // 构造 D1 崩溃窗口：marker 已被接受（pendingRemoteSync 落盘）但 remote gate 未过、
  // 状态仍 EXECUTING —— 旧 retry 的前置守卫（wasWaiting）在该路径永不触发审核。
  const marker = parseExecutorMarker(buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: 'ee'.repeat(20) }));
  run.executorReady(marker);
  assert.equal(run.s.state, 'EXECUTING');
  assert.ok(run.s.pendingRemoteSync);

  await m.life.retry(run.runId);
  assert.equal(run.s.state, 'STOPPED_TARGET_REACHED', 'push retry 成功 → AUDITING → APPROVE → 停止点');
  assert.equal(calls, 1, '自动审核必须恰好触发一次');
  assert.ok(m.progress.some((x) => x.event === 'VERDICT_TARGET_REACHED'));
});

// ---------------------------------------------------------------- t7 (F6)
await ok('t7 F6: 真实任务阶段表的 run until B4 被接受；stub 路径保持默认表', async () => {
  const m = makeLife({ stages: ['A1', 'B4', 'G'] });
  const started = await startRun(m, { stopAfter: 'G' });
  assert.equal(started.run.s.currentStage, 'A1');

  const u = await m.controller.until('chat-a', 'B4');
  assert.equal(u.ok, true, `真实阶段表的 B4 必须被接受（controller 默认表是 T1/T2/T3）：${u.message}`);
  assert.equal(u.result.stopAfter, 'B4');
  assert.equal(u.result.changed, true);

  // 大小写不敏感解析到 manifest 原名
  const lc = await m.controller.until('chat-a', 'g');
  assert.equal(lc.ok, true);
  assert.equal(lc.result.stopAfter, 'G');

  // 未知阶段：错误信息携带 run 的真实阶段表，并透传内核错误
  const bad = await m.controller.until('chat-a', 'Z9');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'AUDIT_MANIFEST_INVALID');
  assert.match(bad.message, /A1, B4, G/);
  assert.doesNotMatch(bad.message, /T1, T2, T3/);

  // A2 stub 路径（无 lifecycle）：保持默认表行为
  const store2 = new AuditStore(mkTemp());
  const c2 = new AuditController({ store: store2, hostId: 'h1', now: () => Date.now() });
  const created = c2.createRun({ stopAfter: 'T2', chatId: 'chat-b' });
  assert.equal(created.ok, true);
  const stubBad = c2.until('chat-b', 'B4');
  assert.equal(stubBad.ok, false);
  assert.match(stubBad.message, /T1, T2, T3/);
  const stubOk = c2.until('chat-b', 'T3');
  assert.equal(stubOk.ok, true);
});

// ---------------------------------------------------------------- t8 (F7)
await ok('t8 F7: stop/pause 传播 agent.cancel({kind:"user"},{keepInbox:true})', async () => {
  const cancels = [];
  const agent = { id: 's-a', status: 'idle', cancel: (...args) => cancels.push(args) };
  const m = makeLife({ agent });
  const started = await startRun(m, { stopAfter: 'T1' });
  await m.life.control(started.run.runId, (r) => r.stop(), 'stop');
  assert.equal(cancels.length, 1, 'stop 必须对底层 agent 发起取消');
  assert.deepEqual(cancels[0], [{ kind: 'user' }, { keepInbox: true }]);
  assert.equal(m.life.executors.has(started.run.runId), false, 'stop 后 executor entry 摘除');

  const cancels2 = [];
  const agent2 = { id: 's-a', status: 'idle', cancel: (...args) => cancels2.push(args) };
  const m2 = makeLife({ agent: agent2 });
  const started2 = await startRun(m2, { stopAfter: 'T1' });
  await m2.life.control(started2.run.runId, (r) => r.pause(), 'pause');
  assert.equal(cancels2.length, 1, 'pause 同样必须取消在跑 turn');
  assert.deepEqual(cancels2[0], [{ kind: 'user' }, { keepInbox: true }]);
  assert.equal(m2.life.executors.has(started2.run.runId), true, 'pause 保留 executor entry（resume 复用）');

  // 无 cancel 接口的 agent（测试 stub）静默忽略，不抛
  const m3 = makeLife({ agent: { id: 's-a', status: 'idle' } });
  const started3 = await startRun(m3, { stopAfter: 'T1' });
  await m3.life.control(started3.run.runId, (r) => r.stop(), 'stop');
  assert.equal(started3.run.s.state, 'STOPPED');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
