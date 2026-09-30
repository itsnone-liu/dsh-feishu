/**
 * audit/lifecycle.js — A3 real executor startup seam.
 *
 * This is intentionally separate from the synchronous A2 command formatter:
 * starting a real DSH session and inspecting git are asynchronous operations.
 * It binds an existing Feishu chat session, never silently creates/forks one,
 * validates the real repository before AuditRun.create, and returns the frozen
 * run plus executor adapter. Reviewer remains a caller-supplied stub until A5.
 */
import { AuditRun } from './state-machine.js';
import { AuditExecutor } from './executor.js';
import { GitRemoteGate } from './git-gate.js';
import { loadTaskPacket } from './task-packet.js';
import { AuditRetryScheduler } from './retry-scheduler.js';
// 2026-09-30 业主指令（纯无人值守）：人工批准话术构造/预授权协议 import 已删除。

export class AuditLifecycle {
  constructor({ controller, driver, bindings, onProgress = null, watchdogMs = 5 * 60_000, gitGateFactory = (opts) => new GitRemoteGate(opts), executorFactory = (opts) => new AuditExecutor(opts), taskPacketLoader = loadTaskPacket, retryScheduler = null, onError = null, reviewTimeoutMs = 20 * 60_000, gitTimeoutMs = 120_000, approvalPolicy = 'MANUAL', gitSnapshotProvider = null,
    reviewRetryDelays = null, reviewInfraIncidentAfter = 3, logFileHint = null, incidentBridgeRoot = null,
    onQuota = null,
  } = {}) {
    this.controller = controller;
    this.driver = driver;
    this.onError = onError;
    this.bindings = bindings;
    this.onProgress = onProgress;
    this.watchdogMs = watchdogMs;
    this.reviewTimeoutMs = reviewTimeoutMs; // R1 F4：reviewer.review 硬超时（默认 20min，可注入；测试传 1ms）
    this.gitTimeoutMs = gitTimeoutMs;       // R1 F4：git 子进程硬超时（透传 gitGateFactory）
    // AUTO is the production unattended policy. MANUAL remains an explicit
    // step-by-step compatibility mode for tests and deliberate re-audits.
    this.approvalPolicy = String(approvalPolicy ?? 'MANUAL').toUpperCase();
    // P-E 简化版（2026-09-29 用户定稿）：异常 → 停（该 run 自动重试全停）→
    // 报（incident.json + recovery.jsonl + 飞书卡）→ 等人工修复 → /audit resume。
    // 程序内不做自动修（不派修复 agent、不自动重启）；确定性已知类（配额/
    // 审核超时/瞬态 git）仍按退避自动重试。多修几次，常见问题慢慢消失。
    this.gitSnapshotProvider = gitSnapshotProvider; // 事故报告里的 git 快照采集
    this.reviewRetryDelays = reviewRetryDelays ?? [30_000, 60_000, 120_000, 240_000];
    this.reviewInfraIncidentAfter = reviewInfraIncidentAfter;
    this.logFileHint = logFileHint;
    this.incidentBridgeRoot = incidentBridgeRoot;
    // 执行侧额度事件交给桥的统一 GLM→GPT fallback；审核专用 session
    // 仍由本生命周期管理 WAIT_DSH_QUOTA 状态。
    this.onQuota = onQuota;
    this.gitGateFactory = gitGateFactory;
    this.executorFactory = executorFactory;
    this.taskPacketLoader = taskPacketLoader;
    this.retryScheduler = retryScheduler ?? new AuditRetryScheduler({ onRetry: (runId) => this.retry(runId), onError: (e, runId) => this.onError?.(e, runId) });
    this.executors = new Map();
    this.liveRuns = new Map();
    this.eventQueues = new Map();
    this.busyRuns = new Set();
    this.reviewRounds = new Map();
    this.reviewer = null;
    this.activity = new Map();
    this.reviewRetryTimers = new Map();
    this.recoveryAttempts = new Map(); // review: 升级计数 / reviewretry: 退避档位
    /** runId → 事故记录（incident.json 同步落盘；report 为完整事故报告） */
    this.incidents = new Map();
    this.watchdogInterval = setInterval(() => this.#watchdog(), 60_000);
    this.watchdogInterval.unref?.();
  }

  #notify(run, event, detail = {}) {
    this.activity.set(run.runId, { at: Date.now(), warned: event === 'WATCHDOG_TIMEOUT' });
    try { this.onProgress?.({ runId: run.runId, chatId: run.manifest.chatId, stage: run.s.currentStage, state: run.s.state, event, ...detail }); } catch {}
  }

  // 2026-09-30 业主指令（纯无人值守）：#humanWaitDetail（人闸等待卡）已随
  // 人工授权门整体删除——执行器不再产生 WAIT_HUMAN_APPROVAL 等待态。

