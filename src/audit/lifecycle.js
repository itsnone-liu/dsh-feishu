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
import { AuditExecutor, textFromMessage } from './executor.js';
import { GitRemoteGate } from './git-gate.js';
import { buildSealApprovalText, buildRevealApprovalText, approvalForGateKind } from './protocol.js';
import { loadTaskPacket } from './task-packet.js';
import { AuditRetryScheduler } from './retry-scheduler.js';
import { parsePreauthText } from './preauth-protocol.js';
import { buildRepairPrompt, buildRepairNudge, parseRepairReport } from './repair-protocol.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export class AuditLifecycle {
  constructor({ controller, driver, bindings, onProgress = null, watchdogMs = 5 * 60_000, gitGateFactory = (opts) => new GitRemoteGate(opts), executorFactory = (opts) => new AuditExecutor(opts), taskPacketLoader = loadTaskPacket, retryScheduler = null, onError = null, reviewTimeoutMs = 20 * 60_000, gitTimeoutMs = 120_000, preauthStore = null, approvalPolicy = 'MANUAL', gitSnapshotProvider = null, restartBridge = null,
    // P-E「停-报-修-续」参数（桥内不再做 LLM 枚举恢复/自动代码修复）：
    repairCwd = null, repairWatchdogMs = 30 * 60_000, repairRetryDelays = null, repairResetAfter = 3,
    reviewRetryDelays = null, reviewInfraIncidentAfter = 3, logFileHint = null,
  } = {}) {
    this.controller = controller;
    this.driver = driver;
    this.onError = onError;
    this.bindings = bindings;
    this.onProgress = onProgress;
    this.watchdogMs = watchdogMs;
    this.reviewTimeoutMs = reviewTimeoutMs; // R1 F4：reviewer.review 硬超时（默认 20min，可注入；测试传 1ms）
    this.gitTimeoutMs = gitTimeoutMs;       // R1 F4：git 子进程硬超时（透传 gitGateFactory）
    // P-B §3：门位预授权消费只读候选 + 单事务消费（markConsumed）；登记权
    //（append/revoke）仍只在 commands 层（I7）。null = 未装配 = 全走人工话术。
    this.preauthStore = preauthStore;
    // AUTO is the production unattended policy. MANUAL remains an explicit
    // step-by-step compatibility mode for tests and deliberate re-audits.
    this.approvalPolicy = String(approvalPolicy ?? 'MANUAL').toUpperCase();
    // P-E 事故处理：异常 → 停（停该 run 的自动重试，保留现场）→ 报（持久化
    // 完整事故报告 + 飞书卡）→ 修（独立修复 agent session 调查/修复/自测/
    // commit）→ 续（修复完成后自动 resume）。多修几次，常见问题自然收敛。
    this.restartBridge = restartBridge;
    this.gitSnapshotProvider = gitSnapshotProvider; // 事故报告里的 git 快照采集
    this.repairCwd = repairCwd;
    this.repairWatchdogMs = repairWatchdogMs;
    this.repairRetryDelays = repairRetryDelays ?? [60_000, 300_000, 900_000, 1_800_000];
    this.repairResetAfter = repairResetAfter;
    this.reviewRetryDelays = reviewRetryDelays ?? [30_000, 60_000, 120_000, 240_000];
    this.reviewInfraIncidentAfter = reviewInfraIncidentAfter;
    this.logFileHint = logFileHint;
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
    /** runId → 修复 session 跟踪 { agent, incidentId, attempt, startedAt, lastEventAt, nudged, report } */
    this.repairs = new Map();
    /** runId → 修复重派退避 timer */
    this.repairTimers = new Map();
    /** runId → 连续 BLOCKED / 派出失败计数（repairResetAfter 用） */
    this.repairAttempts = new Map();
    this.watchdogInterval = setInterval(() => this.#watchdog(), 60_000);
    this.watchdogInterval.unref?.();
  }

  #notify(run, event, detail = {}) {
    this.activity.set(run.runId, { at: Date.now(), warned: event === 'WATCHDOG_TIMEOUT' });
    try { this.onProgress?.({ runId: run.runId, chatId: run.manifest.chatId, stage: run.s.currentStage, state: run.s.state, event, ...detail }); } catch {}
  }

  /**
   * R1 止血 F1：人闸等待的完整通知 detail。此前 onProgress 只有一行状态摘要，
   * 用户看不到问题、hash 与批准话术 —— 人闸等同静默死锁。话术由
   * protocol.buildSealApprovalText 按 SEAL_APPROVAL_RE 冻结语义构造
   * （sealApprovalHash 可校验回同一 hash）；旧 state 无 waitingQuestion 字段
   * 读出 undefined → null，兼容。
   */
  #humanWaitDetail(run) {
    const hash = run.s.waitingApprovalHash ?? null;
    return {
      reason: run.s.waitingReason ?? null,
      question: run.s.waitingQuestion ?? null,
      approvalHash: hash,
      approvalTemplate: hash ? buildSealApprovalText(hash) : null,
      stopHint: '/audit stop',
    };
  }

  #watchdog() {
    const now = Date.now();
    for (const run of this.liveRuns.values()) {
      if (run.isTerminal || ['WAIT_DSH_QUOTA', 'WAIT_WEB_QUOTA'].includes(run.s.state)) continue;
      if (this.incidents.has(run.runId)) continue; // 事故处理中：交给修复监督，不再重复触发
      const a = this.activity.get(run.runId) ?? { at: run.s.updatedAt ?? now, warned: false };
      const last = run.s.lastExecutorEventAt ?? a.at;
      if (now - last < this.watchdogMs) continue;
      if (!a.warned) {
        this.#notify(run, 'WATCHDOG_TIMEOUT', { idleMs: now - last, message: '审计执行器超过 watchdog 窗口无进展，转入事故处理（停-报-修-续）。' });
        a.warned = true; this.activity.set(run.runId, a);
      }
      // P-E：异常就停 + 汇报 + 派修复 agent，修复后自动续跑。同一事故只处理
      // 一次；未知的 executor 挂起不再靠重放同一操作碰运气。
      this.#raiseIncidentSafe(run, 'WATCHDOG_TIMEOUT', { idleMs: now - last });
    }
    this.#superviseRepairs(now);
  }

  /** P-E：修复 session 停滞监督（静默超窗 → 提醒一次 → 再停滞取消并按退避重派）。 */
  #superviseRepairs(now) {
    for (const [runId, rp] of [...this.repairs]) {
      const silent = now - (rp.lastEventAt ?? rp.startedAt ?? now);
      if (silent < this.repairWatchdogMs) continue;
      if ((rp.nudged ?? 0) === 0) {
        rp.nudged = 1;
        rp.lastEventAt = now;
        try { this.driver.submit(rp.agent, '（系统提醒）修复已静默较久。请继续调查，并按要求输出 [DSH-REPAIR] 报告块。'); } catch { /* 提醒失败留给下次监督 */ }
        const run = this.liveRuns.get(runId);
        if (run) this.#notify(run, 'AUDIT_REPAIR_STALLED', { attempt: rp.attempt, message: `修复 agent 静默 ${Math.round(silent / 60_000)} 分钟，已发提醒。` });
        continue;
      }
      try { rp.agent?.cancel?.({ kind: 'user' }, { keepInbox: true }); } catch { /* 取消失败也重派 */ }
      this.repairs.delete(runId);
      const run = this.liveRuns.get(runId);
      if (run) this.#notify(run, 'AUDIT_REPAIR_STALLED', { attempt: rp.attempt, message: '修复 agent 二次停滞，已取消并按退避安排重派。' });
      this.#scheduleRepairRetry(runId, 'repair agent stalled twice');
    }
  }

  /** 事故入口（安全包装）：任何异常路径都可调，自身绝不抛出。 */
  #raiseIncidentSafe(run, trigger, detail = {}) {
    if (!run || run.isTerminal) return;
    Promise.resolve()
      .then(() => this.#raiseIncident(run, trigger, detail))
      .catch((e) => this.#incidentDispatchFailed(run, e));
  }

  /**
   * P-E 核心：有异常就停 → 汇报 → 派修复 agent。
   * 「停」= 停止该 run 的一切自动重试（git 重试 / 审核重试 / watchdog 再触发），
   * 在跑的 executor turn 不取消 —— 它可能只是慢而非死，晚到的完成事件照常
   * 推进状态机（executor 监听保持挂载），修复完成后统一续跑。
   */
  async #raiseIncident(run, trigger, detail = {}) {
    if (this.incidents.has(run.runId)) return; // 一 run 一事故：处理中不重复触发
    const incident = await this.#incidentContext(run, trigger, detail);
    incident.bridge = {
      pid: process.pid,
      bridgeRoot: this.repairCwd ?? process.cwd(),
      logFile: this.logFileHint ?? null,
    };
    const record = {
      incidentId: incident.incidentId,
      runId: run.runId,
      trigger,
      raisedAt: Date.now(),
      status: 'open',
      repairAttempt: 0,
      repairSessionId: null,
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
      nextStep: '已停止自动重试并保留现场，正在派出修复 agent 调查修复；修复完成后自动续跑，无需人工介入。',
    });
    await this.#dispatchRepair(run.runId, 1, null);
  }

  async #dispatchRepair(runId, attempt, previousBlockedSummary) {
    const inc = this.incidents.get(runId);
    const run = this.liveRuns.get(runId);
    if (!inc || !run || run.isTerminal) return;
    const rp = this.repairs.get(runId);
    if (rp && rp.agent?.status === 'running') {
      // 修复 session 的上一个 turn 还没结束（慢而非死）：不重复派 prompt，
      // 但必须留在监督名单里 —— 否则它若真卡死将无人再管（watchdog 对
      // 事故中的 run 是跳过的）。
      rp.lastEventAt = Date.now();
      return;
    }
    this.#clearRepairTimer(runId);
    const workspace = run.manifest.cwd;
    const bridgeRoot = this.repairCwd ?? process.cwd();
    const agent = await this.driver.ensureRepairSession({
      cwd: bridgeRoot,
      sessionId: rp?.agent?.id ?? inc.repairSessionId ?? null,
      allowCreate: true,
    });
    this.repairs.set(runId, {
      agent, incidentId: inc.incidentId, attempt,
      startedAt: Date.now(), lastEventAt: Date.now(), nudged: 0, report: null,
    });
    inc.repairAttempt = attempt;
    inc.repairSessionId = agent.id;
    const { report: _r1, ...persistable } = inc;
    this.controller.store.writeIncident(runId, persistable);
    this.#appendRunEvent(run, 'AUDIT_REPAIR_DISPATCHED', { attempt, sessionId: agent.id, incidentId: inc.incidentId });
    this.#notify(run, 'AUDIT_REPAIR_DISPATCHED', {
      attempt,
      reason: `第 ${attempt} 次修复尝试，修复 agent session \`${agent.id}\`（工作目录 ${bridgeRoot}）`,
      nextStep: '修复 agent 正在调查事故报告（可读代码/日志、改文件、跑测试、本地 commit）；完成后自动续跑。',
    });
    this.driver.submit(agent, buildRepairPrompt({
      incident: inc.report,
      runId,
      incidentId: inc.incidentId,
      attempt,
      workspace,
      bridgeRoot,
      logFile: this.logFileHint ?? null,
      previousBlockedSummary,
    }));
  }

  /** 事故处理自身故障（派出失败等）：汇报 + 按退避重试派出，绝不静默放弃。 */
  #incidentDispatchFailed(run, error) {
    const message = `事故处理失败：[${error?.code ?? 'AUDIT_INCIDENT_DISPATCH_FAILED'}] ${error?.message ?? error}`;
    this.onError?.(Object.assign(new Error(message), { code: 'AUDIT_INCIDENT_DISPATCH_FAILED', cause: error }), run?.runId);
    try { this.#notify(run, 'AUDIT_INCIDENT_DISPATCH_FAILED', { reason: message }); } catch { /* 通知失败不影响重试 */ }
    this.#scheduleRepairRetry(run?.runId, message);
  }

  #scheduleRepairRetry(runId, why) {
    if (!runId || !this.incidents.has(runId)) return;
    if (this.repairTimers.has(runId)) return;
    // 计数由 #handleRepairReport（连续 BLOCKED）维护；这里只按当前节奏取退避间隔。
    const n = this.repairAttempts.get(runId) ?? 0;
    const delayMs = this.repairRetryDelays[Math.max(0, Math.min(n - 1, this.repairRetryDelays.length - 1))] ?? this.repairRetryDelays.at(-1);
    const run = this.liveRuns.get(runId);
    if (run) this.#notify(run, 'AUDIT_REPAIR_RETRY_SCHEDULED', { attempt: (this.incidents.get(runId)?.repairAttempt ?? 0) + 1, retryInMs: delayMs, reason: why });
    const timer = setTimeout(() => {
      this.repairTimers.delete(runId);
      const inc = this.incidents.get(runId);
      const r = this.liveRuns.get(runId);
      if (!inc || !r || r.isTerminal) return;
      const blocked = this.#lastBlockedSummary(runId);
      this.#dispatchRepair(runId, inc.repairAttempt + 1, blocked)
        .catch((e) => this.#incidentDispatchFailed(r, e));
    }, delayMs);
    timer.unref?.();
    this.repairTimers.set(runId, timer);
  }

  #lastBlockedSummary(runId) {
    try {
      const items = this.controller.store.listRecoveryIncidents(runId);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const rep = items[i]?.incident?.repair;
        if (rep?.status === 'BLOCKED') return rep.summary ?? null;
      }
    } catch { /* 读取失败不带偏见：当作无摘要 */ }
    return null;
  }

  #clearRepairTimer(runId) {
    const t = this.repairTimers.get(runId);
    if (t) clearTimeout(t);
    this.repairTimers.delete(runId);
  }

  /** 修复 agent session 事件处理（onEvent 的前置分支）。 */
  async #onRepairEvent(runId, rp, event) {
    const data = event?.data ?? event;
    rp.lastEventAt = Date.now();
    if (event?.type === 'assistant/message') {
      const report = parseRepairReport(textFromMessage(data), { runId, incidentId: rp.incidentId });
      if (report) rp.report = report;
      return { repairEvent: true };
    }
    if (event?.type === 'turn/end') {
      if (rp.report) {
        const report = rp.report;
        rp.report = null;
        this.repairs.delete(runId);
        this.#handleRepairReport(runId, report);
        return { repairEvent: true, repair: report.status };
      }
      rp.nudged = (rp.nudged ?? 0) + 1;
      if (rp.nudged <= 2) {
        try { this.driver.submit(rp.agent, buildRepairNudge({ runId, incidentId: rp.incidentId })); } catch { /* 提醒失败留给停滞监督 */ }
        return { repairEvent: true, nudged: rp.nudged };
      }
      this.repairs.delete(runId);
      const run = this.liveRuns.get(runId);
      if (run) this.#notify(run, 'AUDIT_REPAIR_STALLED', { attempt: rp.attempt, message: '修复 agent 连续两次未按要求输出报告块，按未解决处理。' });
      this.#scheduleRepairRetry(runId, 'repair agent did not report');
      return { repairEvent: true };
    }
    return { repairEvent: true };
  }

  #handleRepairReport(runId, report) {
    const run = this.liveRuns.get(runId);
    const inc = this.incidents.get(runId);
    if (!run || !inc) return; // 事故已被清理（如用户 stop）：报告只留痕不动作
    this.controller.store.appendRecoveryIncident({ runId, incident: { incidentId: inc.incidentId, repair: report } });
    if (report.status === 'DONE') {
      this.#appendRunEvent(run, 'AUDIT_REPAIR_DONE', { incidentId: inc.incidentId, files: report.files, restart: report.restart });
      this.incidents.delete(runId);
      this.repairAttempts.delete(runId);
      this.#clearRepairTimer(runId);
      const { report: _r2, ...persistable } = inc;
      this.controller.store.writeIncident(runId, { ...persistable, status: 'resolved', resolvedAt: Date.now(), resolution: report.summary ?? null });
      this.#notify(run, 'AUDIT_REPAIR_DONE', {
        summary: report.summary,
        reason: `修复完成（${report.files?.length ?? 0} 个文件${report.restart ? '，需重启桥加载' : ''}）`,
        nextStep: report.restart
          ? '修复涉及桥本体代码：桥将重启加载新代码，重启后自动恢复审计运行。'
          : '已自动恢复审计运行。',
      });
      if (report.restart && this.restartBridge) {
        // 事故状态已落盘 resolved：重启后 restoreActive 走正常 resume，不会重复派修。
        Promise.resolve(this.restartBridge({ chatId: run.manifest.chatId, runId, files: report.files, reason: report.summary }))
          .catch((e) => this.onError?.(e, runId));
        return;
      }
      this.#resumeAfterRepair(runId).catch((e) => {
        this.#notify(run, 'AUDIT_INCIDENT_DISPATCH_FAILED', { reason: `修复后恢复失败：${e?.message ?? e}` });
        this.onError?.(e, runId);
      });
      return;
    }
    // BLOCKED：记录 + 计数；连续未解决且执行端仍在跑 → 操作复位（取消疑似
    // 卡死的 turn 直接续跑），避免修复-阻塞乒乓。否则按退避重派。
    this.#appendRunEvent(run, 'AUDIT_REPAIR_BLOCKED', { incidentId: inc.incidentId, attempt: inc.repairAttempt, summary: report.summary });
    const n = (this.repairAttempts.get(runId) ?? 0) + 1;
    this.repairAttempts.set(runId, n);
    if (n >= this.repairResetAfter) {
      const bound = this.driver.live?.get(run.manifest.dshSessionId)?.agent;
      if (bound && bound.status === 'running') {
        try { bound.cancel?.({ kind: 'user' }, { keepInbox: true }); } catch { /* 取消失败仍续跑 */ }
      }
      this.#notify(run, 'AUDIT_REPAIR_DONE', {
        reason: `连续 ${n} 次修复未解决；已取消疑似卡死的执行端 turn，直接恢复运行继续观察。`,
        summary: report.summary,
        nextStep: '若同一异常再次出现将重新进入事故处理。',
      });
      this.incidents.delete(runId);
      this.repairAttempts.delete(runId);
      this.#clearRepairTimer(runId);
      const { report: _r3, ...persistable } = inc;
      this.controller.store.writeIncident(runId, { ...persistable, status: 'resolved', resolvedAt: Date.now(), resolution: `reset-after-${n}-blocked：${report.summary ?? ''}` });
      this.#resumeAfterRepair(runId, { forceReattach: true }).catch((e) => this.onError?.(e, runId));
      return;
    }
    this.#notify(run, 'AUDIT_REPAIR_BLOCKED', { attempt: inc.repairAttempt, summary: report.summary, nextStep: '将按退避自动重派修复 agent（换角度继续调查）。' });
    this.#scheduleRepairRetry(runId, report.summary ?? 'repair blocked');
  }

  /** 修复完成后恢复运行：执行端仍在跑则只解除闸门保持监听；idle 则重挂 + 补发阶段 prompt。 */
  async #resumeAfterRepair(runId, { forceReattach = false } = {}) {
    const run = this.liveRuns.get(runId);
    if (!run || run.isTerminal) return;
    const bound = this.driver.live?.get(run.manifest.dshSessionId)?.agent;
    if (!forceReattach && bound && bound.status === 'running') {
      // turn 还活着（慢而非死）：不取消不重挂，保持既有 executor 监听；
      // turn 结束后状态机自然推进，自动审核已随闸门解除而恢复。
      // forceReattach（操作复位路径）例外：刚发起的 cancel 不会同步翻转
      // status，若按 running 走保活分支会永远不再驱动该 run。
      this.activity.set(runId, { at: Date.now(), warned: false });
      this.#notify(run, 'AUDIT_RESUMED_AFTER_REPAIR', {
        state: run.s.state,
        reason: '执行端 turn 仍在进行，保持监听不干预。',
        nextStep: '事故已处理，自动推进恢复。',
      });
      return { keptAlive: true };
    }
    let result;
    try {
      result = await this.resume(runId, { human: false });
    } catch (e) {
      if (e?.code === 'AUDIT_SESSION_OCCUPIED') {
        try { bound?.cancel?.({ kind: 'user' }, { keepInbox: true }); } catch { /* 重挂再试 */ }
        result = await this.resume(runId, { human: false });
      } else throw e;
    }
    const fresh = this.liveRuns.get(runId);
    const executor = this.executors.get(runId);
    // D4 同款：事故期间停掉的自动驱动，恢复后若执行端 idle 静坐必须补发
    // 当前阶段 prompt，否则没人再驱动该 run。
    if (fresh && executor && fresh.s.state === 'EXECUTING'
      && !fresh.s.pendingRemoteSync && !fresh.s.waitingForHuman) {
      if (result?.agent?.status === 'idle') {
        executor.startStage(runId);
      } else if (forceReattach) {
        // 操作复位路径刚 cancel 的 turn：status 翻转是异步的，立刻看仍是
        // running。短暂轮询等落定后补发，否则该 run 将无人驱动（取消的
        // turn 不会再产生事件）。有界等待，落不定就放弃（watchdog 兜底）。
        const deadline = Date.now() + 15_000;
        const poll = () => {
          const live2 = this.liveRuns.get(runId);
          if (!live2 || live2.isTerminal || live2.s.state !== 'EXECUTING') return;
          const agent2 = this.driver.live?.get(live2.manifest.dshSessionId)?.agent ?? result?.agent;
          if ((agent2?.status ?? 'idle') !== 'idle') {
            if (Date.now() < deadline) { const t = setTimeout(poll, 250); t.unref?.(); }
            return;
          }
          try { executor.startStage(runId); } catch (e) { this.onError?.(e, runId); }
        };
        const t = setTimeout(poll, 250);
        t.unref?.();
      }
    }
    this.activity.set(runId, { at: Date.now(), warned: false });
    this.#notify(fresh ?? run, 'AUDIT_RESUMED_AFTER_REPAIR', {
      state: fresh?.s?.state,
      nextStep: '事故已处理，审计运行已恢复。',
    });
    return result;
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
      stageGates: packet.stageGates ?? {}, preauthorization: packet.preauthorization ?? null, // P-B 门位声明随 manifest 冻结
    }, { maxReviewIterations: this.controller.maxReviewIterations, now: this.controller.now });
    const executor = this.executorFactory({
      driver: this.driver, gitGate: gate,
      onTransient: this.retryScheduler ? (entry, _result, attempt) => this.#scheduleRetry(entry.run.runId, attempt) : null,
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
  async startContinuation({ chatId, stopAfter = null } = {}) {
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
    // 定位父 run：最近一条 owner 的 STOPPED_TARGET_REACHED。
    let parent = null;
    for (const r of this.controller.store.listRuns().slice().reverse()) {
      const loaded = this.controller.store.loadRun(r.runId);
      if (loaded
        && (loaded.manifest.chatId ?? null) === chatId
        && loaded.state.state === 'STOPPED_TARGET_REACHED') {
        parent = loaded;
        break;
      }
    }
    if (!parent) {
      throw Object.assign(new Error('没有已到达停止点的审计运行可延续；先 /audit <阶段> 或 /audit 创建。'), { code: 'AUDIT_NO_CONTINUATION' });
    }
    const pm = parent.manifest;
    const lastDoneIdx = pm.stages.indexOf(parent.state.stopAfter ?? pm.stopAfter);
    const nextStage = pm.stages[lastDoneIdx + 1];
    if (nextStage == null) {
      throw Object.assign(new Error(`任务链 \`${pm.rootRunId ?? pm.runId}\` 最后阶段 ${pm.stopAfter} 已 APPROVE，没有后续阶段。`), { code: 'AUDIT_ALREADY_COMPLETE' });
    }
    let stopAfterStage = nextStage;
    if (stopAfter != null) {
      const resolved = pm.stages.includes(stopAfter) ? stopAfter : null;
      if (!resolved) {
        throw Object.assign(new Error(`停止点 ${stopAfter} 不在阶段表 [${pm.stages.join(', ')}] 中`), { code: 'AUDIT_MANIFEST_INVALID' });
      }
      if (pm.stages.indexOf(resolved) < pm.stages.indexOf(nextStage)) {
        throw Object.assign(new Error(`延续运行不能停在已完成阶段之前：下一起点为 ${nextStage}，请求停止点 ${resolved} 早于它。`), { code: 'AUDIT_CONTINUATION_STAGE_INVALID' });
      }
      stopAfterStage = resolved;
    }
    // 绑定 session 与真实 git（与 start() 同一套边界：不创建新 session、不并发）。
    const binding = this.bindings?.get(chatId);
    if (!binding?.sessionId || !binding?.cwd) {
      throw Object.assign(new Error('当前聊天必须已有绑定的 DSH session 和 workspace；/audit next 不会偷偷创建新 session'), { code: 'AUDIT_SESSION_REQUIRED' });
    }
    if (!this.driver?.ensure) throw Object.assign(new Error('DSH driver unavailable'), { code: 'AUDIT_EXECUTOR_CONFIG_INVALID' });
    let agent;
    try {
      agent = await this.driver.ensure({ ...binding }, { allowCreate: false });
    } catch (e) {
      if (e?.occupied) throw Object.assign(e, { code: 'AUDIT_SESSION_OCCUPIED' });
      throw Object.assign(e, { code: e.code ?? 'AUDIT_SESSION_RESUME_FAILED' });
    }
    if (agent.status !== 'idle') {
      throw Object.assign(new Error('绑定的 DSH session 当前正在运行；/audit next 不会并发或偷偷 fork'), { code: 'AUDIT_SESSION_OCCUPIED' });
    }
    const gate = this.gitGateFactory({ cwd: binding.cwd, timeoutMs: this.gitTimeoutMs });
    const packet = this.taskPacketLoader(binding.cwd);
    // 任务链一致性：工作区任务书哈希必须与父链一致（改了任务书 → 显式拒绝，fail closed）。
    if (pm.taskPacketHash && packet.taskPacketHash !== pm.taskPacketHash) {
      throw Object.assign(new Error(
        `工作区任务书哈希 \`${packet.taskPacketHash}\` 与父链 \`${pm.taskPacketHash}\` 不一致；延续运行不得更换任务书。`,
      ), { code: 'AUDIT_PACKET_MISMATCH' });
    }
    const git = await gate.inspect({});
    const stamp = new Date(this.controller.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
    let runId = `audit_${stamp}`;
    for (let n = 2; this.controller.store.loadRun(runId); n += 1) runId = `audit_${stamp}_${n}`;
    const completedStages = [...(pm.completedStages ?? []), pm.stages[lastDoneIdx]];
    const run = AuditRun.create(this.controller.store, {
      runId, hostId: this.controller.hostId, chatId,
      observerSessionId: binding.sessionId ?? null, dshSessionId: agent.id,
      cwd: git.cwd, repo: git.repo, branch: git.branch,
      stages: pm.stages, stopAfter: stopAfterStage, currentStage: nextStage,
      startingCommit: git.head, stageBaseCommit: parent.state.headCommit,
      goal: pm.goal, approvedPlan: pm.approvedPlan,
      taskPacketHash: pm.taskPacketHash, stageRequirements: pm.stageRequirements,
      stageGates: pm.stageGates ?? {}, preauthorization: packet.preauthorization ?? null, // P-B 门位声明随 manifest 冻结
      parentRunId: pm.runId, rootRunId: pm.rootRunId ?? pm.runId, completedStages,
      ignorePaths: pm.ignorePaths,
    }, { maxReviewIterations: this.controller.maxReviewIterations, now: this.controller.now });
    const executor = this.executorFactory({
      driver: this.driver, gitGate: gate,
      onTransient: this.retryScheduler ? (entry, _result, attempt) => this.#scheduleRetry(entry.run.runId, attempt) : null,
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
    // P-C：人闸溯源注入（评审员据此认证"门已被人类授权"——EXACT/CONSTRAINT
    // 预授权放行或人工话术放行都留事件；无门阶段不注入）。
    const gateEvents = this.#chainEvents(run).filter((e) => ['GATE_PASSED', 'GATE_PASSED_BY_PREAUTH', 'GATE_PASSED_BY_POLICY', 'GATE_PREAUTH_MISMATCH'].includes(e.event)
      && String(e.stage).toUpperCase() === String(stage).toUpperCase());
    const stageGateDecl = run.manifest.stageGates?.[String(stage).toUpperCase()] ?? null;
    if (stageGateDecl || gateEvents.length > 0) {
      packet.gateProvenance = {
        declaredGate: stageGateDecl,
        preauthorizationSemantics: run.manifest.preauthorization?.semantics ?? null,
        events: gateEvents.map((e) => ({
          event: e.event, stage: e.stage, iteration: e.iteration,
          approvalHash: e.approvalHash ?? null, preauthId: e.preauthId ?? null,
          binding: e.binding ?? null, detail: e.detail ?? null,
        })),
        note: 'GATE_PASSED 携带被批准话术的 receipt sha256（approvalHash）；GATE_PASSED_BY_PREAUTH 为桥经验证的人类预授权记录放行（preauthId 可溯源 PreauthStore 登记话术与消息）；GATE_PREAUTH_MISMATCH 为未放电的失配尝试（审计留痕）。',
      };
    }
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
        this.repairs.delete(runId);
        this.#clearRepairTimer(runId);
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
    });
    this.executors.set(runId, executor);
    await executor.start({
      run: old,
      agent,
      gitGate: gate,
      sendPrompt: old.s.state === 'EXECUTING' && !old.s.waitingForHuman,
    });
    this.#notify(old, 'AUDIT_SESSION_REBOUND', { auditSessionId: agent.id, observerSessionId: binding.sessionId });
    return { run: old, agent, executor };
    });
  }

  async submitHumanResponse(chatId, text) {
    for (const [runId, run] of this.liveRuns) {
      if (run.manifest.chatId !== chatId || !run.s.waitingForHuman) continue;
      const executor = this.executors.get(runId);
      if (!executor) return { handled: false, reason: 'executor_missing' };
      // P-B §3：预授权先于人工话术尝试（先到先消费，两者并行）。
      const gateHash = run.s.waitingApprovalHash;
      let pre = null;
      if (this.preauthStore) {
        let parsed = null;
        try { parsed = parsePreauthText(text); } catch { parsed = null; }
        if (parsed) {
          // §1/§4：用户发出逐字话术本身就是登记行为 —— 先落记录（本 run 链绑定、
          // 24h 默认窗；EXACT 运行链取自话术），再走消费验证。单条消息即完成
          // "登记+放行"；若与当前门位失配，记录保留给未来匹配该 hash/约束的布防。
          this.#registerPreauthRecord(run, parsed, chatId, text);
          pre = this.#verifyPreauthCandidates(run, { bindingFilter: parsed.binding, gateKindFilter: parsed.gateKind });
        } else pre = null;
      }
      if (pre?.passed) {
        const injected = this.#injectCanonicalApproval(run, runId, pre.record, gateHash);
        if (injected) return { handled: true, runId, byPreauth: true, preauthId: pre.record.preauthId };
        return { handled: false, runId, reason: 'canonical_phrase_rejected' };
      }
      if (pre?.mismatch) {
        this.#appendRunEvent(run, 'GATE_PREAUTH_MISMATCH', { stage: run.s.currentStage, receiptHash: gateHash, detail: pre.detail });
        this.#notify(run, 'GATE_PREAUTH_MISMATCH', { message: `预授权话术与门位事实不符（${pre.detail}），不放电；可人工话术批准或 /audit preauth list 检查。` });
        // 失配不阻断人工话术并行路径（该文本若同时是合法人工话术仍可放行）。
      }
      const result = executor.submitHumanResponse(runId, text);
      return { handled: Boolean(result.submitted), runId, byPreauth: false, ...result };
    }
    return { handled: false };
  }

  /** §4 话术即登记：解析成功的预授权话术在发送瞬间落 PreauthStore 记录。 */
  #registerPreauthRecord(run, parsed, chatId, text) {
    const common = {
      chatId, messageRef: `chat:${chatId}:${Date.now()}`, humanText: String(text ?? '').trim(),
      binding: parsed.binding, gateKind: parsed.gateKind, stage: parsed.stage,
      expiresAt: parsed.expiresAt ?? Date.now() + 24 * 3600_000,
    };
    try {
      if (parsed.binding === 'EXACT') {
        this.preauthStore.append({ ...common, receiptHash: parsed.receiptHash, runScope: parsed.runScope });
      } else {
        this.preauthStore.append({
          ...common, constraints: parsed.constraints,
          runScope: { rootRunId: run.manifest.rootRunId ?? run.runId },
        });
      }
    } catch (e) {
      this.onError?.(new Error(`preauth register-from-phrase failed: ${e.message}`), run.runId);
    }
  }

  /**
   * P-B §3 步骤 1-5：WAIT 布防即自动尝试预授权放行（无人值守触发点，不等
   * 用户消息）。无候选/失配按步骤 5 静默走 NEED_USER 现状路径（通知由
   * onEvent 的 WAITING_FOR_HUMAN 分支发 R1 卡，不重复失配细节）。
   */
  async #autoPreauthPass(run, runId) {
    if (!run.s.waitingForHuman) return null;
    const gateHash = run.s.waitingApprovalHash;
    // Pure unattended mode: the declared gate is an automatic protocol step,
    // never a human stop. Keep the canonical phrase injection so downstream
    // seal/reveal artifacts remain byte-verifiable, but do not require a
    // PreauthStore record or a chat message.
    if (this.approvalPolicy === 'AUTO') {
      const policyRecord = { preauthId: null, binding: 'POLICY_AUTO' };
      const injected = this.#injectCanonicalApproval(run, runId, policyRecord, gateHash, 'GATE_PASSED_BY_POLICY');
      return injected ? { passed: true, record: policyRecord, policy: true } : null;
    }
    if (!this.preauthStore) return null;
    const verified = this.#verifyPreauthCandidates(run, {});
    if (verified?.passed) {
      const injected = this.#injectCanonicalApproval(run, runId, verified.record, gateHash);
      if (injected) return verified;
    }
    return null;
  }

  /** 消费成功后的统一注入：规范批准话术 → executor.submitHumanResponse + 事件 + 通知。 */
  #injectCanonicalApproval(run, runId, record, gateHash, passEvent = 'GATE_PASSED_BY_PREAUTH') {
    const executor = this.executors.get(runId);
    if (!executor) return false;
    const gate = run.manifest.stageGates?.[String(run.s.currentStage).toUpperCase()];
    const phrase = approvalForGateKind(gate?.kind === 'REVEAL' ? 'NEXT_REVEAL_ONLY' : 'SEAL_ANNOTATION_ONLY');
    const canonical = (gate?.kind === 'REVEAL' ? buildRevealApprovalText : buildSealApprovalText)(gateHash);
    if (!canonical || !phrase) return false;
    const result = executor.submitHumanResponse(runId, canonical);
    if (!result.submitted) return false;
    this.#appendRunEvent(run, passEvent, { preauthId: record.preauthId, binding: record.binding, stage: run.s.currentStage, receiptHash: gateHash });
    this.#notify(run, passEvent, { message: `阶段 ${run.s.currentStage} 人闸已由${record.binding === 'POLICY_AUTO' ? '无人值守策略' : `预授权 ${record.preauthId}`} 放行，继续执行。` });
    return true;
  }

  /**
   * P-B §3 门位候选核验（I2/I5/I6/ordinal；只读候选 + 单事务消费）。
   * @param {object} run 等待中的 run
   * @param {{bindingFilter?:string, gateKindFilter?:string}} opt 话术驱动路径带
   *        过滤（话术声明的绑定型/门型必须与记录一致）；自动路径传 {}。
   * @returns {{passed:true, record}|{mismatch:true, detail}|null}
   *  null = 该门无可用候选（自动路径静默走 NEED_USER）。
   */
  #verifyPreauthCandidates(run, opt = {}) {
    if (!this.preauthStore) return null;
    const stage = String(run.s.currentStage).toUpperCase();
    const gateDecl = run.manifest.stageGates?.[stage];
    if (!gateDecl) return opt.bindingFilter ? { mismatch: true, detail: `阶段 ${stage} 未声明人闸` } : null;
    if (opt.bindingFilter && !gateDecl.bindings?.includes(opt.bindingFilter)) {
      return { mismatch: true, detail: `阶段 ${stage} 不接受 ${opt.bindingFilter} 预授权（声明：${(gateDecl.bindings ?? []).join('|')}）` };
    }
    const rootRunId = run.manifest.rootRunId ?? run.runId;
    // 自动路径按门声明的 kind 推 gateKind；话术路径用话术声明的 gateKind。
    const gateKind = opt.gateKindFilter ?? (gateDecl.kind === 'REVEAL' ? 'NEXT_REVEAL_ONLY' : 'SEAL_ANNOTATION_ONLY');
    const candidates = this.preauthStore.findEligible({ stage, gateKind, rootRunId });
    if (candidates.length === 0) {
      return opt.bindingFilter ? { mismatch: true, detail: `无可用 ${gateKind}/${stage}@${rootRunId} 预授权记录` } : null;
    }
    const chainEvents = this.#chainEvents(run);
    // ordinal = 本链在该阶段已布防的人闸次数（markWaitingForHuman 同步落
    // NEED_USER 事件，当前等待已计入 —— 首门 ordinal=1）。
    const waitOrdinal = chainEvents.filter((e) => (e.event === 'NEED_USER' || e.event === 'WAITING_FOR_HUMAN') && String(e.stage).toUpperCase() === stage).length;
    for (const rec of candidates) {
      if (opt.bindingFilter && rec.binding !== opt.bindingFilter) continue; // 话术声明的绑定型与记录必须一致
      if (rec.binding === 'EXACT') {
        // I2：精确 hash 比对（逐字符，小写归一）。
        if (String(rec.receiptHash).toLowerCase() === String(run.s.waitingApprovalHash).toLowerCase()) {
          return this.#consumePreauth(rec, run, stage, waitOrdinal);
        }
        continue;
      }
      // CONSTRAINT：I5 上游链 + I6 blob 溯源 + ordinal 上限。
      const c = rec.constraints ?? {};
      if (Number.isFinite(c.maxOrdinal) && waitOrdinal > c.maxOrdinal) continue;
      const upstream = c.upstream?.[0];
      if (!upstream) continue;
      const upstreamPassed = chainEvents.some((e) => e.event === 'GATE_PASSED'
        && String(e.stage).toUpperCase() === String(upstream.stage).toUpperCase()
        && String(e.approvalHash ?? '').toLowerCase() === String(upstream.receiptHash).toLowerCase());
      if (!upstreamPassed) continue;
      const src = c.receiptSource;
      if (!src?.path || !src?.commit) continue;
      // I6：从 git object db 取 (commit, path) blob 字节，sha256 与门位 hash 比对。
      const blobHash = this.#blobSha256(run.manifest.cwd, src.commit, src.path);
      if (blobHash && blobHash === String(run.s.waitingApprovalHash).toLowerCase()) {
        return this.#consumePreauth(rec, run, stage, waitOrdinal);
      }
    }
    return { mismatch: true, detail: `${candidates.length} 条候选均未通过 I2/I5/I6/ordinal 核验` };
  }

  #consumePreauth(rec, run, stage, ordinal) {
    try {
      this.preauthStore.markConsumed(rec.preauthId, {
        runId: run.runId, stage, ordinal, receiptHash: run.s.waitingApprovalHash,
      });
      return { passed: true, record: this.preauthStore.get(rec.preauthId) ?? rec };
    } catch (e) {
      // PreauthAlreadyConsumed / 已撤销已过期 → fail-closed 当作失配。
      return { mismatch: true, detail: `消费失败：${e.code ?? e.message}` };
    }
  }

  /** 运行链（本 run → parentRunId → … → root）事件证据（loadRun 只读；缺失容忍）。 */
  #chainEvents(run) {
    const out = [];
    const seen = new Set();
    let cursor = run.runId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const st = this.controller.store.loadRun(cursor);
      if (st?.events) out.push(...(st.events ?? []));
      const parent = st?.manifest?.parentRunId;
      if (!parent || seen.has(parent)) break;
      cursor = parent;
    }
    return out;
  }

  #blobSha256(cwd, commit, path) {
    try {
      const stdout = execFileSync('git', ['-c', 'core.autocrlf=false', 'show', `${commit}:${path}`], { cwd, maxBuffer: 16 * 1024 * 1024 });
      return createHash('sha256').update(stdout).digest('hex');
    } catch { return null; }
  }

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
    // P-E：修复 agent session 的事件先于执行端分发（修复 session 不属任何
    // executor，落入下方循环只会被全部 ignore）。
    for (const [runId, rp] of this.repairs) {
      if (rp.agent?.id === session?.id) return this.#onRepairEvent(runId, rp, event);
    }
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
        // P-B §3 步骤 1-5：WAIT 布防即自动尝试预授权放行（无人值守触发点 ——
        // 不等用户发话术）。放行成功不落 NEED_USER 通知（门已过）；无候选或
        // 失配按 §3 步骤 5 走现状 NEED_USER 路径（R1 卡）。
        let autoGate = null;
        if (current && r?.waitingForHuman) autoGate = await this.#autoPreauthPass(current, runId);
        if (autoGate?.policy) r = { ...r, autoPolicyPassed: true };
        if (current && (r?.turnEnded || r?.ready || r?.advanced || r?.retry || r?.paused || r?.waitingForHuman || r?.waitingQuota)) {
          const cur2 = this.liveRuns.get(runId);
          const stillWaiting = cur2?.s?.waitingForHuman === true;
          const evName = r?.waitingQuota ? 'DSH_QUOTA_WAIT' : (r?.ready ? 'READY_FOR_AUDIT' : (r?.waitingForHuman ? 'WAITING_FOR_HUMAN' : (r?.paused ? 'PAUSED' : 'EXECUTOR_EVENT')));
          if (evName === 'WAITING_FOR_HUMAN' && !stillWaiting) {
            // 门在自动预授权中已放行：结果行改记 GATE_PASSED_BY_PREAUTH，避免误报等待。
            this.#notify(cur2, 'GATE_PASSED_BY_PREAUTH', { result: r, message: `阶段 ${cur2.s.currentStage} 人闸由预授权自动放行（无人值守）。` });
          } else {
            this.#notify(current, evName, {
              result: r,
              ...(evName === 'WAITING_FOR_HUMAN' ? this.#humanWaitDetail(current) : {}), // R1 F1
            });
          }
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
      // P-E：重启前未解决的事故先闸住（resume 尾部的自动审核不得抢在修复
      // 之前跑），resume 成功后再重派修复 agent。
      const persistedIncident = this.controller.store.readIncident(item.runId);
      const hadOpenIncident = persistedIncident?.status === 'open';
      if (hadOpenIncident && !this.incidents.has(item.runId)) {
        this.incidents.set(item.runId, { ...persistedIncident });
        try { this.retryScheduler.cancel(item.runId); } catch { /* 无排程可取消 */ }
      }
      try { restored.push(await this.resume(item.runId)); }
      catch (error) { errors.push({ runId: item.runId, code: error.code ?? 'AUDIT_RESTORE_FAILED', message: error.message }); this.onError?.(error, item.runId); }
      if (!hadOpenIncident) continue;
      const run = this.liveRuns.get(item.runId);
      if (!run || run.isTerminal) { this.incidents.delete(item.runId); continue; }
      try {
        const report = await this.#incidentContext(run, 'RESTORE_OPEN_INCIDENT', { previousIncidentId: persistedIncident.incidentId, previousTrigger: persistedIncident.trigger });
        report.incidentId = persistedIncident.incidentId; // 事故身份跨重启保持连续
        report.bridge = { pid: process.pid, bridgeRoot: this.repairCwd ?? process.cwd(), logFile: this.logFileHint ?? null };
        this.incidents.set(item.runId, { ...persistedIncident, report });
        this.#notify(run, 'AUDIT_INCIDENT_RAISED', {
          trigger: persistedIncident.trigger,
          incidentId: persistedIncident.incidentId,
          reason: `桥重启时发现未解决事故（${persistedIncident.trigger}），继续修复流程。`,
          nextStep: '修复 agent 将重新派出；完成后自动续跑，无需人工介入。',
        });
        this.#dispatchRepair(item.runId, (persistedIncident.repairAttempt ?? 0) + 1, null)
          .catch((e) => this.#incidentDispatchFailed(run, e));
      } catch (error) {
        this.#incidentDispatchFailed(run, error);
      }
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
    const run = AuditRun.open(this.controller.store, { now: this.controller.now })(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
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
    if (reviseRecovery) {
      executor.startStage(runId);
    } else if (resumedFromPause
      && run.s.state === 'EXECUTING'
      && agent.status === 'idle'
      && !run.s.pendingRemoteSync
      && !run.s.waitingForHuman) {
      // R1 止血 F5（D4 同款）：暂停被取消的 turn 不会再来事件 —— 恢复后若
      // 执行端 idle 静坐，必须补发当前阶段 prompt，否则没人再驱动该 run。
      // 范围仅限 PAUSED→resume 路径：EXECUTING 的重启重挂必须保持「不重复
      // 发送 stage prompt」的既有冻结语义（lifecycle-e2e）。
      executor.startStage?.(runId);
    }
    if (run.s.pendingRemoteSync) {
      this.#scheduleRetry(runId, run.s.retry.pushAttempts);
    }
    // Crash/restart-safe unattended gate: a persisted WAIT must not depend on
    // a future assistant event to trigger the automatic policy pass.
    if (this.approvalPolicy === 'AUTO' && run.s.waitingForHuman) {
      await this.#autoPreauthPass(run, runId);
    }
    if (run.s.state === 'AUDITING') await this.#maybeAutoReviewLocked(runId);
    return { run, agent, executor };
    });
  }
}
