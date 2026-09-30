/**
 * audit/controller.js — AuditController（A2/A3）：Feishu /audit 命令 ↔ A1 冻结内核。
 *
 * 职责边界（A2 验收目标）：
 *  - 用户从飞书能安全创建、查看、暂停、恢复、修改停止点、终止 AuditRun；
 *  - 全部语义决策仍在 A1 内核（state-machine）—— Controller 只做定位 run、
 *    调用内核方法、把结果/异常翻译成可读文案，绝不重写转移规则或事件语义；
 *  - A3 的真实 session/git 生命周期通过可选 lifecycle 注入；Controller 仍只做
 *    定位、调用和错误翻译，不重写 A1 转移语义；Web GPT 审核仍留 A5。
 *
 * A2 stub 披露（未注入 lifecycle 时的兼容路径）：
 *  - repo/branch/startingCommit 用 stub；正式 A3 run 通过 AuditLifecycle 探测真实 Git；
 *  - stages 默认表（T1/T2/T3）仍是设计 §5 示例，真实 A3 任务书可注入阶段表。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AuditStore } from './store.js';
import { AuditRun, TERMINAL_STATES } from './state-machine.js';
import { GitRemoteGate } from './git-gate.js';

/** A2 默认阶段表（设计 §5 示例；A3 起由冻结任务书提供）。 */
export const DEFAULT_STAGES = ['T1', 'T2', 'T3'];

const isTerminalState = (s) => TERMINAL_STATES.includes(s);

