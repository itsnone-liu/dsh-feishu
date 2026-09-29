#!/usr/bin/env node
/**
 * audit/incident-repair.test.mjs — P-E「停-报-修-续」机制测试。
 *
 * 覆盖：
 *  - repair-protocol：prompt 构造 / [DSH-REPAIR] 报告块解析（DONE/BLOCKED/
 *    残缺/身份失配）；
 *  - 事故链路：执行端事件抛错 → 事故落盘（incident.json open）→ 停自动重试
 *    → 派修复 agent（prompt 含完整事故报告）；
 *  - 修复 DONE（不重启）→ 事故 resolved → 自动 resume + 补发阶段 prompt；
 *  - 修复 DONE + RESTART:yes → 先落盘 resolved 再触发 restartBridge，不 resume；
 *  - 修复 BLOCKED → 按退避重派（携带上次摘要）；连续 BLOCKED 达阈值 →
 *    取消卡死执行端 turn + 直接续跑（操作复位）；
 *  - 桥重启恢复：open 事故跨 lifecycle 重建 → 继续派修；
 *  - 审核侧：WAIT_WEB_QUOTA 不再是死胡同（退避后 webQuotaRecovered + 重发
 *    同轮审核）；AUDIT_REVIEW_INFRA 连续失败升级为事故。
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
import { buildRepairPrompt, buildRepairNudge, parseRepairReport } from '../../src/audit/repair-protocol.js';

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

/** 可编排的假 driver：记录 submit，能控制 audit/repair session 状态。 */
const makeDriver = () => {
  const d = {
    live: new Map(),
    submitted: [],
    repairCount: 0,
    // 真实 driver：cancel 后 turn 停止时 status 才翻回 idle；这里同步翻转模拟落定。
    auditAgent: { id: 's-audit', status: 'idle', cancelled: 0, cancel() { this.cancelled += 1; this.status = 'idle'; } },
    async ensureAuditSession() { return d.auditAgent; },
    async ensureRepairSession({ sessionId = null } = {}) {
      // 同一 run 的修复 session 优先复用（resume 语义）
      if (sessionId && d.live.has(sessionId)) return d.live.get(sessionId).agent;
      d.repairCount += 1;
      const agent = { id: `s-repair-${d.repairCount}`, status: 'idle' };
      d.live.set(agent.id, { agent });
      return agent;
    },
    submit(agent, text) { d.submitted.push({ id: agent.id, text }); },
  };
  d.live.set(d.auditAgent.id, { agent: d.auditAgent });
  return d;
};

/** 假 executor：可编程 onEvent（默认正常忽略），记录 startStage。 */
const makeExecutorFactory = (behavior = {}) => {
  const calls = { onEvent: 0, startStage: 0, applyVerdict: 0 };
  const factory = (opts) => ({
    runs: new Map(),
    async start({ run, agent }) { this.run = run; this.agent = agent; },
    onEvent: async () => {
      calls.onEvent += 1;
      if (behavior.throwOnEvent) throw behavior.throwOnEvent;
      return { ignored: true };
    },
    startStage() { calls.startStage += 1; opts.driver.submit(this.agent, `replayed:${this.run?.s?.currentStage}`); },
    async applyVerdict(id, v) {
      calls.applyVerdict += 1;
      if (behavior.applyVerdict) return behavior.applyVerdict(id, v);
      // 默认走真实状态机（测试里直接驱动 AUDITING 时可断言推进）
      return this.run.auditorVerdict(v);
    },
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
  repairCwd: f.root, repairRetryDelays: [5, 5, 5, 5], reviewRetryDelays: [5, 5, 5, 5],
  ...extra,
});

/** 触发事故的最短公开路径：executor onEvent 抛错（EXECUTOR_EVENT_FAILED）。 */
const raiseViaExecutorError = async (life, execFactory) => {
  execFactory.behaviorThrow = true;
  await assert.rejects(
    () => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }),
    /kaboom/,
  );
  await sleep(30); // #raiseIncidentSafe 是异步链
};

