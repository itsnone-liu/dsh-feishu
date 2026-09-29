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

export class AuditLifecycle {
  constructor({ controller, driver, bindings, onProgress = null, watchdogMs = 5 * 60_000, gitGateFactory = (opts) => new GitRemoteGate(opts), executorFactory = (opts) => new AuditExecutor(opts), taskPacketLoader = loadTaskPacket, retryScheduler = null, onError = null } = {}) {
    this.controller = controller;
    this.driver = driver;
    this.onError = onError;
    this.bindings = bindings;
    this.onProgress = onProgress;
    this.watchdogMs = watchdogMs;
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
    this.watchdogInterval = setInterval(() => this.#watchdog(), 60_000);
    this.watchdogInterval.unref?.();
  }

  #notify(run, event, detail = {}) {
    this.activity.set(run.runId, { at: Date.now(), warned: event === 'WATCHDOG_TIMEOUT' });
    try { this.onProgress?.({ runId: run.runId, chatId: run.manifest.chatId, stage: run.s.currentStage, state: run.s.state, event, ...detail }); } catch {}
  }

  #watchdog() {
    const now = Date.now();
    for (const run of this.liveRuns.values()) {
      if (run.isTerminal || run.s.waitingForHuman || !['EXECUTING', 'AUDITING'].includes(run.s.state)) continue;
      const a = this.activity.get(run.runId) ?? { at: run.s.updatedAt ?? now, warned: false };
      const last = run.s.lastExecutorEventAt ?? a.at;
      if (!a.warned && now - last >= this.watchdogMs) {
        this.#notify(run, 'WATCHDOG_TIMEOUT', { idleMs: now - a.at, message: '审计执行器超过 5 分钟无进展事件' });
      }
    }
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

    const gate = this.gitGateFactory({ cwd: binding.cwd });
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
    const gate = this.gitGateFactory({ cwd: binding.cwd });
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