export class AuditController {
  /**
   * @param {object} p
   * @param {AuditStore} [p.store] 已构造的 store（测试注入；缺省按 rootDir 新建）
   * @param {string} [p.rootDir] store 根目录（默认 $DSH_HOME/feishu/audit）
   * @param {() => number} [p.now] 时钟注入
   * @param {string} [p.hostId] 默认 os.hostname()
   * @param {string} [p.cwd] 默认 process.cwd()
   * @param {string} [p.repo] A2 stub（A3 真实）
   * @param {string} [p.branch] A2 stub
   * @param {string[]} [p.stages] A2 默认表
   * @param {number} [p.maxReviewIterations] 默认 8（内核默认一致）
   */
  constructor(p = {}) {
    this.store = p.store ?? new AuditStore(
      p.rootDir ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'feishu', 'audit'));
    this.now = p.now ?? Date.now;
    this.unattended = p.unattended === true;
    this.hostId = p.hostId ?? os.hostname();
    this.cwd = p.cwd ?? process.cwd();
    this.repo = p.repo ?? 'stub://local/audit-a2';
    this.branch = p.branch ?? 'main';
    this.stages = p.stages ?? DEFAULT_STAGES;
    // Explicit 0 = unlimited. Keep the legacy constructor default for offline
    // callers; production wiring passes 0 from the unattended policy.
    this.maxReviewIterations = p.maxReviewIterations ?? 16;
    this.lifecycle = p.lifecycle ?? null; // A3 real session/git starter, injected by bridge assembly
  }

  async createRealRun({ stopAfter, chatId, stages, goal, approvedPlan } = {}) {
    if (!this.lifecycle) {
      throw Object.assign(new Error('A3 lifecycle is not attached'), { code: 'AUDIT_LIFECYCLE_UNAVAILABLE' });
    }
    return this.lifecycle.start({ stopAfter, chatId, stages, goal, approvedPlan });
  }

  /** 大小写不敏感解析阶段名 → 阶段表原名（canonical）；未命中返回 null。create/until 共用。 */
  resolveStage(input) {
    const s = String(input ?? '').toLowerCase();
    return this.stages.find((x) => x.toLowerCase() === s) ?? null;
  }

  /**
   * A5.5（A′）只读 resolver：runId → { cwd, repo, branch }。
   * 供 WebAuditRunner 的 evidence provider 定位 run 的 git 仓库；绝不写状态。
   * liveRuns 优先（同进程内存态），回落 store.loadRun（磁盘 manifest）。
   */
  resolveRunContext(runId) {
    const live = this.lifecycle?.liveRuns?.get(runId);
    if (live) {
      return { cwd: live.manifest.cwd, repo: live.manifest.repo, branch: live.manifest.branch };
    }
    const loaded = this.store.loadRun(String(runId));
    if (!loaded) return null;
    return { cwd: loaded.manifest.cwd, repo: loaded.manifest.repo, branch: loaded.manifest.branch };
  }

  rebind(chatId) {
    const t = this.#target(chatId);
    if (t.error) return t.error;
    if (!t.id || !this.lifecycle) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有可迁移的审计运行。' };
    return this.lifecycle.rebind(t.id)
      .then(({ run, agent }) => ({ ok: true, runId: run.runId, result: { state: run.s.state, auditSessionId: agent.id } }))
      .catch((e) => ({ ok: false, runId: t.id, code: e.code ?? 'AUDIT_ERROR', message: e.message }));
  }

  /** 当前活跃 run（非终态）。@returns {{id, state, chatId}|null} */
  activeRun() {
    // listRuns 索引可能滞后（saveState 才更新），以磁盘 state.json 为准逐个 open。
    for (const r of this.store.listRuns()) {
      const loaded = this.store.loadRun(r.runId);
      if (loaded && !isTerminalState(loaded.state.state)) {
        return {
          id: loaded.state.runId, state: loaded.state.state,
          chatId: loaded.manifest.chatId ?? null,
        };
      }
    }
    return null;
  }

  /** owner 匹配的最近 run（含终态）。非 owner 不回看终态细节（A2.1 P0-1）。 */
  latestRun(chatId) {
    const runs = this.store.listRuns();
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const loaded = this.store.loadRun(runs[i].runId);
      if (loaded && (loaded.manifest.chatId ?? null) === chatId) {
        return { id: loaded.state.runId };
      }
    }
    return null;
  }

  /**
   * /audit next：找最近一条 STOPPED_TARGET_REACHED 的 run，从其 stopAfter 的
   * 下一阶段创建 continuation run（同一冻结任务链，不重审已完成阶段）。
   * lineage 校验：taskPacketHash 必须与父 run 一致；下一阶段必须存在于父阶段表。
   */
  next(chatId, { stopAfter = null } = {}) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
      return { ok: false, code: 'AUDIT_ARG_INVALID', message: '缺少 chat 上下文（owner 校验 fail closed）。' };
    }
    const active = this.activeRun();
    if (active) {
      return {
        ok: false, code: 'AUDIT_RUN_ACTIVE',
        message: `已有活跃的审计运行 \`${active.id}\`（状态 ${active.state}）；/audit next 仅在无活跃运行时可用。`,
      };
    }
    // 找最近一条 owner 的 STOPPED_TARGET_REACHED run（任务链尾）。
    const runs = this.store.listRuns();
    let parent = null;
    for (let i = runs.length - 1; i >= 0 && !parent; i -= 1) {
      const loaded = this.store.loadRun(runs[i].runId);
      if (loaded
        && (loaded.manifest.chatId ?? null) === chatId
        && loaded.state.state === 'STOPPED_TARGET_REACHED') {
        parent = loaded;
      }
    }
    if (!parent) {
      return { ok: false, code: 'AUDIT_NO_CONTINUATION', message: '没有已到达停止点的审计运行可延续。' };
    }
    const pm = parent.manifest;
    const stages = pm.stages;
    const lastDoneIdx = stages.indexOf(parent.state.stopAfter ?? pm.stopAfter);
    const nextStage = stages[lastDoneIdx + 1];
    if (nextStage == null) {
      return {
        ok: false, code: 'AUDIT_ALREADY_COMPLETE',
        message: `任务链 \`${pm.rootRunId ?? pm.runId}\` 的最后阶段 **${pm.stopAfter}** 已 APPROVE，没有后续阶段。`,
      };
    }
    let stopAfterStage = nextStage;
    if (stopAfter != null) {
      const resolved = stages.includes(stopAfter) ? stopAfter : null;
      if (!resolved) {
        return { ok: false, code: 'AUDIT_MANIFEST_INVALID', message: `停止点 \`${stopAfter}\` 不在阶段表 [${stages.join(', ')}] 中。` };
      }
      if (stages.indexOf(resolved) < stages.indexOf(nextStage)) {
        return {
          ok: false, code: 'AUDIT_CONTINUATION_STAGE_INVALID',
          message: `延续运行不能停在已完成阶段之前的阶段：下一起点为 **${nextStage}**，请求停止点 \`${resolved}\` 早于它。`,
        };
      }
      stopAfterStage = resolved;
    }
    const stamp = new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
    let runId = `audit_${stamp}`;
    for (let n = 2; fs.existsSync(path.join(this.store.root, 'runs', runId)); n += 1) {
      runId = `audit_${stamp}_${n}`;
    }
    const completed = [...(pm.completedStages ?? []), stages[lastDoneIdx]];
    const input = {
      runId, hostId: pm.hostId, chatId, dshSessionId: pm.dshSessionId,
      cwd: pm.cwd, repo: pm.repo, branch: pm.branch,
      stages, stopAfter: stopAfterStage, currentStage: nextStage,
      startingCommit: parent.state.headCommit, stageBaseCommit: parent.state.headCommit,
      goal: pm.goal, approvedPlan: pm.approvedPlan,
      taskPacketHash: pm.taskPacketHash, stageRequirements: pm.stageRequirements,
      parentRunId: pm.runId, rootRunId: pm.rootRunId ?? pm.runId, completedStages: completed,
      ignorePaths: pm.ignorePaths,
    };
    try {
      const run = AuditRun.create(this.store, input, {
        maxReviewIterations: this.maxReviewIterations, now: this.now,
      });
      if (this.unattended) {
        run.s.retry.pushMax = 0;
        this.store.saveState(run.s);
      }
      return {
        ok: true, runId,
        result: { state: run.s.state, currentStage: nextStage, stopAfter: stopAfterStage, parentRunId: pm.runId },
      };
    } catch (e) {
      return { ok: false, runId, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  /**
   * 定位命令目标 run 并做 owner 校验（A2.1 P0-1）。
   * 冻结语义：单 host 一个 active run（auditConcurrencyPerHost=1）+ run 归属发起 chat。
   * 非 owner 只知道「本机有审计在跑」，不暴露 stage/commit/事件。
   * @returns {{id}|{error}|{none}}
   */
  #target(chatId, { allowFinished = false } = {}) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
      return { error: { ok: false, code: 'AUDIT_ARG_INVALID', message: '缺少 chat 上下文（owner 校验 fail closed）。' } };
    }
    const active = this.activeRun();
    if (active) {
      if (active.chatId !== chatId) {
        return {
          error: {
            ok: false, code: 'AUDIT_RUN_OWNED_BY_OTHER_CHAT',
            message: '本机已有审计运行中，但不是本聊天发起的；详情与控制权归属发起聊天。',
          },
        };
      }
      return { id: active.id };
    }
    if (allowFinished) {
      const mine = this.latestRun(chatId);
      return mine ? { id: mine.id } : { none: true };
    }
    return { none: true };
  }

  #open(id) {
    return AuditRun.open(this.store, { now: this.now })(id); // open 自动收敛瞬态（A1.1/A1.2）
  }

  /** 内核调用统一包装：异常翻译为 {ok:false, code, message}，不吞、不改语义。 */
  async #control(id, operation, action) {
    try {
      const result = await this.lifecycle.control(id, operation, action);
      return { ok: true, runId: id, result };
    } catch (e) {
      return { ok: false, runId: id, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  #call(id, fn) {
    try {
      const run = this.lifecycle?.liveRuns?.get(id) ?? this.#open(id);
      const result = fn(run) ?? {};
      return { ok: true, runId: id, result };
    } catch (e) {
      return { ok: false, runId: id, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  /**
   * /audit <stage>：创建 run（A2.1：写入 manifest.chatId = 发起 chat）。
   * 冻结约束 auditConcurrencyPerHost=1：全 host 已有 active run → 拒绝。
   * owner 与非 owner 的话术区分：owner 看到自己的 runId/状态；非 owner 只知道「有审计在跑」。
   */
  createRun({ stopAfter, chatId } = {}) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
      return { ok: false, code: 'AUDIT_ARG_INVALID', message: '缺少 chat 上下文（owner 落盘 fail closed）。' };
    }
    const active = this.activeRun();
    if (active) {
      if (active.chatId === chatId) {
        return {
          ok: false, code: 'AUDIT_RUN_ACTIVE',
          message: `已有活跃的审计运行 \`${active.id}\`（状态 ${active.state}）；请先 \`/audit stop\` 或 \`/audit pause\` 后处理。`,
        };
      }
      return {
        ok: false, code: 'AUDIT_RUN_OWNED_BY_OTHER_CHAT',
        message: '本机已有审计运行中，但不是本聊天发起的；详情与控制权归属发起聊天。',
      };
    }
    const stopAfterStage = this.resolveStage(stopAfter);
    if (!stopAfterStage) {
      return {
        ok: false, code: 'AUDIT_MANIFEST_INVALID',
        message: `停止点 \`${stopAfter}\` 不在阶段表 [${this.stages.join(', ')}] 中。`,
      };
    }
    // runId：毫秒时间戳 + 冲突时递增后缀（同秒多次创建/时钟注入场景防撞名）。
    const stamp = new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
    let runId = `audit_${stamp}`;
    for (let n = 2; fs.existsSync(path.join(this.store.root, 'runs', runId)); n += 1) {
      runId = `audit_${stamp}_${n}`;
    }
    const input = {
      runId, hostId: this.hostId, chatId, dshSessionId: null, // dshSessionId 等 A3 接 session 时填
      cwd: this.cwd,
      repo: this.repo, branch: this.branch,
      stages: this.stages, stopAfter: stopAfterStage,
      startingCommit: 'stub-base-a2', // A3：由真实 git HEAD 提供
      goal: 'A2 stub goal（A3 由冻结任务书提供）',
      approvedPlan: 'A2 stub plan（A3 由冻结任务书提供）',
    };
    try {
      const run = AuditRun.create(this.store, input, {
        maxReviewIterations: this.maxReviewIterations, now: this.now,
      });
      if (this.unattended) {
        run.s.retry.pushMax = 0;
        this.store.saveState(run.s);
      }
      return { ok: true, runId, result: { state: run.s.state, stopAfter: stopAfterStage } };
    } catch (e) {
      return { ok: false, runId, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  /** /audit status：owner 视角。活跃 run 非 owner → 只报存在性；空闲回退 owner 自己的最近 run。 */
  status(chatId) {
    const t = this.#target(chatId, { allowFinished: true });
    if (t.error) return t.error;
    const id = t.id;
    if (!id) return { ok: false, code: 'AUDIT_NO_RUN', message: '还没有任何审计运行。用 `/audit <阶段>` 创建（如 `/audit T2`）。' };
    try {
      const run = this.#open(id);
      const loaded = this.store.loadRun(id);
      const recent = loaded.events.slice(-5).map((e) => e.event);
      return {
        ok: true, runId: id,
        result: {
          state: run.s.state,
          currentStage: run.s.currentStage,
          stopAfter: run.s.stopAfter,
          iteration: run.s.iteration,
          revisionCount: run.s.revisionCount,
          maxReviewIterations: run.s.runOptions.maxReviewIterations,
          cause: run.s.cause,
          lastPauseCause: run.s.lastPauseCause ?? null,
          lastExecutorEventAt: run.s.lastExecutorEventAt ?? null,
          lastExecutorEvent: run.s.lastExecutorEvent ?? null,
          lastExecutorTurn: run.s.lastExecutorTurn ?? null,
          observerSessionId: run.manifest.observerSessionId ?? null,
          auditSessionId: run.manifest.dshSessionId ?? null,
          auditedCommits: run.manifest.auditedCommits,
          repo: run.manifest.repo,
          branch: run.manifest.branch,
          recentEvents: recent,
          startedAt: run.s.startedAt,
          chatId: run.manifest.chatId ?? null,
        },
      };
    } catch (e) {
      return { ok: false, runId: id, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  pause(chatId) {
    const t = this.#target(chatId);
    if (t.error) return t.error;
    const id = t.id;
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可暂停。' };
    if (this.lifecycle?.liveRuns?.has(id)) return this.#control(id, (run) => { run.pause(); return { state: run.s.state }; }, 'pause');
    return this.#call(id, (run) => ({ state: (run.pause(), run.s.state) }));
  }

  /**
   * /audit resume：PAUSED → 回 pausedFrom；PAUSED_NEEDS_USER → resumeFromHuman。
   * HISTORY_REWRITTEN 需要显式 newBaseline —— A2 无该命令通道，明确报错指引发 A3 接线。
   */
  resume(chatId, { bumpReviewIterations = null } = {}) {
    const t = this.#target(chatId);
    if (t.error) return t.error;
    const id = t.id;
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可恢复。' };
    if (this.lifecycle) {
      return this.lifecycle.resume(id, { human: true, bumpReviewIterations })
        .then(({ run }) => ({ ok: true, runId: id, result: { state: run.s.state, resumed: true, maxReviewIterations: run.s.runOptions.maxReviewIterations } }))
        .catch((e) => ({ ok: false, runId: id, code: e.code ?? 'AUDIT_ERROR', message: e.message }));
    }
    return this.#call(id, (run) => {
      if (run.s.state === 'PAUSED_NEEDS_USER') {
        if (run.s.cause === 'HISTORY_REWRITTEN') {
          const err = new Error('历史被改写后的恢复需要显式新 baseline（G11）；A2 命令面未提供该操作，请等待 A3 接线或人工处理 store。');
          err.code = 'AUDIT_BASELINE_REQUIRED';
          throw err;
        }
        const r = run.resumeFromHuman({ bumpReviewIterations });
        return { state: run.s.state, resumed: r.resumed, maxReviewIterations: run.s.runOptions.maxReviewIterations };
      }
      const r = run.resume();
      return { state: run.s.state, resumed: r.resumed };
    });
  }

  stop(chatId) {
    const t = this.#target(chatId);
    if (t.error) return t.error;
    const id = t.id;
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可终止。' };
    if (this.lifecycle?.liveRuns?.has(id)) return this.#control(id, (run) => { run.stop(); return { state: run.s.state }; }, 'stop');
    return this.#call(id, (run) => ({ state: (run.stop(), run.s.state) }));
  }

  /** /audit until X：v0.2 §6.2 竞态规则全部由内核 manifest.changeStopAfter 执行。 */
  until(chatId, target) {
    const t = this.#target(chatId);
    if (t.error) return t.error;
    const id = t.id;
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可修改停止点。' };
    if (!target) return { ok: false, code: 'AUDIT_ARG_INVALID', message: '用法：`/audit until <阶段>`' };
    if (this.lifecycle?.liveRuns?.has(id)) {
      // R1 止血 F6：真实 run 的停止点校验用 run.manifest.stages（冻结任务书
      // 阶段表，如 B4/G）——此前用 controller 默认表（T1/T2/T3），真实任务
      // 阶段全部被拒。§6.2 语义（target ∈ stages 且 index ≥ currentStage）
      // 仍全部由内核 manifest.changeStopAfter 执行，其具体错误经 #control
      // 原样透传（code/message 不改写）。
      return this.#control(id, (run) => {
        const stages = run.manifest.stages;
        const canonical = stages.find((x) => x.toLowerCase() === String(target).toLowerCase());
        if (!canonical) {
          throw Object.assign(new Error(`停止点 \`${target}\` 不在阶段表 [${stages.join(', ')}] 中`), { code: 'AUDIT_MANIFEST_INVALID' });
        }
        // 其余 §6.2 校验（index ≥ currentStage 等）由内核 changeStopAfter 执行，错误透传。
        const r = run.until(canonical);
        return { changed: r.changed, stopAfter: run.s.stopAfter };
      }, 'until');
    }
    // A2 stub 路径（无 lifecycle manifest 的 run）：保持默认表行为。
    const canonical = this.resolveStage(target);
    if (!canonical) {
      return { ok: false, code: 'AUDIT_MANIFEST_INVALID', message: `停止点 \`${target}\` 不在阶段表 [${this.stages.join(', ')}] 中。` };
    }
    return this.#call(id, (run) => {
      const r = run.until(canonical);
      return { changed: r.changed, stopAfter: run.s.stopAfter };
    });
  }
}
