/**
 * audit/state-machine.js — Audit 状态机（§8 / v0.2 补丁 / v0.3 push gate）。
 *
 * 纯转移规则（TRANSITIONS）+ AuditRun 持久化包装。冻结语义内嵌于动作方法：
 *  - 只有 AUDIT APPROVE(currentStage) 才推进阶段；READY_FOR_AUDIT / DSH 自述都不是 PASS（§16/G6）；
 *  - stopAfter：APPROVE 且 current==stopAfter → STOPPED_TARGET_REACHED（G7）；
 *  - REVISE 计数持久化，达 maxReviewIterations → REVISE_LOOP_EXHAUSTED → PAUSED_NEEDS_USER，
 *    禁止自动归零后继续（v0.2 §8）；
 *  - 已审 commit 被 amend/rebase → HISTORY_REWRITTEN → PAUSED_NEEDS_USER，禁止自动重建 baseline（G11）；
 *  - 正式审计前必须过 REMOTE_SYNC_GATE：push + ls-remote(tip==head) → AUDIT_REMOTE_READY（G12/§29）；
 *  - 身份四元组任一不匹配 → fail closed（G3）；
 *  - 重复输入幂等（G9）：同一 verdict 重复投递不二次推进、不 iteration+2。
 */
import {
  IllegalTransitionError, FrozenStateException, AuditError,
} from './errors.js';
import { validateIdentity } from './protocol.js';
import { createManifest, changeStopAfter } from './manifest.js';
export const STATES = Object.freeze([
  'IDLE', 'EXECUTING', 'AUDITING', 'NEXT_STAGE',
  'WAIT_DSH_QUOTA', 'WAIT_WEB_QUOTA', 'WAIT_GIT_PUSH',
  'PAUSED', 'PAUSED_NEEDS_USER',
  'REVISE_LOOP_EXHAUSTED', 'HISTORY_REWRITTEN',
  'ERROR', 'STOPPED', 'STOPPED_TARGET_REACHED',
]);

/** 显式转移表：from → 允许的 to 集合。任何表外转移 = IllegalTransitionError。
 *  STOPPED：/audit stop 可从任意活跃（非 IDLE、非终态）状态进入。 */
export const TRANSITIONS = Object.freeze({
  IDLE: ['EXECUTING'],
  EXECUTING: ['AUDITING', 'WAIT_GIT_PUSH', 'WAIT_DSH_QUOTA', 'PAUSED', 'PAUSED_NEEDS_USER', 'HISTORY_REWRITTEN', 'STOPPED', 'ERROR'],
  WAIT_GIT_PUSH: ['AUDITING', 'PAUSED_NEEDS_USER', 'STOPPED', 'ERROR'],           // v0.3：retry 成功→AUDITING；fatal→人工
  WAIT_DSH_QUOTA: ['EXECUTING', 'PAUSED', 'PAUSED_NEEDS_USER', 'STOPPED', 'ERROR'],
  WAIT_WEB_QUOTA: ['AUDITING', 'PAUSED', 'PAUSED_NEEDS_USER', 'STOPPED', 'ERROR'], // 恢复重发同一 stage/iteration
  AUDITING: ['EXECUTING', 'NEXT_STAGE', 'STOPPED_TARGET_REACHED', 'REVISE_LOOP_EXHAUSTED', 'WAIT_WEB_QUOTA', 'PAUSED', 'PAUSED_NEEDS_USER', 'HISTORY_REWRITTEN', 'STOPPED', 'ERROR'],
  NEXT_STAGE: ['EXECUTING'],                                            // 瞬态
  PAUSED: ['EXECUTING', 'AUDITING', 'WAIT_DSH_QUOTA', 'WAIT_WEB_QUOTA', 'WAIT_GIT_PUSH', 'STOPPED', 'ERROR'],        // resume 精确回 pausedFrom
  PAUSED_NEEDS_USER: ['EXECUTING', 'AUDITING', 'WAIT_DSH_QUOTA', 'WAIT_WEB_QUOTA', 'WAIT_GIT_PUSH', 'STOPPED', 'ERROR'], // 人工处理后 resume（HISTORY_REWRITTEN 需显式 newBaseline）
  REVISE_LOOP_EXHAUSTED: ['PAUSED_NEEDS_USER'],                         // 终因状态：唯一出边，不得继续推进
  HISTORY_REWRITTEN: ['PAUSED_NEEDS_USER'],                             // 同上
  ERROR: [],
  STOPPED: [],
  STOPPED_TARGET_REACHED: [],
});

