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

export class AuditLifecycle {
  constructor({ controller, driver, bindings, gitGateFactory = (opts) => new GitRemoteGate(opts), executorFactory = (opts) => new AuditExecutor(opts) } = {}) {
    this.controller = controller;
    this.driver = driver;
    this.bindings = bindings;
    this.gitGateFactory = gitGateFactory;
    this.executorFactory = executorFactory;
    this.executors = new Map();
  }

  async start({ chatId, stopAfter, stages, goal, approvedPlan } = {}) {
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
    const stageList = stages ?? this.controller.stages;
    const stopAfterCanonical = stageList.find((s) => s.toLowerCase() === String(stopAfter ?? '').toLowerCase());
    // A3 discovers the actual controlled branch from the bound workspace; A2's
    // default branch is not allowed to reject a legitimate existing session.
    const git = await gate.inspect({});
    if (!stopAfterCanonical || !stageList.some((s) => s.toLowerCase() === stopAfterCanonical.toLowerCase())) {
      throw Object.assign(new Error(`停止点 ${stopAfter} 不在阶段表 [${stageList.join(', ')}] 中`), { code: 'AUDIT_MANIFEST_INVALID' });
    }
    const runId = `audit_${Date.now().toString(36)}`;
    const run = AuditRun.create(this.controller.store, {
      runId, hostId: this.controller.hostId, chatId, dshSessionId: agent.id,
      cwd: git.cwd, repo: git.repo, branch: git.branch,
      stages: stageList, stopAfter: stopAfterCanonical,
      startingCommit: git.head, stageBaseCommit: git.head,
      goal: goal ?? 'A3 task goal', approvedPlan: approvedPlan ?? 'A3 approved plan',
    }, { maxReviewIterations: this.controller.maxReviewIterations, now: this.controller.now });
    const executor = this.executorFactory({ driver: this.driver, gitGate: gate });
    this.executors.set(runId, executor);
    await executor.start({ run, agent, gitGate: gate });
    return { run, executor, agent, git };
  }

  async onEvent(session, event) {
    for (const executor of this.executors.values()) {
      await executor.onEvent(session, event).catch(() => undefined);
    }
  }

  resume(runId) {
    const run = AuditRun.open(this.controller.store, { now: this.controller.now })(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'AUDIT_RUN_NOT_FOUND' });
    const binding = this.bindings?.get(run.manifest.chatId);
    if (!binding || binding.sessionId !== run.manifest.dshSessionId) {
      throw Object.assign(new Error('persisted dshSessionId does not match the owner chat binding'), { code: 'AUDIT_SESSION_BINDING_MISMATCH' });
    }
    return this.driver.ensure({ ...binding }, { allowCreate: false }).then((agent) => ({ run, agent }));
  }
}
