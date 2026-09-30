#!/usr/bin/env node
/**
 * audit/incident-repair.test.mjs — P-E 简化版「重试-停机-汇报」机制测试。
 *
 * 用户定稿（2026-09-29）：程序只做确定性重试 → 失败停机 → 汇报；
 * 修复由人工做（多修几次，常见问题慢慢消失），程序内不派修复 agent。
 *
 * 覆盖：
 *  - 执行端事件抛错 → 事故落盘（incident.json open）→ 停自动重试 →
 *    汇报卡片（trigger + 现场摘要 + 「人工修复后 /audit resume」指引）；
 *  - 不派修：没有任何修复 session 被创建/提交；
 *  - 事故停机中的 run 拒绝自动 resume（AUTO 也不放行）；
 *  - 人工 resume → 事故 resolved + 续跑补发阶段 prompt + RESOLVED 汇报；
 *  - 桥重启：open 事故只闸住 + 提醒，不自动恢复；
 *  - 用户 stop → 事故撤销；
 *  - 审核侧保留路径：WAIT_WEB_QUOTA 退避后自动恢复重审（旧死胡同修复）；
 *  - AUDIT_REVIEW_INFRA 重试后升级停机事故。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AuditStore } from '../../src/audit/store.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { parseExecutorMarker, buildExecutorMarkerText, parseAuditorVerdict, buildVerdictText } from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log(`PASS ${name}`);
}).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pe-'));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  git(work, 'init', '-b', 'main'); git(work, 'config', 'user.email', 'a@b.invalid'); git(work, 'config', 'user.name', 'A');
  fs.writeFileSync(path.join(work, 'README'), 'base'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  return { root, work, head: git(work, 'rev-parse', 'HEAD') };
};

const ctrl = (root, work) => new AuditController({
  store: new AuditStore(path.join(root, 'audit-store')), hostId: 'h1', cwd: work,
  repo: 'unused', branch: 'main', stages: ['T1', 'T2'], now: () => Date.now(),
});

/** 假 driver：记录 submit（事故流程不应产生任何 submit）。 */
const makeDriver = () => {
  const d = {
    live: new Map(),
    submitted: [],
    auditAgent: { id: 's-audit', status: 'idle', cancelled: 0, cancel() { this.cancelled += 1; } },
    async ensureAuditSession() { return d.auditAgent; },
    submit(agent, text) { d.submitted.push({ id: agent.id, text }); },
  };
  return d;
};

/** 假 executor：可编程 onEvent（默认正常忽略），记录 startStage。 */
const makeExecutorFactory = (behavior = {}) => {
  const calls = { onEvent: 0, startStage: 0 };
  const factory = (opts) => ({
    async start({ run, agent }) { this.run = run; this.agent = agent; },
    async onEvent() {
      calls.onEvent += 1;
      if (behavior.throwOnEvent) throw behavior.throwOnEvent;
      return { ignored: true };
    },
    startStage() { calls.startStage += 1; opts.driver.submit(this.agent, `replayed:${this.run?.s?.currentStage}`); },
    async applyVerdict(id, v) { return this.run.auditorVerdict(v); },
    cancel() {}, stop() {},
  });
  factory.calls = calls;
  return factory;
};

const gate = (f) => ({ inspect: async () => ({ cwd: f.work, repo: 'real-origin', branch: 'main', head: f.head }), pushAndVerify: async () => ({ ok: true, tipMatches: true }) });

const lifeOpts = (f, c, driver, executorFactory, extra = {}) => ({
  controller: c, driver, bindings: new Map([['chat-a', { sessionId: 's-obs', cwd: f.work }]]),
  gitGateFactory: () => gate(f),
  taskPacketLoader: () => ({ goal: 'g', approvedPlan: 'p', stages: ['T1', 'T2'], stageRequirements: {}, taskPacketHash: 'hash' }),
  executorFactory,
  approvalPolicy: 'AUTO',
  reviewRetryDelays: [5, 5, 5, 5],
  onProgress: extra.onProgress,
  ...extra,
});

/** 触发事故的最短公开路径：executor onEvent 抛错（EXECUTOR_EVENT_FAILED）。 */
const raiseViaExecutorError = async (life) => {
  await assert.rejects(
    () => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }),
    /kaboom/,
  );
  await sleep(30); // #raiseIncidentSafe 是异步链
};

await ok('executor event failure → incident persisted open + halt + report card, NO repair dispatch', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const notices = [];
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory, { onProgress: (p) => notices.push(p) }));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await raiseViaExecutorError(life);
  const inc = c.store.readIncident(r.run.runId);
  assert.equal(inc.status, 'open');
  assert.equal(inc.trigger, 'EXECUTOR_EVENT_FAILED');
  assert.ok(life.incidents.has(r.run.runId));
  // 停机汇报卡片：trigger + 现场摘要 + 人工指引
  const raised = notices.find((p) => p.event === 'AUDIT_INCIDENT_RAISED');
  assert.ok(raised, 'AUDIT_INCIDENT_RAISED notified');
  assert.match(raised.reason, /EXECUTOR_EVENT_FAILED.*kaboom/);
  assert.match(raised.question, /"trigger": "EXECUTOR_EVENT_FAILED"/);
  assert.match(raised.nextStep, /\/audit resume/);
  // 简化版核心断言：没有任何修复 session / 派修 prompt
  assert.equal(driver.submitted.length, 0, 'no repair prompt submitted');
  // recovery.jsonl 留痕（完整事故报告）
  const recs = c.store.listRecoveryIncidents(r.run.runId);
  assert.ok(recs.length >= 1 && recs[0].incident.trigger === 'EXECUTOR_EVENT_FAILED');
  assert.ok(recs[0].incident.git || recs[0].incident.state, 'incident report carries context');
});