export const TERMINAL_STATES = Object.freeze(['ERROR', 'STOPPED', 'STOPPED_TARGET_REACHED']);
export const HUMAN_GATE_STATES = Object.freeze(['REVISE_LOOP_EXHAUSTED', 'HISTORY_REWRITTEN']);

export const EVENTS = Object.freeze([
  'RUN_STARTED', 'STAGE_STARTED', 'READY_FOR_AUDIT',
  'GIT_PUSH_WAIT', 'GIT_PUSH_RETRY', 'AUDIT_REMOTE_READY', 'ERROR_GIT_REMOTE',
  'AUDIT_STARTED', 'AUDIT_REVISE', 'AUDIT_APPROVE', 'REVISE_LOOP_EXHAUSTED',
  'MARKER_RETRY', 'MARKER_PARSE_FAILED', 'VERDICT_RETRY', 'VERDICT_PARSE_FAILED', 'IDENTITY_MISMATCH',
  'DSH_QUOTA_WAIT', 'DSH_QUOTA_RECOVER', 'WEB_QUOTA_WAIT', 'WEB_QUOTA_RECOVER',
  'NEED_USER', 'HISTORY_REWRITTEN', 'HUMAN_RESUME', 'PAUSED_BY_USER', 'RESUMED_BY_USER',
  'RECOVERED_REVISE_EXECUTING',
  'STAGE_ADVANCED', 'TARGET_REACHED', 'RUN_STOPPED', 'STOP_TARGET_CHANGED',
  'AUDIT_SESSION_REBOUND',
]);

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** 重复投递判定：四元组一致即视为同一 verdict（headCommit 来自 inFlight，重复投递天然同轮）。 */
const sameVerdict = (a, b) => a && b
  && a.state === b.state && a.runId === b.runId
  && a.stage === b.stage && a.iteration === b.iteration;

/**
 * AuditRun — 绑定 store 的 run 句柄；所有动作 = 校验 + 转移 + 事件 + 落盘，原子顺序：
 * 先 appendEvent（幂等），再 saveState。任何 throw 都不产生部分副作用（除事件日志本身）。
 */
export class AuditRun {
  /** 创建新 run（IDLE→EXECUTING，RUN_STARTED + STAGE_STARTED）。 */
  static create(store, manifestInput, { maxReviewIterations = 8, now = Date.now } = {}) {
    const manifest = createManifest(manifestInput, now);
    const t = now();
    const state = {
      schemaVersion: 1,
      runId: manifest.runId,
      state: 'EXECUTING',
      currentStage: manifest.currentStage,
      stopAfter: manifest.stopAfter,
      iteration: 1,
      revisionCount: 0,          // 本 stage 已收到 REVISE 的审核轮数（持久化，禁自动归零）
      headCommit: manifest.startingCommit,
      stageBaseCommit: manifest.stageBaseCommit,
      pausedFrom: null,
      cause: null,               // PAUSED_* / EXHAUSTED 的原因
      markerRetries: 0,
      verdictRetries: 0,
      retry: { pushAttempts: 0, pushMax: 4 },
      pendingRemoteSync: null,   // {stage, iteration, head} — executor ready 后、gate 通过前
      auditInFlight: null,       // {stage, iteration, headCommit} — AUDITING 的幂等键
      lastVerdict: null,
      runOptions: { maxReviewIterations },
      startedAt: t,
      updatedAt: t,
      stoppedAt: null,
    };
    const run = new AuditRun(store, manifest, state, { now });
    store.createRun(manifest, state);
    run.#emit('RUN_STARTED');
    run.#emit('STAGE_STARTED');
    return run;
  }

