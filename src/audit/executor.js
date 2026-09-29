/**
 * audit/executor.js — A3 DSH executor lifecycle adapter.
 *
 * It observes the existing DSH session event stream, never drives a second
 * session and never invokes the reviewer. A valid READY marker stops the
 * executor path at the remote gate; REVISE feedback is injected into the same
 * bound session.
 */
import { parseExecutorMarker, executorMarkerTemplate, sealApprovalHash } from './protocol.js';

const isHumanApprovalGateText = (text) => /\[DSH-AUDIT WAITING_APPROVAL\]/i.test(text);
const runStageIsB4 = (run) => /^B4$/i.test(String(run?.s?.currentStage ?? ''));

const textFromMessage = (message) => {
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
    const humanGate = /^B4$/i.test(String(run.s.currentStage))
      ? '本阶段包含人工授权门：若执行到 B4_SEAL_APPROVAL，必须先输出独立的 [DSH-AUDIT WAITING_APPROVAL] 块，并明确说明正在等待人工批准；此时不要输出 READY_FOR_AUDIT。收到批准后只继续当前阶段并输出 marker。'
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
      entry.turn = data.turn ?? (entry.turn + 1);
      entry.markerTurn = null;
      entry.awaitingFreshTurn = false;
      return { turnStarted: entry.turn };
    }
    if (event?.type === 'turn/end') {
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
    // B4 is a deliberate human gate: the executor must stop after presenting
    // the receipt hash and waiting for the fixed human approval phrase. This
    // is not a missing marker and must not consume marker retries.
    if (runStageIsB4(entry.run) && isHumanApprovalGateText(text)) {
      const result = entry.run.markWaitingForHuman('B4_SEAL_APPROVAL', sealApprovalHash(text));
      return { ...result, event: 'WAITING_FOR_HUMAN' };
    }
    let marker;
    try {
      marker = parseExecutorMarker(text);
    } catch {
      return { ignored: true };
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

  submitHumanResponse(runId, text) {
    const entry = this.runs.get(runId);
    if (!entry || entry.run.isTerminal || !entry.run.s.waitingForHuman) return { ignored: true };
    const value = String(text ?? '').trim();
    if (!sealApprovalHash(value) || /拒绝|不同意|不批准|reject|deny/i.test(value)) {
      return { ignored: true, invalidApproval: true, reason: 'approval was not affirmative' };
    }
    this.driver.submit(entry.agent, value);
    entry.run.clearHumanWait();
    return { submitted: true, sessionId: entry.agent.id };
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