await ok('open incident blocks automatic resume (AUTO policy); human resume resolves + replays stage prompt', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const notices = [];
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory, { onProgress: (p) => notices.push(p) }));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await raiseViaExecutorError(life);
  // AUTO 自动 resume 被拒（事故停机必须人工）
  await assert.rejects(() => life.resume(r.run.runId, { human: false }), (e) => e.code === 'AUDIT_INCIDENT_OPEN');
  // 人工 resume：关闭事故 + 补发阶段 prompt（EXECUTING + idle）+ RESOLVED 汇报
  await life.resume(r.run.runId, { human: true });
  const inc = c.store.readIncident(r.run.runId);
  assert.equal(inc.status, 'resolved');
  assert.match(inc.resolution, /human/);
  assert.ok(!life.incidents.has(r.run.runId), 'latch cleared');
  assert.equal(execFactory.calls.startStage, 1);
  assert.ok(driver.submitted.some((s) => String(s.text).startsWith('replayed:T1')));
  assert.ok(notices.some((p) => p.event === 'AUDIT_INCIDENT_RESOLVED'));
});

await ok('bridge restart with open incident → latch + reminder, run NOT auto-resumed', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver1 = makeDriver();
  const notices2 = [];
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life1 = new AuditLifecycle(lifeOpts(f, c, driver1, execFactory));
  const r = await life1.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await raiseViaExecutorError(life1);
  assert.equal(c.store.readIncident(r.run.runId).status, 'open');

  // 桥重启：全新 lifecycle，只剩持久化 store。
  const driver2 = makeDriver();
  const execFactory2 = makeExecutorFactory();
  const life2 = new AuditLifecycle(lifeOpts(f, c, driver2, execFactory2, { onProgress: (p) => notices2.push(p) }));
  const { restored } = await life2.restoreActive();
  assert.equal(restored.length, 0, 'open-incident run is NOT auto-resumed');
  assert.ok(life2.incidents.has(r.run.runId), 'incident latched');
  assert.equal(c.store.readIncident(r.run.runId).status, 'open', 'still open on disk');
  const reminder = notices2.find((p) => p.event === 'AUDIT_INCIDENT_RAISED');
  assert.ok(reminder, 'restart reminder notified');
  assert.match(reminder.reason, /未解决事故/);
  assert.match(reminder.nextStep, /\/audit resume/);
  // 人工 resume 仍可续跑
  await life2.resume(r.run.runId, { human: true });
  assert.equal(c.store.readIncident(r.run.runId).status, 'resolved');
  assert.equal(execFactory2.calls.startStage, 1);
});

await ok('user stop revokes the incident (no lingering halt)', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await raiseViaExecutorError(life);
  await life.control(r.run.runId, async (run) => run.stop(), 'stop');
  assert.equal(c.store.readIncident(r.run.runId)?.status, 'resolved');
  assert.ok(!life.incidents.has(r.run.runId));
});

await ok('WAIT_WEB_QUOTA is no longer a dead end: paced retry recovers and re-reviews', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory();
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  // 直接驱动状态机到 AUDITING + auditInFlight（状态持久化，resume 重开同一状态）
  const marker = parseExecutorMarker(buildExecutorMarkerText({ runId: r.run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: f.head }));
  r.run.executorReady(marker, {});
  r.run.remoteSyncResult({ ok: true, tipMatches: true });
  const liveState = () => life.liveRuns.get(r.run.runId)?.s.state ?? c.store.loadRun(r.run.runId)?.state.state;
  assert.equal(liveState(), 'AUDITING');
  const reviews = [];
  const verdict = parseAuditorVerdict(buildVerdictText({ state: 'APPROVE', runId: r.run.runId, hostId: 'h1', stage: 'T1', iteration: 1 }));
  life.reviewer = {
    review: async () => {
      reviews.push(Date.now());
      if (reviews.length === 1) throw Object.assign(new Error('web quota'), { code: 'AUDIT_WEB_QUOTA' });
      return verdict;
    },
  };
  await life.resume(r.run.runId); // 尾部触发 #maybeAutoReviewLocked → review#1 → WAIT_WEB_QUOTA
  assert.equal(liveState(), 'WAIT_WEB_QUOTA');
  await sleep(40); // 退避 5ms 后：webQuotaRecovered + 同轮重发 → review#2 → APPROVE
  assert.equal(reviews.length, 2, 'review retried exactly once after quota wait');
  assert.equal(liveState(), 'EXECUTING'); // APPROVE 推进到下一阶段
});

await ok('AUDIT_REVIEW_INFRA: deterministic retries then halts as incident (no repair dispatch)', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory();
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory, { reviewInfraIncidentAfter: 2 }));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  const marker = parseExecutorMarker(buildExecutorMarkerText({ runId: r.run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: f.head }));
  r.run.executorReady(marker, {});
  r.run.remoteSyncResult({ ok: true, tipMatches: true });
  let reviews = 0;
  life.reviewer = { review: async () => { reviews += 1; throw Object.assign(new Error('infra boom'), { code: 'AUDIT_REVIEW_INFRA' }); } };
  await life.resume(r.run.runId); // review#1 → 退避
  await sleep(40); // retry → review#2 → 退避
  await sleep(40); // retry → review#3 → 超过阈值(2) → 停机事故
  assert.ok(reviews >= 3);
  const inc = c.store.readIncident(r.run.runId);
  assert.equal(inc?.status, 'open');
  assert.equal(inc?.trigger, 'AUDIT_REVIEW_INFRA');
  assert.equal(driver.submitted.length, 0, 'no repair prompt — simplified mode');
  // 事故停机中自动 resume 被拒
  await assert.rejects(() => life.resume(r.run.runId), (e) => e.code === 'AUDIT_INCIDENT_OPEN');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