  /**
   * 从 store 恢复（§22 / G8，A1.1 P0-2）：加载后自动收敛持久化中间态，
   * 恢复逻辑内置于内核 —— A2 Controller 无需感知瞬态。
   * 参数接受 runId 字符串或 {runId}。
   */
  static open(store, { now = Date.now } = {}) {
    return (runIdOrObj) => {
      const runId = typeof runIdOrObj === 'string' ? runIdOrObj : runIdOrObj?.runId;
      const loaded = store.loadRun(runId);
      if (!loaded) return null;
      const run = new AuditRun(store, loaded.manifest, loaded.state, { now });
      run.recoverTransientState();
      return run;
    };
  }

  constructor(store, manifest, state, { now = Date.now } = {}) {
    this.store = store;
    this.manifest = manifest;
    this.s = state;   // 运行态（直接持有并修改，saveState 落盘）
    this.now = now;
  }

  get runId() { return this.s.runId; }
  get state() { return this.s.state; }
  get isTerminal() { return TERMINAL_STATES.includes(this.s.state); }

  /**
   * 持久化中间态确定性收敛（A1.1 P0-2 / A1.2）。覆盖：
   *  - stopAfter 双文件 crash 窗口（A1.2-1）：until() 先写 manifest 后写 state，
   *    崩溃夹缝中两者可能分歧 —— manifest 是 stopAfter 的权威源，此处确定性
   *    state ← manifest 并落盘（否则 T1 APPROVE 可能按陈旧 state.stopAfter 误进 T2）；
   *  - NEXT_STAGE 已落盘、阶段推进未完成 → 补完推进（幂等：STAGE_ADVANCED 已发则被 dedupe 吞）；
   *  - REVISE_LOOP_EXHAUSTED / HISTORY_REWRITTEN 已落盘、PAUSED_NEEDS_USER 未转 → 补转。
   * 稳态调用为 no-op。不得把瞬态恢复留给上层猜测。
   */
  recoverTransientState() {
    if (this.s.stopAfter !== this.manifest.stopAfter) {
      this.s.stopAfter = this.manifest.stopAfter;
      this.#touch();
      this.store.saveState(this.s);
    }
    const st = this.s.state;
    if (st === 'NEXT_STAGE') {
      this.#completeStageAdvance();
      return { recovered: 'EXECUTING' };
    }
    if (st === 'REVISE_LOOP_EXHAUSTED') {
      this.#emit('REVISE_LOOP_EXHAUSTED');
      this.#transition('PAUSED_NEEDS_USER', { cause: 'REVISE_LOOP_EXHAUSTED', pausedFrom: 'EXECUTING' });
      return { recovered: 'PAUSED_NEEDS_USER' };
    }
    if (st === 'HISTORY_REWRITTEN') {
      this.#emit('HISTORY_REWRITTEN');
      this.#transition('PAUSED_NEEDS_USER', { cause: 'HISTORY_REWRITTEN', pausedFrom: 'EXECUTING' });
      return { recovered: 'PAUSED_NEEDS_USER' };
    }
    // A5.5 recovery guard: a duplicate /audit resume raced with the synchronous
    // REVISE feedback path and persisted AUDITING without an auditInFlight.
    // REVISE is authoritative here: the next iteration must be executor-owned.
    if (st === 'AUDITING'
      && this.s.auditInFlight == null
      && this.s.lastVerdict?.state === 'REVISE'
      && Number.isInteger(this.s.iteration)
      && Number.isInteger(this.s.lastVerdict.iteration)
      && this.s.iteration > this.s.lastVerdict.iteration) {
      this.#emit('RECOVERED_REVISE_EXECUTING');
      this.#transition('EXECUTING');
      return { recovered: 'EXECUTING' };
    }
    return { recovered: null };
  }

