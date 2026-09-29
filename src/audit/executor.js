/**
 * audit/executor.js — A3 DSH executor lifecycle adapter.
 *
 * It observes the existing DSH session event stream, never drives a second
 * session and never invokes the reviewer. A valid READY marker stops the
 * executor path at the remote gate; REVISE feedback is injected into the same
 * bound session.
 */
import { parseExecutorMarker, parseHumanApprovalWait, executorMarkerTemplate, sealApprovalHash, revealApprovalHash, approvalForGateKind } from './protocol.js';

const isQuotaFailure = (reason) => /429|quota|rate.?limit|usage.?limit|额度|配额|限额|exhausted|too many requests/i.test(String(reason ?? ''));

const isHumanApprovalGateText = (text) => /\[DSH-AUDIT WAITING_APPROVAL\]/i.test(text);

/**
 * P-B 门位通用化：人闸不再按阶段名硬编码（/^B4$/），改为读冻结任务书
 * preauthorization 节派生的 manifest.stageGates（B4 SEAL / C2 REVEAL / C5 SEAL …
 * 由任务书声明，代码不认知任何具体阶段名）。旧任务书（无该节）→ 无人闸，
 * 行为与现在完全一致。返回 { kind, gateKind, phrase } 或 null。
 */
const humanGateFor = (run) => {
  const stage = String(run?.s?.currentStage ?? '').toUpperCase();
  const gates = run?.manifest?.stageGates;
  const gate = gates?.[stage];
  // P-B 兼容回退：manifest 无任何 stageGates（旧任务书/修订前创建的 run）时，
  // 沿用历史 /^B4$/ 推断为 SEAL 门——修订前创建的在途 run 不因任务书未修订
  // 而丢闸门。一旦 manifest 声明了 stageGates（修订后新 run），声明即权威：
  // 未声明的阶段（含 B4）无门。
  const resolved = gate ?? (gates && Object.keys(gates).length > 0 ? null : (/^B4$/.test(stage) ? { kind: 'SEAL' } : null));
  if (!resolved) return null;
  const phrase = approvalForGateKind(resolved.kind === 'REVEAL' ? 'NEXT_REVEAL_ONLY' : 'SEAL_ANNOTATION_ONLY');
  return phrase ? { kind: resolved.kind, gateKind: phrase.gateKind, phrase } : null;
};
/** 兼容旧 state（waitingReason='B4_SEAL_APPROVAL'）与 P-B 通用 reason。 */
const isHumanWaitReason = (reason) => /_(SEAL|REVEAL)_APPROVAL$/.test(String(reason ?? ''));

export const textFromMessage = (message) => {
  const content = message?.content ?? message?.message?.content ?? [];
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
};

export class AuditExecutor {
  constructor({ driver, gitGate, prompt = '开始执行冻结任务书中的当前阶段。', onTransient = null } = {}) {
    this.driver = driver;
    this.gitGate = gitGate;
    this.prompt = prompt;
    this.onTransient = onTransient;
    this.runs = new Map(); // runId -> { run, agent, gate, waiting }
  }