  #watchdog() {
    const now = Date.now();
    for (const run of this.liveRuns.values()) {
      // AUDITING 有独立的 reviewTimeout/retry/incident 链；watchdog 不能用更短的
      // 5min 窗口抢先把正常的网页审核停成事故（2026-09-30 误报现场：
      // 11:14 watchdog 开事故，11:17 同一审核才返回 REVISE）。额度等待同理
      // 由 AutoContinue/AuditRecovery 管理，不能由 idle watchdog 重复报错。
      if (run.isTerminal || ['AUDITING', 'WAIT_DSH_QUOTA', 'WAIT_WEB_QUOTA'].includes(run.s.state)) continue;
      if (this.incidents.has(run.runId)) continue; // 事故已停机等人工：不再重复触发
      const a = this.activity.get(run.runId) ?? { at: run.s.updatedAt ?? now, warned: false };
      const last = run.s.lastExecutorEventAt ?? a.at;
      if (now - last < this.watchdogMs) continue;
      if (!a.warned) {
        this.#notify(run, 'WATCHDOG_TIMEOUT', { idleMs: now - last, message: '审计执行器超过 watchdog 窗口无进展，已停机转事故汇报。' });
        a.warned = true; this.activity.set(run.runId, a);
      }
      // P-E 简化版：异常就停 + 汇报，修复由人工做（多修几次常见问题慢慢消失）。
      this.#raiseIncidentSafe(run, 'WATCHDOG_TIMEOUT', { idleMs: now - last });
    }
  }

  /** 事故入口（安全包装）：任何异常路径都可调，自身绝不抛出。 */
  #raiseIncidentSafe(run, trigger, detail = {}) {
    if (!run || run.isTerminal) return;
    Promise.resolve()
      .then(() => this.#raiseIncident(run, trigger, detail))
      .catch((e) => {
        // 汇报链路自身故障：尽力留痕 + 兜底通知（不能再派修——没有自动修）。
        this.onError?.(Object.assign(new Error(`事故汇报失败：${e?.message ?? e}`), { code: 'AUDIT_INCIDENT_REPORT_FAILED', cause: e }), run?.runId);
        try { this.#notify(run, 'AUDIT_INCIDENT_RAISED', { trigger, reason: `事故落盘/汇报环节出错（${e?.message ?? e}），请查看桥日志与 recovery.jsonl。`, nextStep: '人工排查后 /audit resume 或 /audit stop。' }); } catch { /* 尽力而为 */ }
      });
  }

  /**
   * P-E 简化版核心：有异常就停 → 汇报 → 等人工。
   * 「停」= 停止该 run 的一切自动重试（git 重试 / 审核重试 / watchdog 再触发）。
   * 在跑的 executor turn 不取消 —— 它可能只是慢而非死，晚到的完成事件照常
   * 推进状态机（executor 监听保持挂载）；人工修好后 /audit resume 续跑。
   */
  async #raiseIncident(run, trigger, detail = {}) {
    if (this.incidents.has(run.runId)) return; // 一 run 一事故：停机中不重复触发
    const incident = await this.#incidentContext(run, trigger, detail);
    incident.bridge = {
      pid: process.pid,
      bridgeRoot: this.incidentBridgeRoot ?? process.cwd(),
      logFile: this.logFileHint ?? null,
    };
    const record = {
      incidentId: incident.incidentId,
      runId: run.runId,
      trigger,
      raisedAt: Date.now(),
      status: 'open',
    };
    this.controller.store.writeIncident(run.runId, record);
    this.incidents.set(run.runId, { ...record, report: incident });
    this.controller.store.appendRecoveryIncident({ runId: run.runId, incident });
    this.#appendRunEvent(run, 'AUDIT_INCIDENT_RAISED', { trigger, incidentId: incident.incidentId });
    try { this.retryScheduler.cancel(run.runId); } catch { /* 取消失败不阻塞 */ }
    this.#clearReviewRetry(run.runId);
    this.#notify(run, 'AUDIT_INCIDENT_RAISED', {
      trigger,
      incidentId: incident.incidentId,
      reason: `${trigger}${detail.error ? `：${String(detail.error).slice(0, 300)}` : ''}`,
      question: JSON.stringify({ runId: run.runId, trigger, state: run.s.state, stage: run.s.currentStage, logFile: incident.bridge.logFile }, null, 2),
      nextStep: '已停止自动重试并保留现场（事故报告见 recovery.jsonl / incident.json）。请人工排查修复，完成后发送 /audit resume 续跑。',
    });
  }

  async #incidentContext(run, trigger, detail = {}) {
    const loaded = this.controller.store.loadRun(run.runId);
    const recentEvents = (loaded?.events ?? []).slice(-20).map((e) => ({
      event: e.event, stage: e.stage, iteration: e.iteration, timestamp: e.timestamp,
      detail: e.detail ?? null,
    }));
    return {
      incidentId: `${run.runId}:${Date.now()}`,
      runId: run.runId,
      trigger,
      detail,
      state: run.s.state,
      cause: run.s.cause ?? null,
      currentStage: run.s.currentStage,
      iteration: run.s.iteration,
      revisionCount: run.s.revisionCount,
      lastExecutorEvent: run.s.lastExecutorEvent ?? null,
      lastExecutorEventAt: run.s.lastExecutorEventAt ?? null,
      lastVerdict: run.s.lastVerdict ?? null,
      auditInFlight: run.s.auditInFlight ?? null,
      pendingRemoteSync: run.s.pendingRemoteSync ?? null,
      manifest: {
        cwd: run.manifest.cwd, repo: run.manifest.repo, branch: run.manifest.branch,
        taskPacketHash: run.manifest.taskPacketHash, dshSessionId: run.manifest.dshSessionId,
      },
      recentEvents,
      gitSnapshot: this.gitSnapshotProvider ? await this.gitSnapshotProvider(run.manifest.cwd).catch((error) => ({ error: error.message })) : null,
    };
  }

  #scheduleRetry(runId, attempt) {
    return this.retryScheduler.schedule(runId, (id) => this.retry(id), attempt);
  }

  async start({ chatId, stopAfter, stages, goal, approvedPlan, taskPacket = null } = {}) {
    if (!chatId) throw Object.assign(new Error('chatId is required'), { code: 'AUDIT_ARG_INVALID' });
    const active = this.controller.activeRun();
    if (active) {
      const owned = active.chatId === chatId;
      throw Object.assign(new Error(owned
        ? `已有活跃审计运行 ${active.id}`
        : '本机已有审计运行中，但不是本聊天发起的'), {
        code: owned ? 'AUDIT_RUN_ACTIVE' : 'AUDIT_RUN_OWNED_BY_OTHER_CHAT',
      });
    }
    const binding = this.bindings?.get(chatId);
    if (!binding?.cwd) {
      throw Object.assign(new Error('当前聊天必须已有 workspace 绑定'), { code: 'AUDIT_SESSION_REQUIRED' });
    }
    if (!this.driver?.ensureAuditSession && !this.driver?.ensure) throw Object.assign(new Error('dedicated audit session unavailable'), { code: 'AUDIT_EXECUTOR_CONFIG_INVALID' });

    // The chat binding remains the observer/control session. The executor gets
    // a separate durable DSH session so ordinary conversation can continue.
    let agent;
    try {
      agent = this.driver.ensureAuditSession
        ? await this.driver.ensureAuditSession({ cwd: binding.cwd })
        : await this.driver.ensure({ ...binding }, { allowCreate: false });
    } catch (e) {
      if (e?.occupied) throw Object.assign(e, { code: 'AUDIT_SESSION_OCCUPIED' });
      throw Object.assign(e, { code: e.code ?? 'AUDIT_SESSION_RESUME_FAILED' });
    }
    if (agent.status !== 'idle') {
      throw Object.assign(new Error('dedicated audit DSH session is busy'), { code: 'AUDIT_SESSION_OCCUPIED' });
    }

    const gate = this.gitGateFactory({ cwd: binding.cwd, timeoutMs: this.gitTimeoutMs });
    const packet = taskPacket ?? this.taskPacketLoader(binding.cwd);
    const stageList = packet.stages;
    const stopAfterCanonical = stageList.find((s) => s.toLowerCase() === String(stopAfter ?? '').toLowerCase());
    // A3 discovers the actual controlled branch from the bound workspace; A2's
    // default branch is not allowed to reject a legitimate existing session.
    const git = await gate.inspect({});
    if (!stopAfterCanonical || !stageList.some((s) => s.toLowerCase() === stopAfterCanonical.toLowerCase())) {
      throw Object.assign(new Error(`停止点 ${stopAfter} 不在阶段表 [${stageList.join(', ')}] 中`), { code: 'AUDIT_MANIFEST_INVALID' });
    }
    const stamp = new Date(this.controller.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
    let runId = `audit_${stamp}`;
    for (let n = 2; this.controller.store.loadRun(runId); n += 1) runId = `audit_${stamp}_${n}`;
    const run = AuditRun.create(this.controller.store, {
      runId, hostId: this.controller.hostId, chatId,
      observerSessionId: binding.sessionId ?? null, dshSessionId: agent.id,
      cwd: git.cwd, repo: git.repo, branch: git.branch,
      stages: stageList, stopAfter: stopAfterCanonical,
      startingCommit: git.head, stageBaseCommit: git.head,
      goal: packet.goal, approvedPlan: packet.approvedPlan,
      taskPacketHash: packet.taskPacketHash, stageRequirements: packet.stageRequirements,
      // 2026-09-30：stageGates/preauthorization 已随人工门删除，不再进 manifest。
    }, { maxReviewIterations: this.controller.maxReviewIterations, now: this.controller.now });
    const executor = this.executorFactory({
      driver: this.driver, gitGate: gate,
      onTransient: this.retryScheduler ? (entry, _result, attempt) => this.#scheduleRetry(entry.run.runId, attempt) : null,
      onQuota: this.onQuota,
    });
    this.executors.set(runId, executor);
    this.liveRuns.set(runId, run);
    await executor.start({ run, agent, gitGate: gate });
    this.#notify(run, 'EXECUTOR_STARTED', { auditSessionId: agent.id, observerSessionId: binding.sessionId ?? null });
    return { run, executor, agent, git };
  }

  /**
   * /audit next（真实 A3 路径）：延续最近一条 STOPPED_TARGET_REACHED 的任务链。
   * - 自动定位父 run（无需人工给 runId）：owner 匹配 + 终态 STOPPED_TARGET_REACHED；
   * - lineage 校验：工作区任务书 taskPacketHash 必须与父链一致（任务书被改 → 拒绝，
   *   避免"重做任务书"悄悄换审计范围）；下一阶段 = 父阶段表中已完成阶段的下一格；
   * - 继承 goal/approvedPlan/stageRequirements/completedStages，从下一阶段 iteration 1 起步；
   * - 与 start() 同一套 session 绑定与 executor 接线（发送阶段 prompt，驱动执行端）。
   */
  async startContinuation({ chatId, stopAfter = null, retryStopped = false } = {}) {
    if (!chatId) throw Object.assign(new Error('chatId is required'), { code: 'AUDIT_ARG_INVALID' });
    const active = this.controller.activeRun();
    if (active) {
      const owned = active.chatId === chatId;
      throw Object.assign(new Error(owned
        ? `已有活跃审计运行 ${active.id}；/audit next 仅在无活跃运行时可用`
        : '本机已有审计运行中，但不是本聊天发起的'), {
        code: owned ? 'AUDIT_RUN_ACTIVE' : 'AUDIT_RUN_OWNED_BY_OTHER_CHAT',
      });
    }
    // 默认只延续 STOPPED_TARGET_REACHED 父链。显式 /audit retry 才允许
    // 从 STOPPED 事故/人工终止的当前阶段重开；这是人工选择，不是自动恢复。
    let parent = null;
    let retryingStopped = false;
    for (const r of this.controller.store.listRuns().slice().reverse()) {
      const loaded = this.controller.store.loadRun(r.runId);
      if (!loaded || (loaded.manifest.chatId ?? null) !== chatId) continue;
      if (loaded.state.state === 'STOPPED_TARGET_REACHED'
        || (retryStopped && loaded.state.state === 'STOPPED')) {
        parent = loaded;
        retryingStopped = loaded.state.state === 'STOPPED';
        break;
      }
    }
    if (!parent) {
      throw Object.assign(new Error(retryStopped
        ? '没有可重试的 STOPPED 审计运行。'
        : '没有已到达停止点的审计运行可延续；先 /audit <阶段> 或 /audit 创建。'), { code: 'AUDIT_NO_CONTINUATION' });
    }
    const pm = parent.manifest;
    const packet = this.taskPacketLoader(parent.manifest.cwd);
    const stages = retryingStopped ? packet.stages : pm.stages;
    const lastIdx = stages.indexOf(parent.state.currentStage);
    const lastDoneIdx = retryingStopped ? lastIdx - 1 : stages.indexOf(parent.state.stopAfter ?? pm.stopAfter);
    const nextStage = retryingStopped ? parent.state.currentStage : stages[lastDoneIdx + 1];
    if (nextStage == null) {
      throw Object.assign(new Error(`任务链 \`${pm.rootRunId ?? pm.runId}\` 最后阶段 ${pm.stopAfter} 已 APPROVE，没有后续阶段。`), { code: 'AUDIT_ALREADY_COMPLETE' });
    }
    let stopAfterStage = nextStage;
    if (stopAfter != null) {
      const resolved = stages.includes(stopAfter) ? stopAfter : null;
      if (!resolved) {
        throw Object.assign(new Error(`停止点 ${stopAfter} 不在阶段表 [${stages.join(', ')}] 中`), { code: 'AUDIT_MANIFEST_INVALID' });
      }
      if (stages.indexOf(resolved) < stages.indexOf(nextStage)) {
        throw Object.assign(new Error(`延续运行不能停在已完成阶段之前：下一起点为 ${nextStage}，请求停止点 ${resolved} 早于它。`), { code: 'AUDIT_CONTINUATION_STAGE_INVALID' });
      }
      stopAfterStage = resolved;
    }
    // 绑定 session 与真实 git（与 start() 同一套边界：不创建新 session、不并发）。
    const binding = this.bindings?.get(chatId);
    if (!binding?.sessionId || !binding?.cwd) {
      throw Object.assign(new Error('当前聊天必须已有绑定的 DSH session 和 workspace；/audit next 不会偷偷创建新 session'), { code: 'AUDIT_SESSION_REQUIRED' });
    }
    if (!this.driver?.ensureAuditSession && !this.driver?.ensure) throw Object.assign(new Error('DSH driver unavailable'), { code: 'AUDIT_EXECUTOR_CONFIG_INVALID' });
    let agent;
    try {
      // 观察 session 与审计 executor 必须隔离。retry/continuation 不能把
      // binding.sessionId 直接交给 ensure，否则普通聊天消息会进入审计上下文。
      agent = this.driver.ensureAuditSession
        ? await this.driver.ensureAuditSession({ cwd: binding.cwd, allowCreate: true })
        : await this.driver.ensure({ cwd: binding.cwd }, { allowCreate: true });
    } catch (e) {
      if (e?.occupied) throw Object.assign(e, { code: 'AUDIT_SESSION_OCCUPIED' });
      throw Object.assign(e, { code: e.code ?? 'AUDIT_SESSION_RESUME_FAILED' });
    }
    if (agent.status !== 'idle') {
      throw Object.assign(new Error('绑定的 DSH session 当前正在运行；/audit next 不会并发或偷偷 fork'), { code: 'AUDIT_SESSION_OCCUPIED' });
    }
    const gate = this.gitGateFactory({ cwd: binding.cwd, timeoutMs: this.gitTimeoutMs });
    const currentPacket = this.taskPacketLoader(binding.cwd);
    // 正常 /audit next 必须沿用父链任务包。/audit retry 是显式人工重试，
    // 允许采用当前工作区任务包（哈希变化会冻结到新 manifest）。
    if (!retryingStopped && pm.taskPacketHash && currentPacket.taskPacketHash !== pm.taskPacketHash) {
      throw Object.assign(new Error(
        `工作区任务书哈希 \`${currentPacket.taskPacketHash}\` 与父链 \`${pm.taskPacketHash}\` 不一致；延续运行不得更换任务书。`,
      ), { code: 'AUDIT_PACKET_MISMATCH' });
    }
    const git = await gate.inspect({});
    const stamp = new Date(this.controller.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
    let runId = `audit_${stamp}`;
    for (let n = 2; this.controller.store.loadRun(runId); n += 1) runId = `audit_${stamp}_${n}`;
    const completedStages = retryingStopped
      ? (pm.completedStages ?? []).slice()
      : [...(pm.completedStages ?? []), pm.stages[lastDoneIdx]];
    const run = AuditRun.create(this.controller.store, {
      runId, hostId: this.controller.hostId, chatId,
      observerSessionId: binding.sessionId ?? null, dshSessionId: agent.id,
      cwd: git.cwd, repo: git.repo, branch: git.branch,
      stages, stopAfter: stopAfterStage, currentStage: nextStage,
      startingCommit: git.head, stageBaseCommit: parent.state.headCommit,
      goal: currentPacket.goal, approvedPlan: packet.approvedPlan,
      taskPacketHash: packet.taskPacketHash, stageRequirements: packet.stageRequirements,
      // 2026-09-30：stageGates/preauthorization 已随人工门删除，不再进 manifest。
      parentRunId: pm.runId, rootRunId: pm.rootRunId ?? pm.runId, completedStages,
      ignorePaths: pm.ignorePaths,
    }, { maxReviewIterations: this.controller.maxReviewIterations, now: this.controller.now });
    const executor = this.executorFactory({
      driver: this.driver, gitGate: gate,
      onTransient: this.retryScheduler ? (entry, _result, attempt) => this.#scheduleRetry(entry.run.runId, attempt) : null,
      onQuota: this.onQuota,
    });
    this.executors.set(runId, executor);
    this.liveRuns.set(runId, run);
    await executor.start({ run, agent, gitGate: gate });
    return { run, executor, agent, git, parentRunId: pm.runId };
  }

  async review(runId, reviewer = this.reviewer) {
    return this.#serial(runId, () => this.#reviewLocked(runId, reviewer));
  }

  #reviewRoundKey(run) {
    const f = run.s.auditInFlight;
    return f ? `${run.runId}|${f.stage ?? run.s.currentStage}|${f.iteration ?? run.s.iteration}|${f.headCommit}` : null;
  }

  async #maybeAutoReviewLocked(runId) {
    const run = this.liveRuns.get(runId);
    const executor = this.executors.get(runId);
    if (!run || !executor || run.s.state !== 'AUDITING' || !run.s.auditInFlight) return { skipped: true };
    if (!this.reviewer) return { skipped: true };
    if (this.incidents.has(runId)) return { skipped: true, incidentOpen: true }; // P-E：事故处理中不自动审核
    const key = this.#reviewRoundKey(run);
    if (key && this.reviewRounds.get(runId) === key) return { deduped: true };
    if (key) this.reviewRounds.set(runId, key);
    // Infrastructure failure keeps the round key latched: duplicate triggers stay deduped
    // and only an explicit review()/resume can retry this round (fail-closed).
    const result = await this.#reviewLocked(runId, this.reviewer);
    if (!result?.timedOut && !result?.retry && !result?.failed && !result?.quota) {
      this.recoveryAttempts.delete(`reviewretry:${runId}`); // 成功即复位退避档位
    }
    this.#notifyVerdictOutcome(runId, result); // R1 F2：自动审核的裁决结果不再静默
    return result;
  }

  /**
   * R1 止血 F2：自动审核路径的裁决结果通知。此前只有 executor 事件通知，
   * verdict 落地（NEED_USER / 轮次耗尽 / 到达停止点 / 阶段推进）对聊天全程
   * 静默 —— 生产曾 31 分钟无人知晓。只读 lastVerdict 与 run 现态，绝不改
   * 审核编排本身；通知异常被吞（不得影响审核结果传播）。
   */
  #notifyVerdictOutcome(runId, result) {
    try {
      const run = this.liveRuns.get(runId);
      if (!run || !result) return;
      if (result.deduped || result.skipped || result.timedOut || result.retry || result.failed) return;
      const v = run.s.lastVerdict;
      if (!v) return;
      const join = (x) => (Array.isArray(x) ? x.join('\n') : (x ?? null));
      const detail = { verdictState: v.state, summary: join(v.summary) };
      if (result.needUser) {
        this.#notify(run, 'VERDICT_NEED_USER', {
          ...detail,
          question: join(v.question),
          nextStep: '请直接回复本会话回答上述问题（同轮审核已保留）；处理后 `/audit resume` 继续，或 `/audit stop` 退出。',
        });
      } else if (result.exhausted) {
        this.#notify(run, 'VERDICT_REVISE_LOOP_EXHAUSTED', {
          ...detail,
          nextStep: 'REVISE 轮次已达上限（不自动归零）：`/audit resume <N>` 提高上限继续修复，或 `/audit stop` 结束。',
        });
      } else if (result.stopped) {
        this.#notify(run, 'VERDICT_TARGET_REACHED', {
          ...detail,
          nextStep: '已到达停止点（审计通过）：`/audit next` 延续下一阶段（若有），或 `/audit status` 查看详情。',
        });
      } else if (result.advanced) {
        this.#notify(run, 'VERDICT_STAGE_ADVANCED', {
          ...detail,
          stage: run.s.currentStage,
          nextStep: `阶段已 APPROVE，执行器开始下一阶段 ${run.s.currentStage}（iteration 1）。`,
        });
      }
    } catch { /* 通知失败不影响审核编排 */ }
  }

  async #reviewLocked(runId, reviewer) {
    const executor = this.executors.get(runId);
    const run = this.liveRuns.get(runId);
    if (!executor || !run) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    const inFlight = run.s.auditInFlight;
    if (run.s.state !== 'AUDITING' || !inFlight) throw Object.assign(new Error('audit packet unavailable outside AUDITING'), { code: 'AUDIT_REVIEW_NOT_READY' });
    const stage = inFlight.stage ?? run.s.currentStage;
    const packet = { runId, hostId: run.manifest.hostId, stage, iteration: inFlight.iteration ?? run.s.iteration, repo: run.manifest.repo, branch: run.manifest.branch, targetCommit: inFlight.headCommit, baseCommit: run.s.stageBaseCommit, goal: run.manifest.goal, stageRequirement: run.manifest.stageRequirements?.[stage] ?? null };
    // 2026-09-30：gateProvenance 注入已随人工授权门删除（不再有 GATE_PASSED* 事件）。
    for (;;) {
      let verdict;
      try { verdict = await this.#reviewWithTimeout(packet, reviewer); }
      catch (e) {
        if (e?.code === 'AUDIT_REVIEW_TIMEOUT') {
          if (this.approvalPolicy !== 'AUTO') {
            this.#notify(run, 'REVIEW_TIMEOUT', { stage, iteration: packet.iteration, timeoutMs: this.reviewTimeoutMs, nextStep: '审核超时：`/audit resume` 重发审核，或 `/audit stop` 退出。' });
            return { timedOut: true };
          }
          this.#scheduleReviewRecovery(runId, 'REVIEW_TIMEOUT', e);
          return { timedOut: true, retry: true };
        }
        if (e?.code === 'AUDIT_WEB_QUOTA') {
          if (this.approvalPolicy !== 'AUTO') throw e;
          if (run.s.state === 'AUDITING') run.webQuotaExhausted();
          this.#scheduleReviewRecovery(runId, 'WAIT_WEB_QUOTA', e);
          return { quota: true, retry: true };
        }
        if (e?.code === 'AUDIT_REVIEWER_SCRIPT_EXHAUSTED') throw e;
        if (e?.code === 'AUDIT_VERDICT_MALFORMED' || e?.code === 'AUDIT_VERDICT_MISSING') {
          const missing = run.verdictMissing();
          if (missing.retry) continue;
          return missing;
        }
        // Reviewer transport/auth/evidence failures are infrastructure faults.
        // Production AUTO retries forever; explicit MANUAL callers preserve the
        // old fail-to-caller contract used by protocol/seam tests.
        if (this.approvalPolicy !== 'AUTO') throw e;
        this.#scheduleReviewRecovery(runId, 'AUDIT_REVIEW_INFRA', e);
        return { failed: true, retry: true };
      }
      // Pure unattended policy: reviewer NEED_USER is not a chat gate. Convert
      // it into an actionable REVISE cycle and let the executor resolve it.
      if (verdict?.state === 'NEED_USER' && this.approvalPolicy === 'AUTO') {
        verdict = { ...verdict, state: 'REVISE', reason: verdict.question ?? verdict.summary ?? ['审核需要澄清，自动回到执行端核验并修复。'] };
      }
      return executor.applyVerdict(runId, verdict);
    }
  }

  /**
   * P-E 审核侧异常处理（替代旧 LLM planner 路径）：
   *  - REVIEW_TIMEOUT / WAIT_WEB_QUOTA：确定性退避重试（无上限，末位封顶节奏），
   *    到点直接重发同一轮审核（web 配额等待态先复位到 AUDITING —— 旧代码
   *    webQuotaRecovered 无生产调用方，WAIT_WEB_QUOTA 曾是死胡同）；
   *  - AUDIT_REVIEW_INFRA：先确定性重试，连续 reviewInfraIncidentAfter 次
   *    未恢复 → 升级为事故（停-报-修-续，派修复 agent）。
   */
  #scheduleReviewRecovery(runId, reason, error) {
    if (this.incidents.has(runId)) return; // 事故已开：不叠加审核侧重试
    if (reason === 'AUDIT_REVIEW_INFRA') {
      const attempt = (this.recoveryAttempts.get(`review:${runId}`) ?? 0) + 1;
      this.recoveryAttempts.set(`review:${runId}`, attempt);
      if (attempt > this.reviewInfraIncidentAfter) {
        this.recoveryAttempts.delete(`review:${runId}`);
        const run = this.liveRuns.get(runId);
        if (run && !run.isTerminal) {
          this.#raiseIncidentSafe(run, 'AUDIT_REVIEW_INFRA', { error: error?.message ?? String(error), attempts: attempt - 1 });
          return;
        }
      }
    }
    if (this.reviewRetryTimers.has(runId)) return;
    const n = (this.recoveryAttempts.get(`reviewretry:${runId}`) ?? 0) + 1;
    this.recoveryAttempts.set(`reviewretry:${runId}`, n);
    const delayMs = this.reviewRetryDelays[Math.min(n - 1, this.reviewRetryDelays.length - 1)];
    const run = this.liveRuns.get(runId);
    if (run) {
      const label = reason === 'WAIT_WEB_QUOTA' ? '审核额度受限' : reason === 'REVIEW_TIMEOUT' ? '审核超时' : '审核基础设施异常';
      this.#notify(run, reason === 'WAIT_WEB_QUOTA' ? 'WEB_QUOTA_WAIT' : reason === 'REVIEW_TIMEOUT' ? 'REVIEW_TIMEOUT' : 'AUDIT_REVIEW_RETRY', {
        attempt: n,
        retryInMs: delayMs,
        reason: `${label}，${Math.round(delayMs / 1000)} 秒后自动重试（第 ${n} 次）：${error?.message ?? error}`,
        nextStep: '自动重试中，无需人工介入；如需强制介入可用 `/audit resume` 或 `/audit stop`。',
      });
    }
    const timer = setTimeout(() => {
      this.reviewRetryTimers.delete(runId);
      this.#serial(runId, async () => {
        const current = this.liveRuns.get(runId);
        if (!current || current.isTerminal) return;
        if (this.incidents.has(runId)) return; // 重试等待期间事故已开：让位
        // WEB 配额等待态先复位（auditInFlight 保留，同轮重发语义幂等）；
        // 重试本身就是「配额是否恢复」的探测：仍受限会再次进入 WAIT_WEB_QUOTA。
        if (current.s.state === 'WAIT_WEB_QUOTA') current.webQuotaRecovered();
        this.reviewRounds.delete(runId); // 同轮允许重试
        await this.#maybeAutoReviewLocked(runId);
      }).catch((e) => this.onError?.(e, runId));
    }, delayMs);
    timer.unref?.();
    this.reviewRetryTimers.set(runId, timer);
  }

  #clearReviewRetry(runId) {
    const t = this.reviewRetryTimers.get(runId);
    if (t) clearTimeout(t);
    this.reviewRetryTimers.delete(runId);
    this.recoveryAttempts.delete(`review:${runId}`);
  }

  #reviewWithTimeout(packet, reviewer) {
    const ms = Number(this.reviewTimeoutMs);
    const reviewP = Promise.resolve().then(() => reviewer.review(packet));
    if (!Number.isFinite(ms) || ms <= 0) return reviewP;
    let timer = null;
    return Promise.race([
      reviewP,
      new Promise((_, reject) => {
        // 注意不 unref：in-flight review 的超时定时器必须参与事件循环
        // （否则在只剩该定时器的进程里 loop 直接排空、race 永不裁决）。
        timer = setTimeout(() => reject(Object.assign(
          new Error(`review exceeded hard timeout after ${ms}ms`),
          { code: 'AUDIT_REVIEW_TIMEOUT' },
        )), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async applyVerdict(runId, verdict) {
    return this.#serial(runId, () => {
      const executor = this.executors.get(runId);
      if (!executor) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
      return executor.applyVerdict(runId, verdict);
    });
  }

  #serial(runId, fn) {
    const prior = this.eventQueues.get(runId) ?? Promise.resolve();
    const task = prior.then(fn);
    this.eventQueues.set(runId, task.catch(() => undefined));
    return task;
  }

  async control(runId, operation, action = null) {
    return this.#serial(runId, async () => {
      const run = this.liveRuns.get(runId);
      if (!run) throw Object.assign(new Error(`live run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
      if (action === 'stop') {
        this.retryScheduler.cancel(runId);
        // R1 止血 F7：先向底层在跑 turn 发出取消意图（同步发起即返回，不等待
        // 取消完成），再摘除 executor 监听 —— 否则 stop/pause 后底层 turn 继续
        // 跑完，副作用照常发生。
        this.executors.get(runId)?.cancel?.(runId);
        this.executors.get(runId)?.stop(runId);
        this.executors.delete(runId);
        // P-E：用户 stop 时撤销事故处理（修复 agent 的晚到报告只留痕不动作）。
        if (typeof this.controller.store.readIncident === 'function') {
          const inc = this.controller.store.readIncident(runId);
          if (inc?.status === 'open' && typeof this.controller.store.writeIncident === 'function') {
            this.controller.store.writeIncident(runId, { ...inc, status: 'resolved', resolvedAt: Date.now(), resolution: 'run stopped by user' });
          }
        }
        this.incidents.delete(runId);
        this.#clearReviewRetry(runId);
      } else if (action === 'pause') {
        this.retryScheduler.cancel(runId);
        this.executors.get(runId)?.cancel?.(runId); // R1 F7：pause 同样取消在跑 turn（resume 时补发 prompt）
      }
      const result = await operation(run);
      if (action === 'resume' && result?.ignored) return result;
      if (action === 'resume') {
        if (run.s.state === 'WAIT_GIT_PUSH' && run.s.pendingRemoteSync) {
          this.#scheduleRetry(runId, run.s.retry.pushAttempts);
        }
        if (run.s.state === 'AUDITING' && run.s.auditInFlight) {
          this.reviewRounds.delete(runId); // 人工恢复后同轮允许再次审核（NEED_USER 语义）
          await this.#maybeAutoReviewLocked(runId);
        }
      }
      return result;
    });
  }

  async rebind(runId) {
    return this.#serial(runId, async () => {
    const old = this.liveRuns.get(runId) ?? AuditRun.open(this.controller.store, { now: this.controller.now })(runId);
    if (!old) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
    const binding = this.bindings?.get(old.manifest.chatId);
    if (!binding?.sessionId || binding.sessionId !== (old.manifest.observerSessionId ?? binding.sessionId)) {
      throw Object.assign(new Error('observer session binding mismatch'), { code: 'AUDIT_SESSION_BINDING_MISMATCH' });
    }
    const agent = await this.driver.ensureAuditSession({ cwd: old.manifest.cwd, allowCreate: true });
    if (agent.status !== 'idle') throw Object.assign(new Error('dedicated audit session is busy'), { code: 'AUDIT_SESSION_OCCUPIED' });
    old.rebindAuditSession(binding.sessionId, agent.id);
    // Migration is also the explicit recovery boundary for a marker failure:
    // resume the durable run before the first prompt reaches the new session.
    if (old.s.state === 'PAUSED_NEEDS_USER' && old.s.cause !== 'HISTORY_REWRITTEN') {
      if (old.s.cause === 'MARKER_PARSE_FAILED') old.markHumanResumeCycle();
      old.resumeFromHuman({});
    }
    this.liveRuns.set(runId, old);
    const gate = this.gitGateFactory({ cwd: old.manifest.cwd, timeoutMs: this.gitTimeoutMs });
    const executor = this.executorFactory({
      driver: this.driver, gitGate: gate,
      onTransient: this.retryScheduler ? (entry, _result, attempt) => this.#scheduleRetry(entry.run.runId, attempt) : null,
      onQuota: this.onQuota,
    });
    this.executors.set(runId, executor);
    await executor.start({
      run: old,
      agent,
      gitGate: gate,
      sendPrompt: old.s.state === 'EXECUTING',
    });
    this.#notify(old, 'AUDIT_SESSION_REBOUND', { auditSessionId: agent.id, observerSessionId: binding.sessionId });
    return { run: old, agent, executor };
    });
  }

  // 2026-09-30 业主指令（纯无人值守）：submitHumanResponse 与整个预授权
  // 消费/登记/自动放行子系统（#registerPreauthRecord / #autoPreauthPass /
  // #injectCanonicalApproval / #verifyPreauthCandidates / #consumePreauth /
  // #chainEvents / #blobSha256）已整体删除。聊天文本不再被审计拦截。


  /** lifecycle 级事件（镜像 state-machine #emit 形态；dedupeKey 必填唯一）。 */
  #appendRunEvent(run, event, extra = {}) {
    try {
      this.controller.store.appendEvent({
        runId: run.runId, stage: run.s.currentStage, iteration: run.s.iteration,
        headCommit: run.s.headCommit ?? null, event, timestamp: Date.now(),
        elapsedMs: null, tokens: null,
        dedupeKey: `${run.runId}|${run.s.currentStage}|${run.s.iteration}|${run.s.headCommit ?? ''}|${event}|${extra.preauthId ?? ''}#${Date.now()}`,
        ...extra,
      });
    } catch (e) {
      this.onError?.(Object.assign(new Error(`appendEvent ${event} failed: ${e.message}`), { cause: e }), run.runId);
    }
  }

  async retry(runId) {
    return this.#serial(runId, async () => {
      // R1 修复：进入 retry 先取消该 run 已排定的自动重试定时器。
      // 场景：executor onTransient 排了 30s 退避，人工/恢复路径直接 retry 成功推进
      // ——残留定时器到期后对健康 run 再跑一次（executor 层虽 ignored，但 ref'd
      // 定时器会拖住进程/测试事件循环 30s+）。schedule() 自身会先 cancel，这里
      // 覆盖"不经过 schedule 的直接 retry"路径，与 control() 的取消对称。
      try { this.retryScheduler?.cancel(runId); } catch { /* 取消失败不阻塞 retry */ }
      const result = await (this.executors.get(runId)?.retry(runId) ?? { ignored: true });
      const run = this.liveRuns.get(runId);
      // R1 止血 F5/D1：自动审核触发条件从前置态 wasWaiting 改为后置态判断 ——
      // 崩溃恢复（restoreActive→resume）重建的 run 在 EXECUTING+pendingRemoteSync
      // 上完成 retry 后同样进入 AUDITING，旧前置守卫令该路径永不触发审核。
      // #maybeAutoReviewLocked 自带 reviewRounds dedupe，不会重复审。
      if (run && run.s.state === 'AUDITING' && run.s.auditInFlight) await this.#maybeAutoReviewLocked(runId);
      return result;
    });
  }

  async onEvent(session, event) {
    // 先为每个 run 建好任务再逐个 await，且单个 executor 的异常只计入本 run 的
    // 结果、不中断循环——否则终态 run 的残留 executor 抛错会饿死同 session 的
    // 活跃 run（marker 永远到不了目标 run，表现为 MARKER_PARSE_FAILED 假阳性）。
    const results = [];
    const tasks = [];
    for (const [runId, executor] of this.executors) {
      const prior = this.eventQueues.get(runId) ?? Promise.resolve();
      const task = prior.then(async () => {
        let r = await executor.onEvent(session, event);
        // 只有 Executor 确认是本 audit 自己的有效 turn/end 才触发自动审核；
        // 非绑定 session 的事件返回 {ignored:true}，不得误触 reviewer。
        if (r?.turnEnded === true) await this.#maybeAutoReviewLocked(runId);
        const current = this.liveRuns.get(runId);
        if (current && (r?.turnEnded || r?.ready || r?.advanced || r?.retry || r?.paused || r?.waitingQuota)) {
          const evName = r?.waitingQuota ? 'DSH_QUOTA_WAIT' : (r?.ready ? 'READY_FOR_AUDIT' : (r?.paused ? 'PAUSED' : 'EXECUTOR_EVENT'));
          this.#notify(current, evName, { result: r });
        }
        return r;
      });
      this.eventQueues.set(runId, task.catch(() => undefined));
      tasks.push({ runId, task });
    }
    let firstError = null;
    for (const { runId, task } of tasks) {
      try {
        results.push(await task);
      } catch (e) {
        if (!firstError) firstError = e;
        results.push({ ignored: true, error: String(e?.message ?? e) });
        // P-E：执行端事件处理自身抛错 = 未预期异常 → 事故（停-报-修-续），
        // 不再只沉在日志里。终态 run / 已开事故的不重复触发。
        const cur = this.liveRuns.get(runId);
        if (cur && !cur.isTerminal && !this.incidents.has(runId)) {
          this.#raiseIncidentSafe(cur, 'EXECUTOR_EVENT_FAILED', { error: e?.message ?? String(e) });
        }
      }
    }
    // 错误契约保留：全部分发完毕后再冒泡首个错误（原实现首个任务抛错即中断，
    // 会饿死同 session 其余 run 的分发）。
    if (firstError) throw firstError;
    return results;
  }

  async restoreActive() {
    const restored = [];
    const errors = [];
    for (const item of this.controller.store.listRuns()) {
      const loaded = this.controller.store.loadRun(item.runId);
      if (!loaded || ['STOPPED', 'STOPPED_TARGET_REACHED', 'ERROR'].includes(loaded.state.state)) continue;
      // P-E 简化版：重启前未解决的事故 → 只闸住 + 提醒，不自动 resume
      //（事故停机的 run 必须等人工修复后 /audit resume，AUTO 也不放行）。
      const persistedIncident = this.controller.store.readIncident?.(item.runId);
      if (persistedIncident?.status === 'open') {
        this.incidents.set(item.runId, { ...persistedIncident });
        try { this.retryScheduler.cancel(item.runId); } catch { /* 无排程可取消 */ }
        const ghost = AuditRun.open(this.controller.store, { now: this.controller.now })(item.runId);
        if (ghost) this.#notify(ghost, 'AUDIT_INCIDENT_RAISED', {
          trigger: persistedIncident.trigger,
          incidentId: persistedIncident.incidentId,
          reason: `桥重启完成；该 run 仍有未解决事故（${persistedIncident.trigger}），保持停机等人工。`,
          nextStep: '人工排查修复后发送 /audit resume 续跑。',
        });
        continue;
      }
      try { restored.push(await this.resume(item.runId)); }
      catch (error) { errors.push({ runId: item.runId, code: error.code ?? 'AUDIT_RESTORE_FAILED', message: error.message }); this.onError?.(error, item.runId); }
    }
    return { restored, errors };
  }

  /** P-E：当前（未解决）事故记录，/audit status 展示用。 */
  openIncident(runId) {
    const live = this.incidents.get(runId);
    if (live) {
      const { report: _r, ...rest } = live;
      return rest;
    }
    const persisted = this.controller.store.readIncident(runId);
    return persisted?.status === 'open' ? persisted : null;
  }

  async resume(runId, { human = false, bumpReviewIterations = null } = {}) {
    return this.#serial(runId, async () => {
    // P-E 简化版：事故停机中的 run 只认人工 resume（/audit resume）。
    // AUTO 的自动恢复（restoreActive / 状态机自动路径）一律不放行——
    // 事故必须由人修复，程序不猜修复是否已发生。
    const preIncident = this.incidents.has(runId);
    if (preIncident && !human) {
      throw Object.assign(new Error('run is halted on an open incident; human /audit resume required after manual repair'), { code: 'AUDIT_INCIDENT_OPEN' });
    }
    const run = AuditRun.open(this.controller.store, { now: this.controller.now })(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
    // 2026-09-30：旧持久化人闸等待态在 open→recoverTransientState 内被解除
    //（事件 HUMAN_GATE_REMOVED + 持久标记 humanGateRemovedAt）。补发条件
    // 做成持久判定：标记存在且其后尚无任何 executor 活动 —— 跨重启仍成立，
    // 执行器一旦开始产出事件即自然消费（不会重复补发）。
    const humanGateCleared = Boolean(run.humanGateCleared)
      || Boolean(run.s.humanGateRemovedAt && (run.s.lastExecutorEventAt ?? 0) < run.s.humanGateRemovedAt);
    const binding = this.bindings?.get(run.manifest.chatId);
    if (!binding || (run.manifest.observerSessionId && binding.sessionId !== run.manifest.observerSessionId)) {
      throw Object.assign(new Error('persisted observerSessionId does not match the owner chat binding'), { code: 'AUDIT_SESSION_BINDING_MISMATCH' });
    }
    let agent;
    const previousAuditSessionId = run.manifest.dshSessionId;
    try {
      agent = this.driver.ensureAuditSession
        ? await this.driver.ensureAuditSession({ cwd: run.manifest.cwd, sessionId: previousAuditSessionId, allowCreate: this.approvalPolicy === 'AUTO' })
        : await this.driver.ensure({ sessionId: run.manifest.dshSessionId, cwd: run.manifest.cwd }, { allowCreate: this.approvalPolicy === 'AUTO' });
    } catch (error) {
      // A lost/occupied executor session is an infrastructure fault. In AUTO
      // mode create a replacement durable session and rebind the run; never
      // leave a persisted run pointing at a dead session forever.
      if (this.approvalPolicy !== 'AUTO') throw error;
      agent = this.driver.ensureAuditSession
        ? await this.driver.ensureAuditSession({ cwd: run.manifest.cwd, allowCreate: true })
        : await this.driver.ensure({ cwd: run.manifest.cwd }, { allowCreate: true });
      run.rebindAuditSession(binding.sessionId, agent.id);
      this.#notify(run, 'AUDIT_AUTO_RECOVER', {
        message: `原审计 session 不可用，已自动重绑定新 session：${agent.id}`,
        previousSessionId: previousAuditSessionId,
        auditSessionId: agent.id,
      });
    }
    // MARKER_PARSE_FAILED is a recoverable executor-turn loss.  Human resume
    // changes the durable state back to EXECUTING, but the failed turn's
    // prompt is gone; reattaching with sendPrompt:false alone leaves the run
    // permanently idle (the exact failure seen after repeated resume).  Latch
    // this before resumeFromHuman clears/changes the paused state, then replay
    // the same stage prompt once after the executor is attached.
    const replayMarkerPrompt = human
      && run.s.state === 'PAUSED_NEEDS_USER'
      && run.s.cause === 'MARKER_PARSE_FAILED';
    // 桥重启不会持久化 AutoContinue 的等待 timer。若执行器 run 留在
    // WAIT_DSH_QUOTA，恢复时必须重新打开当前轮并补发 prompt，让新的
    // AutoContinue watcher 接管；否则 run 会永久停在 quota 状态。
    const replayDshQuotaPrompt = run.s.state === 'WAIT_DSH_QUOTA' && this.approvalPolicy === 'AUTO';
    if (replayDshQuotaPrompt) run.dshQuotaRecovered();
    const replayWebQuotaReview = run.s.state === 'WAIT_WEB_QUOTA' && this.approvalPolicy === 'AUTO';
    if (replayWebQuotaReview) run.webQuotaRecovered();
    // R1 止血 F5：/audit pause 后的 PAUSED 也是 resume 的合法目标 —— 此前只
    // 处理 PAUSED_NEEDS_USER，PAUSED 恢复落空、run 永远停摆。只在 human=true
    // （显式 /audit resume）时转移：restoreActive（human=false）不得把用户
    // 亲手暂停的 run 在桥重启后自动放行。
    const resumedFromPause = human && run.s.state === 'PAUSED';
    if ((human || (this.approvalPolicy === 'AUTO' && run.s.state === 'PAUSED_NEEDS_USER')) && run.s.state === 'PAUSED_NEEDS_USER') {
      if (run.s.cause === 'HISTORY_REWRITTEN') {
        // A rewritten history changes the evidence baseline; never invent a
        // baseline automatically. This is the one deliberately fail-closed
        // repository integrity condition.
        if (!human) throw Object.assign(new Error('history rewritten; automatic recovery requires a new baseline'), { code: 'AUDIT_BASELINE_REQUIRED' });
        throw Object.assign(new Error('history was rewritten: explicit new baseline required'), { code: 'AUDIT_BASELINE_REQUIRED' });
      }
      if (run.s.cause === 'MARKER_PARSE_FAILED') run.markHumanResumeCycle();
      run.resumeFromHuman({ bumpReviewIterations });
    } else if (resumedFromPause) {
      run.resume();
    }
    const gate = this.gitGateFactory({ cwd: run.manifest.cwd, timeoutMs: this.gitTimeoutMs });
    const executor = this.executorFactory({
      driver: this.driver, gitGate: gate,
      onTransient: this.retryScheduler ? (entry, _result, attempt) => this.#scheduleRetry(entry.run.runId, attempt) : null,
      onQuota: this.onQuota,
    });
    this.executors.set(runId, executor);
    this.liveRuns.set(runId, run);
    await executor.start({ run, agent, gitGate: gate, sendPrompt: false });
    if (replayMarkerPrompt) {
      executor.startStage(runId);
    }
    if (human && run.s.state === 'AUDITING' && run.s.auditInFlight) {
      this.reviewRounds.delete(runId);
    }
    // A5.5 recovery: REVISE 已将状态交还 EXECUTING，但 feedback prompt
    // 可能在桥重启前尚未被 executor session 消费。此时必须补发同一
    // iteration 的修复 prompt；普通 EXECUTING 恢复仍不重复发送。
    const reviseRecovery = run.s.state === 'EXECUTING'
      && run.s.lastVerdict?.state === 'REVISE'
      && run.s.iteration > (run.s.lastVerdict.iteration ?? 0)
      && run.s.headCommit === run.s.lastVerdict.headCommit;
    if (reviseRecovery || replayDshQuotaPrompt) {
      // quota 状态恢复时 executor 的旧 turn 已结束，必须重新发当前阶段 prompt；
      // 普通 AUDITING/EXECUTING 重挂仍维持不重复发 prompt 的语义。
      executor.startStage(runId);
    } else if ((resumedFromPause || preIncident || humanGateCleared)
      && run.s.state === 'EXECUTING'
      && agent.status === 'idle'
      && !run.s.pendingRemoteSync) {
      // R1 止血 F5（D4 同款）：暂停/事故停机被取消或死掉的 turn 不会再有
      // 事件 —— 人工恢复后若执行端 idle 静坐，必须补发当前阶段 prompt，
      // 否则没人再驱动该 run。范围仅限显式恢复路径：EXECUTING 的重启重挂
      // 必须保持「不重复发送 stage prompt」的既有冻结语义（lifecycle-e2e）。
      // 2026-09-30 追加 humanGateCleared：旧持久化人闸等待态在加载时被
      // recoverTransientState 解除（HUMAN_GATE_REMOVED），该 turn 早已死亡，
      // 必须补发阶段 prompt 才能无人值守续跑。
      executor.startStage?.(runId);
    }
    // P-E 简化版：人工 resume = 确认事故已修复。关闭事故 + 汇报，
    // 之后再走下方正常的自动审核/重试路径。
    if (preIncident) {
      const inc = this.incidents.get(runId);
      const { report: _r, ...persistable } = inc ?? {};
      if (persistable?.incidentId) {
        this.controller.store.writeIncident?.(runId, { ...persistable, status: 'resolved', resolvedAt: Date.now(), resolution: 'resolved by human (/audit resume)' });
      }
      this.incidents.delete(runId);
      this.recoveryAttempts.delete(`review:${runId}`);
      this.#appendRunEvent(run, 'AUDIT_INCIDENT_RESOLVED', { incidentId: inc?.incidentId, by: 'human' });
      this.#notify(run, 'AUDIT_INCIDENT_RESOLVED', {
        incidentId: inc?.incidentId,
        reason: '人工确认修复，审计运行恢复。',
        nextStep: run.s.state === 'AUDITING' ? '同轮审核将自动重发。' : '当前阶段 prompt 已补发，运行继续。',
      });
    }
    if (run.s.pendingRemoteSync) {
      this.#scheduleRetry(runId, run.s.retry.pushAttempts);
    }
    if (run.s.state === 'AUDITING') await this.#maybeAutoReviewLocked(runId);
    return { run, agent, executor };
    });
  }
}
