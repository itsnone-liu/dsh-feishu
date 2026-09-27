/** A3.1 injected-timer retry scheduler for WAIT_GIT_PUSH episodes. */
export class AuditRetryScheduler {
  constructor({ delays = [30_000, 60_000, 120_000, 240_000], setTimer = setTimeout, clearTimer = clearTimeout, onRetry, onError = null } = {}) {
    this.delays = delays;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onRetry = onRetry;
    this.onError = onError;
    this.pending = new Map();
  }

  schedule(runId, fn = this.onRetry, attempt = 1) {
    this.cancel(runId);
    const index = Math.max(0, attempt - 1);
    const timer = this.setTimer(() => {
      this.pending.delete(runId);
      Promise.resolve(fn?.(runId)).catch((e) => { this.onError?.(e, runId); });
    }, this.delays[index] ?? this.delays.at(-1));
    this.pending.set(runId, { timer, attempt: index + 1 });
    return { scheduled: true, delayMs: this.delays[index] ?? this.delays.at(-1) };
  }

  cancel(runId) {
    const p = this.pending.get(runId);
    if (p) this.clearTimer(p.timer);
    this.pending.delete(runId);
  }
}