  /**
   * A5.4（真实 E2E 前的已知接线缺口修复）：stage prompt 必须携带与
   * buildExecutorMarkerText 双向一致的 marker 模板，并填入当前 run 的
   * RUN_ID/HOST_ID/STAGE/ITERATION 真实值——否则真实 DSH executor 无从得知
   * identity 字段该填什么（validateIdentity 对 HOST_ID fail-closed）。
   * 仅改 prompt 文本，不改编排。
   */
  #promptWithMarker(entry, lead) {
    const { run } = entry;
    const tpl = executorMarkerTemplate({
      runId: run.runId,
      hostId: run.manifest.hostId,
      stage: run.s.currentStage,
      iteration: run.s.iteration,
    });
    const reqs = run.manifest.stageRequirements?.[run.s.currentStage];
    const taskBlock = reqs
      ? `\n\n【本阶段要求（冻结任务书${run.manifest.taskPacketHash ? ` hash ${run.manifest.taskPacketHash.slice(0, 12)}` : ''}，逐条满足）】\n${reqs}`
      : '';
    const gate = humanGateFor(run);
    const humanGate = gate
      ? `\n\n本阶段包含人工授权门（${gate.gateKind}）。到达人闸时必须输出以下严格块（不要输出 READY_FOR_AUDIT）：\n[DSH-AUDIT]\nSTATE: WAIT_HUMAN_APPROVAL\nRUN_ID: ${run.runId}\nSTAGE: ${run.s.currentStage}\nITERATION: ${run.s.iteration}\nHOST_ID: ${run.manifest.hostId}\nQUESTION:\n<${gate.phrase.noun}_sha256 与任务书固定批准说明>\n收到批准后只继续当前阶段并输出 READY_FOR_AUDIT。`
      : '';
    return `${lead}请只执行当前阶段：完成代码修改后必须创建本地 commit；确认 HEAD 与该 commit 完全一致，然后只输出严格 READY_FOR_AUDIT marker——除 HEAD 与可选的 SUMMARY/TESTS 外，字段值必须与下面模板中给出的值完全一致（HEAD 填写该 commit 哈希）。不要进入下一阶段，不要输出 marker 以外的说明。${humanGate}${taskBlock}\n\n${tpl}`;
  }

  async start({ run, agent, gitGate = this.gitGate, sendPrompt = true } = {}) {
    if (!run || !agent || !gitGate) throw Object.assign(new Error('executor requires run, agent and git gate'), { code: 'AUDIT_EXECUTOR_CONFIG_INVALID' });
    this.runs.set(run.runId, {
      run, agent, gitGate, waiting: false, turn: 0, markerTurn: null,
      // On reattach, ignore late assistant output from the failed turn until
      // the fresh turn/start event arrives.
      awaitingFreshTurn: !sendPrompt,
    });
    if (sendPrompt) this.driver.submit(agent, this.#promptWithMarker({ run }, this.prompt));
    else if (agent.status !== 'idle') throw Object.assign(new Error('cannot reattach executor while session is busy'), { code: 'AUDIT_SESSION_OCCUPIED' });
    return { started: true, sessionId: agent.id };
  }

  stop(runId) { this.runs.delete(runId); }

  /**
   * R1 止血 F7：stop/pause 传播取消 —— 对底层 DSH agent 的在跑 turn 发起
   * cancel（kind:'user' + keepInbox:true，与 driver.stop 同语义，参考
   * driver.js）。cancel 是异步回调式：这里同步发起即返回，不等待取消完成。
   * agent 无 cancel 接口（测试 stub）时静默忽略。
   */
  cancel(runId) {
    const entry = this.runs.get(runId);
    if (!entry || typeof entry.agent?.cancel !== 'function') return { ignored: true };
    try {
      entry.agent.cancel({ kind: 'user' }, { keepInbox: true });
      return { cancelled: true, sessionId: entry.agent.id };
    } catch (e) {
      return { ignored: true, error: String(e?.message ?? e) };
    }
  }

  async retry(runId) {
    const entry = this.runs.get(runId);
    if (!entry || !entry.run.s.pendingRemoteSync) return { ignored: true };
    const sync = entry.run.s.pendingRemoteSync;
    try {
      const result = await entry.gitGate.pushAndVerify({ branch: entry.run.manifest.branch, head: sync.head, remote: 'origin' });
      return entry.run.remoteSyncResult(result);
    } catch (e) {
      if (e.code === 'AUDIT_GIT_COMMAND_FAILED') {
        const result = entry.run.remoteSyncResult({ ok: false, kind: 'transient' });
        if (result.waiting && this.onTransient) await this.onTransient(entry, result, entry.run.s.retry.pushAttempts);
        return result;
      }
      return entry.run.remoteSyncResult({ ok: false, kind: 'rejected' });
    }
  }

  async onEvent(session, event) {
    const id = session?.id;
    // 同一 session 可先后绑定多个 run（续链 / /audit next 新 run）。终态 run 的
    // 残留 entry 不得拦截新 run 的 marker 事件：优先匹配非终态 entry。
    const matches = [...this.runs.values()].filter((x) => x.agent.id === id);
    const entry = matches.find((x) => !x.run.isTerminal) ?? matches[0];
    if (!entry) return { ignored: true };
    const data = event?.data ?? event;
    entry.run.recordExecutorEvent(event?.type ?? 'unknown', data.turn ?? entry.turn);
    if (event?.type === 'turn/start') {
      // AutoContinue submits the normal "继续" after the model quota window
      // recovers. Re-open the durable audit state at that boundary; the
      // executor prompt itself is the continuation, so no duplicate prompt.
      if (entry.run.s.state === 'WAIT_DSH_QUOTA') entry.run.dshQuotaRecovered();
      entry.turn = data.turn ?? (entry.turn + 1);
      entry.markerTurn = null;
      entry.awaitingFreshTurn = false;
      return { turnStarted: entry.turn };
    }
    if (event?.type === 'turn/end') {
      // Quota exhaustion belongs to the bridge AutoContinue state machine. Keep
      // the audit run durably waiting and let its recovery callback re-drive the
      // same executor cycle; never turn a temporary 429 into a human stop.
      if (data.reason?.kind === 'error' && isQuotaFailure(data.reason?.error?.message ?? data.reason?.error?.code)) {
        if (entry.run.s.state === 'EXECUTING') {
          entry.run.dshQuotaExhausted();
          return { turnEnded: true, quota: true, waitingQuota: true };
        }
        return { turnEnded: true, quota: true, waitingQuota: true, stale: true };
      }
      // A late completion event can arrive after a NEED_USER/manual pause has
      // already been persisted.  It belongs to the old executor turn and must
      // not be interpreted as a new marker-retry cycle: markerMissing() is only
      // legal while the run is EXECUTING.  Treat it as stale and let the
      // explicit /audit resume path start the next cycle.
      if (entry.run.s.state !== 'EXECUTING') return { turnEnded: true, stale: true };
      if (data.reason?.kind === 'completed' && entry.markerTurn !== entry.turn) {
        if (entry.run.s.waitingForHuman) return { turnEnded: true, waitingForHuman: true, reason: entry.run.s.waitingReason };
        const missing = entry.run.markerMissing();
        if (missing.retry) this.driver.submit(entry.agent, `请在同一阶段重新严格输出 READY_FOR_AUDIT marker，不要输出普通说明。\n\n${executorMarkerTemplate({ runId: entry.run.runId, hostId: entry.run.manifest.hostId, stage: entry.run.s.currentStage, iteration: entry.run.s.iteration })}`);
        return { ...missing, turnEnded: true };
      }
      return { turnEnded: true };
    }
    if (event?.type !== 'assistant/message') return { ignored: true };
    // A stale assistant message can be delivered after resume and before the
    // new turn/start. It must never be parsed as the current marker.
    if (entry.awaitingFreshTurn) return { ignored: true, stale: true };
    const { run, gitGate } = entry;
    if (run.isTerminal) {
      this.runs.delete(run.runId);
      return { ignored: true, stale: true };
    }
    if (run.s.state !== 'EXECUTING') return { ignored: true, stale: true };
    const text = textFromMessage(data);
    if (!text) return { ignored: true };
    // P-B 门位通用化：WAIT_HUMAN_APPROVAL 属声明的授权门（不再按 /^B4$/ 阶段名）。
    // 门是刻意的人工停止点：不是缺 marker，不消耗 marker 重试。
    const gate = humanGateFor(entry.run);
    if (gate) {
      try {
        const waiting = parseHumanApprovalWait(text);
        if (waiting.runId === entry.run.runId && waiting.stage === entry.run.s.currentStage && waiting.iteration === entry.run.s.iteration) {
          // R1 F1：question（QUESTION 段原文）随 state 持久化（waitingQuestion），
          // 人闸通知才能完整呈现"等待什么、批什么"。reason = <STAGE>_<KIND>_APPROVAL
          //（B4 SEAL → 'B4_SEAL_APPROVAL'，与历史 state 逐字一致）。
          const reason = `${String(entry.run.s.currentStage).toUpperCase()}_${gate.kind}_APPROVAL`;
          const result = entry.run.markWaitingForHuman(reason, text.match(/[0-9a-f]{64}/i)?.[0] ?? null, waiting.question);
          return { ...result, event: 'WAITING_FOR_HUMAN', gate: gate.gateKind, question: waiting.question };
        }
      } catch {}
    }
    let marker;
    try {
      marker = parseExecutorMarker(text);
    } catch {
      return { ignored: true };
    }
    // P-B D5 防绕过：声明了人闸的阶段，READY_FOR_AUDIT 不得跳过人闸。门未对该
    //（stage, iteration）放行时 marker 一律拒收并回发指引；不消耗 marker 重试
    //（这是协议违规指引，不是缺 marker）。REVISE 换 attempt 后旧批准自失效
    //（humanGatePassed 按 stage+iteration 作用域，见 state-machine）。
    if (gate && (entry.run.s.waitingForHuman
      || !(entry.run.s.humanGatePassed?.stage === String(entry.run.s.currentStage).toUpperCase() && entry.run.s.humanGatePassed?.iteration === entry.run.s.iteration))) {
      this.driver.submit(entry.agent, `当前阶段 ${entry.run.s.currentStage} 含人工授权门（${gate.gateKind}）：必须先输出 WAIT_HUMAN_APPROVAL 严格块（RUN_ID/STAGE/ITERATION/HOST_ID/QUESTION，QUESTION 含 ${gate.phrase.noun}_sha256），等待人类批准后才允许输出 READY_FOR_AUDIT。请重新输出 WAIT_HUMAN_APPROVAL 块。`);
      return { ignored: true, gateBypassBlocked: true, stage: entry.run.s.currentStage };
    }
    if (run.isTerminal) {
      // 残留的终态 entry 收到了（属于新 run 的）marker：自清理让位，
      // 不得继续 ancestry/executorReady（终态 run 上必抛 AUDIT_RUN_FROZEN）。
      this.runs.delete(run.runId);
      return { ignored: true };
    }
    try {
      const ancestryOk = await Promise.all([
        run.manifest.stageBaseCommit,
        ...run.manifest.auditedCommits,
      ].filter(Boolean).map((commit) => gitGate.isAncestor(commit, marker.head))).then((checks) => checks.every(Boolean));
      const ready = run.executorReady(marker, { ancestryOk });
      entry.markerTurn = entry.turn;
      if (!ready.pendingRemoteSync) return ready;
      const result = await gitGate.pushAndVerify({
        branch: run.manifest.branch, head: marker.head, remote: 'origin',
      });
      return run.remoteSyncResult(result);
    } catch (e) {
      if (e.code === 'AUDIT_RUN_FROZEN') {
        // 残留的终态 entry 收到了（属于新 run 的）marker：清掉自己并让位，
        // 不得让异常中断 lifecycle 对其余 run 的分发。
        this.runs.delete(run.runId);
        return { ignored: true };
      }
      if (e.code === 'AUDIT_GIT_COMMAND_FAILED') {
        const result = run.remoteSyncResult({ ok: false, kind: 'transient' });
        if (result.waiting && this.onTransient) await this.onTransient(entry, result, entry.run.s.retry.pushAttempts);
        return result;
      }
      if (e.code === 'AUDIT_GIT_REJECTED' || e.code === 'AUDIT_GIT_TIP_DIVERGED' || e.code === 'AUDIT_GIT_HEAD_MISMATCH') {
        return run.remoteSyncResult({ ok: false, kind: 'rejected' });
      }
      throw e;
    }
  }

  /**
   * P-B 门位通用化：人工明文批准按门型分发冻结话术校验，且 hash 必须与
   * waitingApprovalHash 逐字符相等（旧代码只查话术格式、不比对 hash ——
   * 任何 64hex 的合法话术都能放行，属父链 D 发现的失配缺口）。
   * 显式拒绝词 fail-closed。话术路径不读 PreauthStore（§3 并行原则）。
   */
  submitHumanResponse(runId, text) {
    const entry = this.runs.get(runId);
    if (!entry || entry.run.isTerminal || !entry.run.s.waitingForHuman) return { ignored: true };
    const value = String(text ?? '').trim();
    if (/拒绝|不同意|不批准|reject|deny/i.test(value)) {
      return { ignored: true, invalidApproval: true, reason: 'approval was not affirmative' };
    }
    const gate = humanGateFor(entry.run);
    const hashOf = gate ? gate.phrase.hashOf : sealApprovalHash; // 旧 state 无 stageGates：维持 SEAL 话术
    const hash = hashOf(value);
    if (!hash) return { ignored: true, invalidApproval: true, reason: 'approval phrase mismatch' };
    if (entry.run.s.waitingApprovalHash && hash.toLowerCase() !== String(entry.run.s.waitingApprovalHash).toLowerCase()) {
      return { ignored: true, invalidApproval: true, reason: 'approval hash does not match the gate receipt hash' };
    }
    this.driver.submit(entry.agent, value);
    entry.run.clearHumanWait();
    return { submitted: true, sessionId: entry.agent.id, gateKind: gate?.gateKind ?? null };
  }

  /** Reviewer stub/A5 adapter calls this after REVISE; same DSH session only. */
  applyVerdict(runId, parsed) {
    const entry = this.runs.get(runId);
    if (!entry) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    const result = entry.run.auditorVerdict(parsed);
    if (result.revise) this.feedback(runId, parsed.reason?.join?.('\n') ?? '请根据审核意见修复当前阶段，并重新输出 READY_FOR_AUDIT。');
    else if (result.advanced) this.startStage(runId);
    return result;
  }

  startStage(runId) {
    const entry = this.runs.get(runId);
    if (!entry) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    this.driver.submit(entry.agent, this.#promptWithMarker(entry, `开始执行冻结任务书中的当前阶段 ${entry.run.s.currentStage}；完成后提交并输出 READY_FOR_AUDIT。\n\n`));
    return { started: true, sessionId: entry.agent.id, stage: entry.run.s.currentStage };
  }

  feedback(runId, text) {
    const entry = this.runs.get(runId);
    if (!entry) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    // A5.4: 反馈后 executor 必须按当前（已推进的）iteration 重新输出 marker，
    // 因此反馈文本末尾同样携带填好真实值的模板。
    const tpl = executorMarkerTemplate({ runId: entry.run.runId, hostId: entry.run.manifest.hostId, stage: entry.run.s.currentStage, iteration: entry.run.s.iteration });
    this.driver.submit(entry.agent, `${text}\n\n修复完成后，请按以下模板重新输出 READY_FOR_AUDIT marker：\n\n${tpl}`);
    return { injected: true, sessionId: entry.agent.id };
  }
}