  #touch() { this.s.updatedAt = this.now(); }

  #assertNotTerminal() {
    if (this.isTerminal) throw new FrozenStateException(this.runId, this.s.state);
  }

  /**
   * 转移 + 落盘。事件由调用方在转移前后自行 emit（顺序敏感的场景各自控制）。
   * pausedFrom：进入 PAUSED 系 / WAIT 系状态前记录返回路径。
   */
  #transition(to, { cause = null, pausedFrom = null } = {}) {
    assertTransition(this.s.state, to);
    if (pausedFrom) this.s.pausedFrom = pausedFrom;
    this.s.state = to;
    if (cause) this.s.cause = cause;
    this.#touch();
    this.store.saveState(this.s);
    return this.s;
  }

  /** 事件落盘（G9 幂等）。repeatSeq 用于合法多次发生的同类事件（重试类）。 */
  #emit(event, { tokens = null, repeatSeq = null, ...extra } = {}) {
    const stage = extra.stage ?? this.s.currentStage;
    const iteration = extra.iteration ?? this.s.iteration;
    const headCommit = extra.headCommit ?? this.s.headCommit;
    let dedupeKey = `${this.runId}|${stage}|${iteration}|${headCommit}|${event}`;
    if (repeatSeq != null) dedupeKey += `#${repeatSeq}`;
    return this.store.appendEvent({
      runId: this.runId, stage, iteration, headCommit, event,
      timestamp: this.now(),
      elapsedMs: this.now() - this.s.startedAt,
      tokens,
      dedupeKey, ...extra,
    });
  }

  // ---------- Executor 侧（§9 / v0.2 marker 超时 / G11） ----------

  /**
   * DSH turn 输出无合法 marker（v0.2 §9）：
   * 第 1 次 → MARKER_RETRY（状态不变，等待重问）；第 2 次 → PAUSED_NEEDS_USER。
   * @returns {{retry: boolean}|{failed: boolean}}
   */
  markerMissing() {
    this.#assertNotTerminal();
    if (this.s.state !== 'EXECUTING') throw new IllegalTransitionError(this.s.state, 'EXECUTING(marker-retry)');
    this.s.markerRetries += 1;
    if (this.s.markerRetries === 1) {
      this.#emit('MARKER_RETRY');
      this.#touch(); this.store.saveState(this.s);
      return { retry: true };
    }
    this.#emit('MARKER_PARSE_FAILED');
    this.#transition('PAUSED_NEEDS_USER', { cause: 'MARKER_PARSE_FAILED', pausedFrom: 'EXECUTING' });
    return { failed: true };
  }

  /**
   * Executor 上报 READY_FOR_AUDIT（已解析的 marker）。
   * 身份校验 fail-closed；ancestryOk=false → HISTORY_REWRITTEN。
   * 通过后进入 pendingRemoteSync（等待 §29 gate），不直接进入 AUDITING。
   */
  executorReady(parsed, { ancestryOk = true } = {}) {
    this.#assertNotTerminal();
    if (this.s.state !== 'EXECUTING') throw new IllegalTransitionError(this.s.state, 'REMOTE_SYNC');
    validateIdentity(
      { runId: this.runId, stage: this.s.currentStage, iteration: this.s.iteration, hostId: this.manifest.hostId },
      parsed,
    );
    if (!ancestryOk) {
      this.#emit('HISTORY_REWRITTEN');
      this.#transition('HISTORY_REWRITTEN');
      this.#transition('PAUSED_NEEDS_USER', { cause: 'HISTORY_REWRITTEN', pausedFrom: 'EXECUTING' });
      return { historyRewritten: true };
    }
    // HEAD 前进到本 stage 新 commit；待 §29 gate 确认远端可见。
    // A1.2-2/4：合法 marker 被接受 = 新的 executor 协议周期 + 新的 remote-sync episode，
    // 旧周期的 markerRetries / pushAttempts 不继承（§9/§29 的上限按周期计，不按 run 累计）。
    this.s.headCommit = parsed.head;
    this.s.markerRetries = 0;
    this.s.retry.pushAttempts = 0;
    this.s.pendingRemoteSync = { stage: this.s.currentStage, iteration: this.s.iteration, head: parsed.head };
    this.#emit('READY_FOR_AUDIT');
    this.#touch(); this.store.saveState(this.s);
    return { pendingRemoteSync: true };
  }

  /**
   * REMOTE_SYNC_GATE 结果（§29.3）。EXECUTING（首次）或 WAIT_GIT_PUSH（重试）时调用。
   * @param {{ok: boolean, kind?: 'transient'|'rejected'|'tip_diverged', tipMatches?: boolean}} r
   */
  remoteSyncResult(r) {
    this.#assertNotTerminal();
    if (!this.s.pendingRemoteSync) throw new AuditError('AUDIT_PROTOCOL_PARSE', 'remoteSyncResult before executorReady');
    const sync = this.s.pendingRemoteSync;

    if (r.ok && r.tipMatches !== false) {
      // AUDIT_REMOTE_READY → 进入正式审计；commit 进入 G11 保护链（集合语义：crash 后
      // 重放同一 gate 成功不重复 append —— A1.1 P1）。
      this.#emit('AUDIT_REMOTE_READY');
      if (!this.manifest.auditedCommits.includes(sync.head)) {
        this.manifest = {
          ...this.manifest,
          auditedCommits: [...this.manifest.auditedCommits, sync.head],
          updatedAt: this.now(),
        };
        this.store.saveManifest(this.manifest);
      }
      this.s.pendingRemoteSync = null;
      this.s.auditInFlight = { stage: sync.stage, iteration: sync.iteration, headCommit: sync.head };
      this.s.retry.pushAttempts = 0; // A1.2-4：episode 成功即归零
      this.#transition('AUDITING');
      this.#emit('AUDIT_STARTED');
      return { auditing: true };
    }

    if (r.ok && r.tipMatches === false) {
      // push 成功但远端 tip ≠ head：外部动过该分支（§29.3）。
      this.#emit('ERROR_GIT_REMOTE');
      this.#transition('PAUSED_NEEDS_USER', { cause: 'ERROR_GIT_REMOTE', pausedFrom: 'EXECUTING' });
      return { fatal: 'ERROR_GIT_REMOTE' };
    }

    if (r.kind === 'transient') {
      this.s.retry.pushAttempts += 1;
      if (this.s.state === 'WAIT_GIT_PUSH') this.#emit('GIT_PUSH_RETRY', { repeatSeq: this.s.retry.pushAttempts });
      if (this.s.retry.pushAttempts >= this.s.retry.pushMax) {
        this.#emit('ERROR_GIT_REMOTE');
        this.#transition('PAUSED_NEEDS_USER', { cause: 'ERROR_GIT_REMOTE', pausedFrom: 'EXECUTING' });
        return { fatal: 'ERROR_GIT_REMOTE' };
      }
      if (this.s.state === 'EXECUTING') {
        this.#emit('GIT_PUSH_WAIT');
        this.#transition('WAIT_GIT_PUSH', { pausedFrom: 'EXECUTING' });
      } else {
        this.#touch(); this.store.saveState(this.s); // 重试计数持久化（crash 恢复后仍保留）
      }
      return { waiting: true };
    }

    // rejected（非快进）等：fatal → 人工
    this.#emit('ERROR_GIT_REMOTE');
    this.#transition('PAUSED_NEEDS_USER', { cause: 'ERROR_GIT_REMOTE', pausedFrom: 'EXECUTING' });
    return { fatal: 'ERROR_GIT_REMOTE' };
  }

  /**
   * Web GPT 输出无合法 verdict 块（§14.5，与 markerMissing 对称）：
   * 第 1 次 → VERDICT_RETRY（要求重新输出结构化 verdict）；第 2 次 → PAUSED_NEEDS_USER。
   */
  verdictMissing() {
    this.#assertNotTerminal();
    if (this.s.state !== 'AUDITING') throw new IllegalTransitionError(this.s.state, 'AUDITING(verdict-retry)');
    this.s.verdictRetries += 1;
    if (this.s.verdictRetries === 1) {
      this.#emit('VERDICT_RETRY');
      this.#touch(); this.store.saveState(this.s);
      return { retry: true };
    }
    this.#emit('VERDICT_PARSE_FAILED');
    this.#transition('PAUSED_NEEDS_USER', { cause: 'VERDICT_PARSE_FAILED', pausedFrom: 'AUDITING' });
    return { failed: true };
  }

  /**
   * NEXT_STAGE 后半段推进体（主路径与 recoverTransientState 共用，全幂等：
   * 重复 saveManifest 同值、STAGE_ADVANCED/STAGE_STARTED 事件按 dedupeKey 去重）。
   */
  #completeStageAdvance() {
    const idx = this.manifest.stages.indexOf(this.s.currentStage);
    const nextStage = this.manifest.stages[idx + 1];
    if (nextStage == null) {
      // NEXT_STAGE 只可能由 AUDITING 的 APPROVE 非目标分支进入；最后 stage 的 APPROVE 走
      // STOPPED_TARGET_REACHED。到达这里说明磁盘状态被外部篡改 → fail loud。
      throw new AuditError('AUDIT_STORE_CORRUPTION',
        `NEXT_STAGE persisted at last stage "${this.s.currentStage}" — unrecoverable`);
    }
    this.s.currentStage = nextStage;
    this.s.iteration = 1;
    this.s.revisionCount = 0;
    this.s.stageBaseCommit = this.s.headCommit;
    // v0.4 lineage：刚 APPROVE 的阶段（推进前的 currentStage）记入 completedStages，
    // 供 /audit next 延续链时继承"已通过阶段，不重审"。
    const completedStages = [...(this.manifest.completedStages ?? []), this.manifest.stages[idx]];
    this.manifest = {
      ...this.manifest, currentStage: nextStage, stageBaseCommit: this.s.headCommit,
      completedStages, updatedAt: this.now(),
    };
    this.store.saveManifest(this.manifest);
    this.#emit('STAGE_ADVANCED', { stage: nextStage });
    this.#transition('EXECUTING'); // NEXT_STAGE → EXECUTING（表内唯一出边）
    this.#emit('STAGE_STARTED', { stage: nextStage });
  }

  // ---------- Auditor 侧（§10 / §16 / G6 / G7 / G9） ----------

  /**
   * Web 审核结论（已解析）。重复投递同一 verdict → {deduped:true}（G9）。
   */
  auditorVerdict(parsed) {
    // 幂等短路：terminal/已转移后收到同一 verdict 的重复投递 → 吞掉（G7/G9）。
    if (sameVerdict(parsed, this.s.lastVerdict) && this.s.lastVerdict != null) {
      const inflightMatches = this.s.auditInFlight
        && this.s.auditInFlight.stage === parsed.stage
        && this.s.auditInFlight.iteration === parsed.iteration;
      if (!inflightMatches) return { deduped: true };
    }

    this.#assertNotTerminal();
    if (this.s.state !== 'AUDITING' || !this.s.auditInFlight) {
      throw new IllegalTransitionError(this.s.state, 'VERDICT');
    }
    validateIdentity(
      { runId: this.runId, stage: this.s.currentStage, iteration: this.s.iteration, hostId: this.manifest.hostId },
      parsed,
    );
    this.s.lastVerdict = { ...parsed, headCommit: this.s.auditInFlight.headCommit };
    // v0.4.4：裁决全文持久化（verdicts.jsonl）——lastVerdict 会被后续裁决
    // 覆盖，历史裁决文本必须独立留存，供后续阶段作为可机器验证的证据引用
    // （CSR-8 实况：评审员拒绝采信无法独立验证来源的裁决转录）。
    this.store.appendVerdict({
      runId: this.runId,
      stage: this.s.currentStage,
      iteration: this.s.iteration,
      headCommit: this.s.auditInFlight.headCommit,
      verdict: parsed,
    });
    this.s.verdictRetries = 0; // A1.2-3：合法 verdict 被接受 = 协议周期成功，旧失败不跨 iteration/stage 继承

    if (parsed.state === 'APPROVE') {
      this.#emit('AUDIT_APPROVE');
      this.s.auditInFlight = null;
      if (this.s.currentStage === this.s.stopAfter) {
        this.#emit('TARGET_REACHED');
        this.s.stoppedAt = this.now();
        this.#transition('STOPPED_TARGET_REACHED');
        return { stopped: true };
      }
      // NEXT_STAGE（瞬态）→ EXECUTING；阶段字段推进，revisionCount 仅在此处归零（新 stage）。
      this.#transition('NEXT_STAGE');
      this.#completeStageAdvance();
      return { advanced: true };
    }

    if (parsed.state === 'REVISE') {
      this.#emit('AUDIT_REVISE');
      this.s.auditInFlight = null;
      this.s.revisionCount += 1;
      if (this.s.revisionCount >= this.s.runOptions.maxReviewIterations) {
        this.#transition('REVISE_LOOP_EXHAUSTED');
        this.#emit('REVISE_LOOP_EXHAUSTED');
        this.#transition('PAUSED_NEEDS_USER', { cause: 'REVISE_LOOP_EXHAUSTED', pausedFrom: 'EXECUTING' });
        return { exhausted: true };
      }
      this.s.iteration += 1; // 下一审核轮
      this.#transition('EXECUTING');
      return { revise: true };
    }

    // NEED_USER（§10.3）：auditInFlight 保留 —— 人工回答后同轮继续（同 WEB_QUOTA 恢复语义）。
    this.#emit('NEED_USER');
    this.#transition('PAUSED_NEEDS_USER', { cause: 'NEED_USER', pausedFrom: 'AUDITING' });
    return { needUser: true };
  }

  // ---------- 额度（§14 / §20，双侧分离） ----------

  dshQuotaExhausted() {
    this.#assertNotTerminal();
    this.#emit('DSH_QUOTA_WAIT');
    this.#transition('WAIT_DSH_QUOTA', { pausedFrom: 'EXECUTING' });
  }

  dshQuotaRecovered() {
    this.#assertNotTerminal();
    this.#emit('DSH_QUOTA_RECOVER', { repeatSeq: (this.s.retry.dshRecovers = (this.s.retry.dshRecovers ?? 0) + 1) });
    this.#transition('EXECUTING');
  }

  webQuotaExhausted() {
    this.#assertNotTerminal();
    if (this.s.state !== 'AUDITING') throw new IllegalTransitionError(this.s.state, 'WAIT_WEB_QUOTA');
    this.#emit('WEB_QUOTA_WAIT');
    this.#transition('WAIT_WEB_QUOTA', { pausedFrom: 'AUDITING' }); // auditInFlight 保留：同轮恢复
  }

  webQuotaRecovered() {
    this.#assertNotTerminal();
    this.#emit('WEB_QUOTA_RECOVER', { repeatSeq: (this.s.retry.webRecovers = (this.s.retry.webRecovers ?? 0) + 1) });
    this.#transition('AUDITING'); // 重发同一 stage/iteration/headCommit（语义幂等）
    this.#emit('AUDIT_STARTED', { repeatSeq: this.s.retry.webRecovers });
  }

  // ---------- 用户干预（§17） ----------

  pause() {
    this.#assertNotTerminal();
    this.#emit('PAUSED_BY_USER');
    const from = this.s.state;
    if (from === 'PAUSED' || from === 'PAUSED_NEEDS_USER') return { paused: true };
    this.#transition('PAUSED', { pausedFrom: from });
    return { paused: true };
  }

  resume() {
    this.#assertNotTerminal();
    const target = this.s.pausedFrom ?? 'EXECUTING';
    this.#emit('RESUMED_BY_USER');
    this.#transition(target);
    return { resumed: target };
  }

  stop() {
    this.#assertNotTerminal();
    this.#emit('RUN_STOPPED');
    this.s.stoppedAt = this.now();
    this.#transition('STOPPED');
  }

  rebindAuditSession(observerSessionId, auditSessionId) {
    this.#assertNotTerminal();
    if (!observerSessionId || !auditSessionId) throw new AuditError('AUDIT_ARG_INVALID', 'both observer and audit session ids are required');
    if (this.manifest.observerSessionId && this.manifest.observerSessionId !== observerSessionId) {
      throw new AuditError('AUDIT_SESSION_BINDING_MISMATCH', 'observer session binding changed');
    }
    this.manifest = { ...this.manifest, observerSessionId, dshSessionId: auditSessionId, updatedAt: this.now() };
    this.store.saveManifest(this.manifest);
    this.#emit('AUDIT_SESSION_REBOUND', { observerSessionId, auditSessionId });
    return { observerSessionId, auditSessionId };
  }

  /** /audit until（§6.2）。写入 manifest + 事件。 */
  until(target) {
    this.#assertNotTerminal();
    const { manifest, changed } = changeStopAfter(this.manifest, target, this.now);
    if (!changed) return { changed: false };
    this.manifest = manifest;
    this.s.stopAfter = target;
    this.store.saveManifest(manifest);
    this.#touch(); this.store.saveState(this.s); // A1.1：state.stopAfter 同步落盘
    this.#emit('STOP_TARGET_CHANGED', { stage: this.s.currentStage });
    return { changed: true };
  }

  /**
   * 人工处理后恢复（§17.2 / G11 / v0.2 §8）。
   *  - cause=HISTORY_REWRITTEN：必须显式 newBaselineCommit（不得自动重建 baseline）；
   *  - cause=REVISE_LOOP_EXHAUSTED：可显式 bumpReviewIterations（只增不减，人工「继续加轮次」）；
   *  两者都保持 revisionCount 不自动归零 —— 唯一归零通道是 STAGE_ADVANCED。
   */
  resumeFromHuman({ newBaselineCommit = null, bumpReviewIterations = null } = {}) {
    this.#assertNotTerminal();
    if (this.s.state !== 'PAUSED_NEEDS_USER') throw new IllegalTransitionError(this.s.state, 'HUMAN_RESUME');
    if (this.s.cause === 'HISTORY_REWRITTEN' && !newBaselineCommit) {
      throw new AuditError('AUDIT_BASELINE_REQUIRED',
        'history was rewritten: explicit newBaselineCommit required (G11 — no automatic rebase)');
    }
    if (newBaselineCommit) {
      this.s.stageBaseCommit = newBaselineCommit;
      this.manifest = { ...this.manifest, stageBaseCommit: newBaselineCommit, updatedAt: this.now() };
      this.store.saveManifest(this.manifest);
    }
    if (bumpReviewIterations != null) {
      if (!Number.isInteger(bumpReviewIterations)
        || bumpReviewIterations <= this.s.runOptions.maxReviewIterations) {
        throw new AuditError('AUDIT_ARG_INVALID',
          `bumpReviewIterations must be an integer > current max (${this.s.runOptions.maxReviewIterations})`);
      }
      this.s.runOptions = { ...this.s.runOptions, maxReviewIterations: bumpReviewIterations };
    }
    this.#emit('HUMAN_RESUME');
    const target = this.s.pausedFrom ?? 'EXECUTING';
    this.#transition(target);
    return { resumed: target };
  }
}