const doneMarker = (runId, incidentId, { restart = 'no', files = ['- src/x.js'] } = {}) =>
  `[DSH-REPAIR]\nRUN_ID: ${runId}\nINCIDENT_ID: ${incidentId}\nSTATUS: DONE\nRESTART: ${restart}\nFILES:\n${files.join('\n')}\nSUMMARY:\n根因X已修复，测试通过`;

const blockedMarker = (runId, incidentId, why = '无法定位') =>
  `[DSH-REPAIR]\nRUN_ID: ${runId}\nINCIDENT_ID: ${incidentId}\nSTATUS: BLOCKED\nRESTART: no\nFILES:\n-\nSUMMARY:\n${why}`;

const deliverRepairReport = async (life, driver, marker) => {
  const rp = [...life.repairs.values()][0];
  assert.ok(rp, 'repair session should be live');
  await life.onEvent(rp.agent, { type: 'assistant/message', data: { content: [{ type: 'text', text: marker }] } });
  await life.onEvent(rp.agent, { type: 'turn/end', data: {} });
  await sleep(30);
  return rp;
};

// ---------- repair-protocol 纯函数 ----------

await ok('parseRepairReport: DONE with files', () => {
  const r = parseRepairReport(doneMarker('run1', 'inc1'), { runId: 'run1', incidentId: 'inc1' });
  assert.equal(r.status, 'DONE');
  assert.equal(r.restart, false);
  assert.deepEqual(r.files, ['src/x.js']);
  assert.match(r.summary, /根因X/);
});

await ok('parseRepairReport: identity mismatch rejected (stale marker)', () => {
  assert.equal(parseRepairReport(doneMarker('run1', 'inc1'), { runId: 'run1', incidentId: 'OTHER' }), null);
  assert.equal(parseRepairReport(doneMarker('run1', 'inc1'), { runId: 'run2', incidentId: 'inc1' }), null);
});

await ok('parseRepairReport: malformed / blocked / no-marker', () => {
  assert.equal(parseRepairReport('[DSH-REPAIR]\nRUN_ID: r\nINCIDENT_ID: i\nSTATUS: MAYBE\n'), null);
  assert.equal(parseRepairReport('普通文本'), null);
  const b = parseRepairReport(blockedMarker('r', 'i'), { runId: 'r', incidentId: 'i' });
  assert.equal(b.status, 'BLOCKED');
  assert.equal(b.files.length, 0); // "-" 占位不进 files
  const d = parseRepairReport(doneMarker('r', 'i', { restart: 'yes', files: ['-'] }));
  assert.equal(d.restart, true);
  assert.equal(d.files.length, 0);
});

await ok('buildRepairPrompt carries report + paths + strict block', () => {
  const p = buildRepairPrompt({ incident: { trigger: 'X', state: 'EXECUTING' }, runId: 'r1', incidentId: 'i1', attempt: 2, workspace: '/w', bridgeRoot: '/b', logFile: '/l', previousBlockedSummary: '上次没找到' });
  assert.match(p, /第 2 次尝试/);
  assert.match(p, /\/w/); assert.match(p, /\/b/); assert.match(p, /\/l/);
  assert.match(p, /\[DSH-REPAIR\]/);
  assert.match(p, /上次没找到/);
  assert.match(p, /AUDIT_REVIEW_INFRA|X/); // incident JSON 序列化进 prompt
});

await ok('buildRepairNudge is parseable as a report skeleton', () => {
  assert.match(buildRepairNudge({ runId: 'r', incidentId: 'i' }), /\[DSH-REPAIR\]/);
});

// ---------- 事故链路（停-报-修-续） ----------

await ok('executor event failure → incident persisted open + repair agent dispatched', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  const inc = c.store.readIncident(r.run.runId);
  assert.equal(inc.status, 'open');
  assert.equal(inc.trigger, 'EXECUTOR_EVENT_FAILED');
  assert.equal(driver.repairCount, 1);
  const prompt = driver.submitted.find((s) => s.id === 's-repair-1').text;
  assert.match(prompt, /EXECUTOR_EVENT_FAILED/);       // 完整事故报告进了 prompt
  assert.match(prompt, new RegExp(r.run.runId));
  assert.ok(life.incidents.has(r.run.runId));
  // recovery.jsonl 留痕
  const recs = c.store.listRecoveryIncidents(r.run.runId);
  assert.ok(recs.length >= 1 && recs[0].incident.trigger === 'EXECUTOR_EVENT_FAILED');
});