  #maybeAutoReviewLocked(runId) {
    const run = this.liveRuns.get(runId);
    const executor = this.executors.get(runId);
    if (!run || !executor || run.s.state !== 'AUDITING' || !run.s.auditInFlight) return { skipped: true };
    if (!this.reviewer) return { skipped: true };
    const key = this.#reviewRoundKey(run);
    if (key && this.reviewRounds.get(runId) === key) return { deduped: true };
    if (key) this.reviewRounds.set(runId, key);
    // Infrastructure failure keeps the round key latched: duplicate triggers stay deduped
    // and only an explicit review()/resume can retry this round (fail-closed).
    return this.#reviewLocked(runId, this.reviewer);
  }

  async #reviewLocked(runId, reviewer) {
    const executor = this.executors.get(runId);
    const run = this.liveRuns.get(runId);
    if (!executor || !run) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    const inFlight = run.s.auditInFlight;
    if (run.s.state !== 'AUDITING' || !inFlight) throw Object.assign(new Error('audit packet unavailable outside AUDITING'), { code: 'AUDIT_REVIEW_NOT_READY' });
    const stage = inFlight.stage ?? run.s.currentStage;
    const packet = { runId, hostId: run.manifest.hostId, stage, iteration: inFlight.iteration ?? run.s.iteration, repo: run.manifest.repo, branch: run.manifest.branch, targetCommit: inFlight.headCommit, baseCommit: run.s.stageBaseCommit, goal: run.manifest.goal, stageRequirement: run.manifest.stageRequirements?.[stage] ?? null };
    for (;;) {
      let verdict;
      try { verdict = await reviewer.review(packet); }
      catch (e) {
        if (e?.code === 'AUDIT_VERDICT_MALFORMED' || e?.code === 'AUDIT_VERDICT_MISSING') {
          const missing = run.verdictMissing();
          if (missing.retry) continue;
          return missing;
        }
        throw e;
      }
      return executor.applyVerdict(runId, verdict);
    }
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
        this.executors.get(runId)?.stop(runId);
        this.executors.delete(runId);
      } else if (action === 'pause') {
        this.retryScheduler.cancel(runId);
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
    const gate = this.gitGateFactory({ cwd: old.manifest.cwd });
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
      const result = executor.submitHumanResponse(runId, text);
      return { handled: Boolean(result.submitted), runId, ...result };
    }
    return { handled: false };
  }

  async retry(runId) {
    return this.#serial(runId, async () => {
      const before = this.liveRuns.get(runId);
      const wasWaiting = before?.s.state === 'WAIT_GIT_PUSH';
      const result = await (this.executors.get(runId)?.retry(runId) ?? { ignored: true });
      const run = this.liveRuns.get(runId);
      if (run && wasWaiting && run.s.state === 'AUDITING') await this.#maybeAutoReviewLocked(runId);
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
        const r = await executor.onEvent(session, event);
        // 只有 Executor 确认是本 audit 自己的有效 turn/end 才触发自动审核；
        // 非绑定 session 的事件返回 {ignored:true}，不得误触 reviewer。
        if (r?.turnEnded === true) await this.#maybeAutoReviewLocked(runId);
        const current = this.liveRuns.get(runId);
        if (current && (r?.turnEnded || r?.ready || r?.advanced || r?.retry || r?.paused || r?.waitingForHuman)) {
          this.#notify(current, r?.ready ? 'READY_FOR_AUDIT' : (r?.waitingForHuman ? 'WAITING_FOR_HUMAN' : (r?.paused ? 'PAUSED' : 'EXECUTOR_EVENT')), { result: r });
        }
        return r;
      });
      this.eventQueues.set(runId, task.catch(() => undefined));
      tasks.push(task);
    }
    let firstError = null;
    for (const task of tasks) {
      try {
        results.push(await task);
      } catch (e) {
        if (!firstError) firstError = e;
        results.push({ ignored: true, error: String(e?.message ?? e) });
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
      try { restored.push(await this.resume(item.runId)); }
      catch (error) { errors.push({ runId: item.runId, code: error.code ?? 'AUDIT_RESTORE_FAILED', message: error.message }); this.onError?.(error, item.runId); }
    }
    return { restored, errors };
  }

  async resume(runId, { human = false, bumpReviewIterations = null } = {}) {
    return this.#serial(runId, async () => {
    const run = AuditRun.open(this.controller.store, { now: this.controller.now })(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
    const binding = this.bindings?.get(run.manifest.chatId);
    if (!binding || (run.manifest.observerSessionId && binding.sessionId !== run.manifest.observerSessionId)) {
      throw Object.assign(new Error('persisted observerSessionId does not match the owner chat binding'), { code: 'AUDIT_SESSION_BINDING_MISMATCH' });
    }
    const agent = this.driver.ensureAuditSession
      ? await this.driver.ensureAuditSession({ cwd: run.manifest.cwd, sessionId: run.manifest.dshSessionId, allowCreate: false })
      : await this.driver.ensure({ sessionId: run.manifest.dshSessionId, cwd: run.manifest.cwd }, { allowCreate: false });
    // MARKER_PARSE_FAILED is a recoverable executor-turn loss.  Human resume
    // changes the durable state back to EXECUTING, but the failed turn's
    // prompt is gone; reattaching with sendPrompt:false alone leaves the run
    // permanently idle (the exact failure seen after repeated resume).  Latch
    // this before resumeFromHuman clears/changes the paused state, then replay
    // the same stage prompt once after the executor is attached.
    const replayMarkerPrompt = human
      && run.s.state === 'PAUSED_NEEDS_USER'
      && run.s.cause === 'MARKER_PARSE_FAILED';
    if (human && run.s.state === 'PAUSED_NEEDS_USER') {
      if (run.s.cause === 'MARKER_PARSE_FAILED') run.markHumanResumeCycle();
      if (run.s.cause === 'HISTORY_REWRITTEN') {
        throw Object.assign(new Error('history was rewritten: explicit new baseline required'), { code: 'AUDIT_BASELINE_REQUIRED' });
      }
      run.resumeFromHuman({ bumpReviewIterations });
    }
    const gate = this.gitGateFactory({ cwd: run.manifest.cwd });
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
    }
    if (run.s.pendingRemoteSync) {
      this.#scheduleRetry(runId, run.s.retry.pushAttempts);
    }
    if (run.s.state === 'AUDITING') await this.#maybeAutoReviewLocked(runId);
    return { run, agent, executor };
    });
  }
}
