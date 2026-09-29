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
import { buildSealApprovalText, buildRevealApprovalText, approvalForGateKind } from './protocol.js';
import { loadTaskPacket } from './task-packet.js';
import { AuditRetryScheduler } from './retry-scheduler.js';
import { parsePreauthText } from './preauth-protocol.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export class AuditLifecycle {
  constructor({ controller, driver, bindings, onProgress = null, watchdogMs = 5 * 60_000, gitGateFactory = (opts) => new GitRemoteGate(opts), executorFactory = (opts) => new AuditExecutor(opts), taskPacketLoader = loadTaskPacket, retryScheduler = null, onError = null, reviewTimeoutMs = 20 * 60_000, gitTimeoutMs = 120_000, preauthStore = null } = {}) {
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
    const key = this.#reviewRoundKey(run);
    if (key && this.reviewRounds.get(runId) === key) return { deduped: true };
    if (key) this.reviewRounds.set(runId, key);
    // Infrastructure failure keeps the round key latched: duplicate triggers stay deduped
    // and only an explicit review()/resume can retry this round (fail-closed).
    const result = await this.#reviewLocked(runId, this.reviewer);
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
    const gateEvents = this.#chainEvents(run).filter((e) => ['GATE_PASSED', 'GATE_PASSED_BY_PREAUTH', 'GATE_PREAUTH_MISMATCH'].includes(e.event)
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
          // R1 止血 F4：review 挂起会把该 run 的 stop/pause/resume/onEvent 全部
          // 排到同一 #serial 队列后永不完成。硬超时按 infra 失败处理：
          // reviewRounds latch 保留（重复触发保持 dedupe，不重置、不自动重发），
          // 只有显式 review()/resume 可重试本轮；通知聊天给出下一步动作。
          this.#notify(run, 'REVIEW_TIMEOUT', {
            stage, iteration: packet.iteration, timeoutMs: this.reviewTimeoutMs,
            nextStep: '审核超时已按基础设施失败处理（本轮已保留）：`/audit resume` 重发审核，或 `/audit stop` 退出。',
          });
          return { timedOut: true };
        }
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

  /**
   * R1 止血 F4：reviewer.review 硬超时包装。超时 = infra 失败（不消耗
   * verdict 重试、不动 reviewRounds latch、不自动重发）。底层 promise 无法
   * 取消：race 已订阅，其最终 settle 的结果被丢弃（本轮已按超时收敛）。
   */
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
    if (!this.preauthStore || !run.s.waitingForHuman) return null;
    const gateHash = run.s.waitingApprovalHash;
    const verified = this.#verifyPreauthCandidates(run, {});
    if (verified?.passed) {
      const injected = this.#injectCanonicalApproval(run, runId, verified.record, gateHash);
      if (injected) return verified;
    }
    return null;
  }

  /** 消费成功后的统一注入：规范批准话术 → executor.submitHumanResponse + 事件 + 通知。 */
  #injectCanonicalApproval(run, runId, record, gateHash) {
    const executor = this.executors.get(runId);
    if (!executor) return false;
    const gate = run.manifest.stageGates?.[String(run.s.currentStage).toUpperCase()];
    const phrase = approvalForGateKind(gate?.kind === 'REVEAL' ? 'NEXT_REVEAL_ONLY' : 'SEAL_ANNOTATION_ONLY');
    const canonical = (gate?.kind === 'REVEAL' ? buildRevealApprovalText : buildSealApprovalText)(gateHash);
    if (!canonical || !phrase) return false;
    const result = executor.submitHumanResponse(runId, canonical);
    if (!result.submitted) return false;
    this.#appendRunEvent(run, 'GATE_PASSED_BY_PREAUTH', { preauthId: record.preauthId, binding: record.binding, stage: run.s.currentStage, receiptHash: gateHash });
    this.#notify(run, 'GATE_PASSED_BY_PREAUTH', { message: `阶段 ${run.s.currentStage} 人闸已由预授权 ${record.preauthId}（${record.binding}）放行，继续无人值守。` });
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
        // P-B §3 步骤 1-5：WAIT 布防即自动尝试预授权放行（无人值守触发点 ——
        // 不等用户发话术）。放行成功不落 NEED_USER 通知（门已过）；无候选或
        // 失配按 §3 步骤 5 走现状 NEED_USER 路径（R1 卡）。
        if (current && r?.waitingForHuman) await this.#autoPreauthPass(current, runId);
        if (current && (r?.turnEnded || r?.ready || r?.advanced || r?.retry || r?.paused || r?.waitingForHuman)) {
          const cur2 = this.liveRuns.get(runId);
          const stillWaiting = cur2?.s?.waitingForHuman === true;
          const evName = r?.ready ? 'READY_FOR_AUDIT' : (r?.waitingForHuman ? 'WAITING_FOR_HUMAN' : (r?.paused ? 'PAUSED' : 'EXECUTOR_EVENT'));
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
    // R1 止血 F5：/audit pause 后的 PAUSED 也是 resume 的合法目标 —— 此前只
    // 处理 PAUSED_NEEDS_USER，PAUSED 恢复落空、run 永远停摆。只在 human=true
    // （显式 /audit resume）时转移：restoreActive（human=false）不得把用户
    // 亲手暂停的 run 在桥重启后自动放行。
    const resumedFromPause = human && run.s.state === 'PAUSED';
    if (human && run.s.state === 'PAUSED_NEEDS_USER') {
      if (run.s.cause === 'MARKER_PARSE_FAILED') run.markHumanResumeCycle();
      if (run.s.cause === 'HISTORY_REWRITTEN') {
        throw Object.assign(new Error('history was rewritten: explicit new baseline required'), { code: 'AUDIT_BASELINE_REQUIRED' });
      }
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
    if (run.s.state === 'AUDITING') await this.#maybeAutoReviewLocked(runId);
    return { run, agent, executor };
    });
  }
}