await ok('repair DONE (no restart) → incident resolved + auto-resume + stage replay', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  const inc = c.store.readIncident(r.run.runId);
  await deliverRepairReport(life, driver, doneMarker(r.run.runId, inc.incidentId));
  const resolved = c.store.readIncident(r.run.runId);
  assert.equal(resolved.status, 'resolved');
  assert.match(resolved.resolution, /根因X/);
  assert.ok(!life.incidents.has(r.run.runId), 'latch cleared');
  // D4 补发：EXECUTING + idle → startStage
  assert.equal(execFactory.calls.startStage, 1);
  assert.ok(driver.submitted.some((s) => s.text.startsWith('replayed:T1')));
});

await ok('repair DONE + RESTART:yes → resolved persisted BEFORE restartBridge, no resume', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  let restarts = 0; let statusAtRestart = null;
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory, {
    restartBridge: async () => { restarts += 1; statusAtRestart = c.store.readIncident(r.run.runId)?.status; },
  }));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  const inc = c.store.readIncident(r.run.runId);
  await deliverRepairReport(life, driver, doneMarker(r.run.runId, inc.incidentId, { restart: 'yes', files: ['- src/index.js'] }));
  assert.equal(restarts, 1);
  assert.equal(statusAtRestart, 'resolved'); // 重启前事故已落盘 resolved：重启后不会重复派修
  assert.equal(execFactory.calls.startStage, 0); // 走重启，不直接 resume
});

await ok('repair BLOCKED → paced redispatch carries previous summary; reset after threshold', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory, { repairResetAfter: 3 }));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  let inc = c.store.readIncident(r.run.runId);

  // BLOCKED #1 → 退避重派（同一修复会话续聊），prompt 带上次摘要
  await deliverRepairReport(life, driver, blockedMarker(r.run.runId, inc.incidentId, '第一次没找到'));
  await sleep(30);
  const cont1 = driver.submitted.filter((s) => s.id === 's-repair-1' && /第 2 次尝试/.test(s.text));
  assert.equal(cont1.length, 1, 'redispatch continuation prompt sent to same repair session');
  assert.match(cont1[0].text, /第一次没找到/); // previousBlockedSummary 注入

  // BLOCKED #2
  inc = c.store.readIncident(r.run.runId);
  await deliverRepairReport(life, driver, blockedMarker(r.run.runId, inc.incidentId, '第二次仍没找到'));
  await sleep(30);
  assert.ok(driver.submitted.some((s) => s.id === 's-repair-1' && /第 3 次尝试/.test(s.text)));

  // BLOCKED #3 → 达阈值：操作复位（取消疑似卡死 turn + 直接续跑）
  driver.auditAgent.status = 'running';
  inc = c.store.readIncident(r.run.runId);
  await deliverRepairReport(life, driver, blockedMarker(r.run.runId, inc.incidentId, '第三次放弃'));
  await sleep(400); // 取消落定轮询（250ms 步进）后补发阶段 prompt
  assert.equal(driver.auditAgent.cancelled, 1, 'stuck executor turn cancelled');
  const resolved = c.store.readIncident(r.run.runId);
  assert.equal(resolved.status, 'resolved');
  assert.match(resolved.resolution, /reset-after-3-blocked/);
  assert.equal(execFactory.calls.startStage, 1); // 直接续跑
});

await ok('turn/end without marker → bounded nudge, then treated as unresolved', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  const rp = [...life.repairs.values()][0];
  // 3 次空 turn/end：2 次 nudge + 1 次按未解决处理（退避重派）
  await life.onEvent(rp.agent, { type: 'turn/end', data: {} });
  await life.onEvent(rp.agent, { type: 'turn/end', data: {} });
  await life.onEvent(rp.agent, { type: 'turn/end', data: {} });
  await sleep(30);
  const nudges = driver.submitted.filter((s) => s.id === rp.agent.id && s.text.includes('[DSH-REPAIR]') && s.text.includes('没有包含要求的'));
  assert.equal(nudges.length, 2);
  assert.ok(driver.submitted.some((s) => s.id === rp.agent.id && /第 2 次尝试/.test(s.text)), 'redispatched after failed nudges');
});

