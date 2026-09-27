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
  constructor({ controller, driver, bindings, gitGateFactory = (opts) => new GitRemoteGate(opts), executorFactory = (opts) => new AuditExecutor(opts), taskPacketLoader = loadTaskPacket, retryScheduler = null, onError = null } = {}) {
    this.controller = controller;
    this.driver = driver;
    this.onError = onError;
    this.bindings = bindings;
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
    if (!binding?.sessionId || !binding?.cwd) {
      throw Object.assign(new Error('当前聊天必须已有绑定的 DSH session 和 workspace；A3 不会偷偷创建新 session'), { code: 'AUDIT_SESSION_REQUIRED' });
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
      throw Object.assign(new Error('绑定的 DSH session 当前正在运行；A3 不会并发或偷偷 fork'), { code: 'AUDIT_SESSION_OCCUPIED' });
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
      runId, hostId: this.controller.hostId, chatId, dshSessionId: agent.id,
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
    return { run, executor, agent, git };
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
    const results = [];
    for (const [runId, executor] of this.executors) {
      const prior = this.eventQueues.get(runId) ?? Promise.resolve();
      const task = prior.then(async () => {
        const r = await executor.onEvent(session, event);
        // 只有 Executor 确认是本 audit 自己的有效 turn/end 才触发自动审核；
        // 非绑定 session 的事件返回 {ignored:true}，不得误触 reviewer。
        if (r?.turnEnded === true) await this.#maybeAutoReviewLocked(runId);
        return r;
      });
      this.eventQueues.set(runId, task.catch(() => undefined));
      results.push(await task);
    }
    return results;
  }

  async restoreActive() {
    const restored = [];
    for (const item of this.controller.store.listRuns()) {
      const loaded = this.controller.store.loadRun(item.runId);
      if (!loaded || ['STOPPED', 'STOPPED_TARGET_REACHED', 'ERROR'].includes(loaded.state.state)) continue;
      restored.push(await this.resume(item.runId));
    }
    return restored;
  }

  async resume(runId) {
    const run = AuditRun.open(this.controller.store, { now: this.controller.now })(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
    const binding = this.bindings?.get(run.manifest.chatId);
    if (!binding || binding.sessionId !== run.manifest.dshSessionId) {
      throw Object.assign(new Error('persisted dshSessionId does not match the owner chat binding'), { code: 'AUDIT_SESSION_BINDING_MISMATCH' });
    }
    const agent = await this.driver.ensure({ ...binding }, { allowCreate: false });
    const gate = this.gitGateFactory({ cwd: run.manifest.cwd });
    const executor = this.executorFactory({ driver: this.driver, gitGate: gate });
    this.executors.set(runId, executor);
    this.liveRuns.set(runId, run);
    await executor.start({ run, agent, gitGate: gate, sendPrompt: false });
    if (run.s.state === 'WAIT_GIT_PUSH' && run.s.pendingRemoteSync) {
      this.#scheduleRetry(runId, run.s.retry.pushAttempts);
    }
    if (run.s.state === 'AUDITING') await this.#maybeAutoReviewLocked(runId);
    return { run, agent, executor };
  }
}
