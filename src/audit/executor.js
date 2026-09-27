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
  constructor({ driver, gitGate, prompt = '请只执行当前阶段。完成代码修改后必须创建本地 commit；确认 HEAD 与 commit 完全一致，然后只输出严格 READY_FOR_AUDIT marker（HEAD 必须填写该 commit 哈希）。不要进入下一阶段。' } = {}) {
    this.driver = driver;
    this.gitGate = gitGate;
    this.prompt = prompt;
    this.runs = new Map(); // runId -> { run, agent, gate, waiting }
  }

  async start({ run, agent, gitGate = this.gitGate } = {}) {
    if (!run || !agent || !gitGate) throw Object.assign(new Error('executor requires run, agent and git gate'), { code: 'AUDIT_EXECUTOR_CONFIG_INVALID' });
    this.runs.set(run.runId, { run, agent, gitGate, waiting: false });
    this.driver.submit(agent, this.prompt);
    return { started: true, sessionId: agent.id };
  }

  stop(runId) { this.runs.delete(runId); }

  async onEvent(session, event) {
    const id = session?.id;
    const entry = [...this.runs.values()].find((x) => x.agent.id === id);
    if (!entry || event?.type !== 'assistant/message') return { ignored: true };
    const text = textFromMessage(event.data ?? event);
    if (!text) return { ignored: true };
    let marker;
    try {
      marker = parseExecutorMarker(text);
    } catch {
      return { ignored: true };
    }
    const { run, gitGate } = entry;
    try {
      const ready = run.executorReady(marker);
      if (!ready.pendingRemoteSync) return ready;
      const result = await gitGate.pushAndVerify({
        branch: run.manifest.branch, head: marker.head, remote: 'origin',
      });
      return run.remoteSyncResult(result);
    } catch (e) {
      if (e.code === 'AUDIT_GIT_COMMAND_FAILED') return run.remoteSyncResult({ ok: false, kind: 'transient' });
      if (e.code === 'AUDIT_GIT_REJECTED' || e.code === 'AUDIT_GIT_TIP_DIVERGED' || e.code === 'AUDIT_GIT_HEAD_MISMATCH') {
        return run.remoteSyncResult({ ok: false, kind: 'rejected' });
      }
      throw e;
    }
  }

  /** Reviewer stub/A5 adapter calls this after REVISE; same DSH session only. */
  feedback(runId, text) {
    const entry = this.runs.get(runId);
    if (!entry) throw Object.assign(new Error(`executor run not found: ${runId}`), { code: 'AUDIT_EXECUTOR_NOT_FOUND' });
    this.driver.submit(entry.agent, text);
    return { injected: true, sessionId: entry.agent.id };
  }
}