await ok('bridge restart with open incident → restoreActive re-dispatches repair', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver1 = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life1 = new AuditLifecycle(lifeOpts(f, c, driver1, execFactory));
  const r = await life1.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life1.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  assert.equal(c.store.readIncident(r.run.runId).status, 'open');

  // 桥重启：全新 lifecycle（进程内状态全丢），只剩持久化 store。
  const driver2 = makeDriver();
  const execFactory2 = makeExecutorFactory();
  const life2 = new AuditLifecycle(lifeOpts(f, c, driver2, execFactory2));
  await life2.restoreActive();
  assert.ok(life2.incidents.has(r.run.runId), 'open incident latched before resume');
  await sleep(30);
  assert.equal(driver2.repairCount, 1, 'repair re-dispatched after restart');
  const prompt = driver2.submitted.find((s) => s.text.includes('[DSH-REPAIR]') || s.text.includes('RESTORE_OPEN_INCIDENT'))?.text;
  assert.ok(prompt, 'repair prompt submitted');
});

// ---------- 审核侧 ----------

await ok('WAIT_WEB_QUOTA is no longer a dead end: paced retry recovers and re-reviews', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory();
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  // 直接驱动状态机到 AUDITING + auditInFlight（状态会持久化，resume 重开的是同一状态）
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
  await life.resume(r.run.runId); // 尾部触发 #maybeAutoReviewLocked → 第一次 review → WAIT_WEB_QUOTA
  assert.equal(liveState(), 'WAIT_WEB_QUOTA');
  await sleep(40); // 退避 5ms 后：webQuotaRecovered + 同轮重发 → 第二次 review → APPROVE
  assert.equal(reviews.length, 2, 'review retried exactly once after quota wait');
  assert.equal(liveState(), 'EXECUTING'); // APPROVE 推进到下一阶段
});

await ok('AUDIT_REVIEW_INFRA escalates to incident after threshold', async () => {
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
  await life.resume(r.run.runId); // review #1 → 退避重试
  await sleep(40); // retry → review #2 → 退避重试
  await sleep(40); // retry → review #3 → 超过阈值(2) → 升级事故
  assert.ok(reviews >= 3);
  const inc = c.store.readIncident(r.run.runId);
  assert.equal(inc?.status, 'open');
  assert.equal(inc?.trigger, 'AUDIT_REVIEW_INFRA');
  assert.equal(driver.repairCount, 1, 'repair agent dispatched for review infra incident');
});

await ok('user stop revokes an open incident (late repair reports are inert)', async () => {
  const f = fixture(); const c = ctrl(f.root, f.work);
  const driver = makeDriver();
  const execFactory = makeExecutorFactory({ throwOnEvent: new Error('kaboom') });
  const life = new AuditLifecycle(lifeOpts(f, c, driver, execFactory));
  const r = await life.start({ chatId: 'chat-a', stopAfter: 'T2' });
  await assert.rejects(() => life.onEvent({ id: 's-audit' }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), /kaboom/);
  await sleep(30);
  const rp = { agent: [...life.repairs.values()][0].agent };
  await life.control(r.run.runId, async (run) => run.stop(), 'stop');
  assert.equal(c.store.readIncident(r.run.runId)?.status, 'resolved');
  assert.ok(!life.incidents.has(r.run.runId));
  // 迟到的修复报告：只留痕，不触发 resume
  const before = execFactory.calls.startStage;
  await life.onEvent(rp.agent, { type: 'assistant/message', data: { content: [{ type: 'text', text: doneMarker(r.run.runId, 'stale') }] } });
  await life.onEvent(rp.agent, { type: 'turn/end', data: {} });
  await sleep(20);
  assert.equal(execFactory.calls.startStage, before);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
