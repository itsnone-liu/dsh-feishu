/**
 * audit/executor.js — A3 DSH executor lifecycle adapter.
 *
 * It observes the existing DSH session event stream, never drives a second
 * session and never invokes the reviewer. A valid READY marker stops the
 * executor path at the remote gate; REVISE feedback is injected into the same
 * bound session.
 */
import { parseExecutorMarker } from './protocol.js';

const textFromMessage = (message) => {
  const content = message?.content ?? message?.message?.content ?? [];
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
};

export class AuditExecutor {
  constructor({ driver, gitGate, prompt = '请只执行当前阶段。完成代码修改后必须创建本地 commit；确认 HEAD 与 commit 完全一致，然后只输出严格 READY_FOR_AUDIT marker（HEAD 必须填写该 commit 哈希）。不要进入下一阶段。', onTransient = null } = {}) {
    this.driver = driver;
    this.gitGate = gitGate;
    this.prompt = prompt;
    this.onTransient = onTransient;
    this.runs = new Map(); // runId -> { run, agent, gate, waiting }
  }

  async start({ run, agent, gitGate = this.gitGate, sendPrompt = true } = {}) {
    if (!run || !agent || !gitGate) throw Object.assign(new Error('executor requires run, agent and git gate'), { code: 'AUDIT_EXECUTOR_CONFIG_INVALID' });
    this.runs.set(run.runId, { run, agent, gitGate, waiting: false, turn: 0, markerTurn: null });
    if (sendPrompt) this.driver.submit(agent, this.prompt);
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
    const entry = [...this.runs.values()].find((x) => x.agent.id === id);
    if (!entry) return { ignored: true };
    const data = event?.data ?? event;
    if (event?.type === 'turn/start') { entry.turn = data.turn ?? (entry.turn + 1); entry.markerTurn = null; return { turnStarted: entry.turn }; }
    if (event?.type === 'turn/end') {
      if (data.reason?.kind === 'completed' && entry.markerTurn !== entry.turn) {
        const missing = entry.run.markerMissing();
        if (missing.retry) this.driver.submit(entry.agent, '请在同一阶段重新严格输出 READY_FOR_AUDIT marker，不要输出普通说明。');
        return { ...missing, turnEnded: true };
      }
      return { turnEnded: true };
    }
    if (event?.type !== 'assistant/message') return { ignored: true };
    const text = textFromMessage(data);
    if (!text) return { ignored: true };
    let marker;
    try {
      marker = parseExecutorMarker(text);
    } catch {
      return { ignored: true };
    }
    const { run, gitGate } = entry;
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
    this.driver.submit(entry.agent, `开始执行冻结任务书中的当前阶段 ${entry.run.s.currentStage}；完成后提交并输出 READY_FOR_AUDIT。`);
    return { started: true, sessionId: entry.agent.id, stage: entry.run.s.currentStage };
  }

  feedback(runId, text) {
    const entry = this.runs.get(runId);
    if (!entry) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    this.driver.submit(entry.agent, text);
    return { injected: true, sessionId: entry.agent.id };
  }
}
