/**
 * audit/controller.js — AuditController（A2）：Feishu /audit 命令 ↔ A1 冻结内核。
 *
 * 职责边界（A2 验收目标）：
 *  - 用户从飞书能安全创建、查看、暂停、恢复、修改停止点、终止 AuditRun；
 *  - 全部语义决策仍在 A1 内核（state-machine）—— Controller 只做定位 run、
 *    调用内核方法、把结果/异常翻译成可读文案，绝不重写转移规则或事件语义；
 *  - 外部执行端（DSH lifecycle / git push / Web GPT）A2 一律不接：run 停在
 *    EXECUTING 是预期行为（A3/A5 接线后才有驱动）。
 *
 * A2 stub 披露（A3 替换为真实值）：
 *  - repo/branch/startingCommit 用 stub —— 真实 git 事实源在 A3 REMOTE_SYNC_GATE
 *    接线时由启动流程探测提供；
 *  - stages 默认表（T1/T2/T3）来自设计 §5 的示例任务书，真实 stages 属 A3 冻结计划。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AuditStore } from './store.js';
import { AuditRun, TERMINAL_STATES } from './state-machine.js';

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
    this.hostId = p.hostId ?? os.hostname();
    this.cwd = p.cwd ?? process.cwd();
    this.repo = p.repo ?? 'stub://local/audit-a2';
    this.branch = p.branch ?? 'main';
    this.stages = p.stages ?? DEFAULT_STAGES;
    this.maxReviewIterations = p.maxReviewIterations ?? 8;
  }

  /** 当前活跃 run（非终态）。@returns {{id: string, state: string}|null} */
  activeRun() {
    // listRuns 索引可能滞后（saveState 才更新），以磁盘 state.json 为准逐个 open。
    for (const r of this.store.listRuns()) {
      const loaded = this.store.loadRun(r.runId);
      if (loaded && !isTerminalState(loaded.state.state)) {
        return { id: loaded.state.runId, state: loaded.state.state };
      }
    }
    return null;
  }

  /** 最近一次 run（含终态），status 空闲时展示。 */
  latestRun() {
    const runs = this.store.listRuns();
    if (runs.length === 0) return null;
    const last = runs[runs.length - 1];
    const loaded = this.store.loadRun(last.runId);
    return loaded ? { id: loaded.state.runId } : null;
  }

  /** 定位命令目标 run：优先活跃 run；无活跃时回退最近 run（供 status 查看）。 */
  #target({ allowFinished = false } = {}) {
    const active = this.activeRun();
    if (active) return active.id;
    if (allowFinished) return this.latestRun()?.id ?? null;
    return null;
  }

  #open(id) {
    return AuditRun.open(this.store, { now: this.now })(id); // open 自动收敛瞬态（A1.1/A1.2）
  }

  /** 内核调用统一包装：异常翻译为 {ok:false, code, message}，不吞、不改语义。 */
  #call(id, fn) {
    try {
      const run = this.#open(id);
      const result = fn(run) ?? {};
      return { ok: true, runId: id, result };
    } catch (e) {
      return { ok: false, runId: id, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  /** /audit <stage>：创建 run。已有活跃 run → 拒绝（先 /audit stop）。 */
  createRun({ stopAfter } = {}) {
    const active = this.activeRun();
    if (active) {
      return {
        ok: false, code: 'AUDIT_RUN_ACTIVE',
        message: `已有活跃的审计运行 \`${active.id}\`（状态 ${active.state}）；请先 \`/audit stop\` 或 \`/audit pause\` 后处理。`,
      };
    }
    // 大小写规范化：t2 → T2（匹配阶段表原名）
    const stage = this.stages.find((s) => s.toLowerCase() === String(stopAfter).toLowerCase());
    if (!stage) {
      return {
        ok: false, code: 'AUDIT_MANIFEST_INVALID',
        message: `停止点 \`${stopAfter}\` 不在阶段表 [${this.stages.join(', ')}] 中。`,
      };
    }
    const stopAfterStage = stage;
    // runId：毫秒时间戳 + 冲突时递增后缀（同秒多次创建/时钟注入场景防撞名）。
    const stamp = new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
    let runId = `audit_${stamp}`;
    for (let n = 2; fs.existsSync(path.join(this.store.root, 'runs', runId)); n += 1) {
      runId = `audit_${stamp}_${n}`;
    }
    const input = {
      runId, hostId: this.hostId, cwd: this.cwd,
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
      return { ok: true, runId, result: { state: run.s.state, stopAfter } };
    } catch (e) {
      return { ok: false, runId, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  /** /audit status：活跃优先，空闲回退最近 run。 */
  status() {
    const id = this.#target({ allowFinished: true });
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
          auditedCommits: run.manifest.auditedCommits,
          repo: run.manifest.repo,
          branch: run.manifest.branch,
          recentEvents: recent,
          startedAt: run.s.startedAt,
        },
      };
    } catch (e) {
      return { ok: false, runId: id, code: e.code ?? 'AUDIT_ERROR', message: e.message };
    }
  }

  pause() {
    const id = this.#target();
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可暂停。' };
    return this.#call(id, (run) => ({ state: (run.pause(), run.s.state) }));
  }

  /**
   * /audit resume：PAUSED → 回 pausedFrom；PAUSED_NEEDS_USER → resumeFromHuman。
   * HISTORY_REWRITTEN 需要显式 newBaseline —— A2 无该命令通道，明确报错指引发 A3 接线。
   */
  resume() {
    const id = this.#target();
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可恢复。' };
    return this.#call(id, (run) => {
      if (run.s.state === 'PAUSED_NEEDS_USER') {
        if (run.s.cause === 'HISTORY_REWRITTEN') {
          const err = new (run.constructor && Error)('历史被改写后的恢复需要显式新 baseline（G11）；A2 命令面未提供该操作，请等待 A3 接线或人工处理 store。');
          err.code = 'AUDIT_BASELINE_REQUIRED';
          throw err;
        }
        const r = run.resumeFromHuman({});
        return { state: run.s.state, resumed: r.resumed };
      }
      const r = run.resume();
      return { state: run.s.state, resumed: r.resumed };
    });
  }

  stop() {
    const id = this.#target();
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可终止。' };
    return this.#call(id, (run) => ({ state: (run.stop(), run.s.state) }));
  }

  /** /audit until X：v0.2 §6.2 竞态规则全部由内核 manifest.changeStopAfter 执行。 */
  until(target) {
    const id = this.#target();
    if (!id) return { ok: false, code: 'AUDIT_NO_ACTIVE_RUN', message: '没有活跃的审计运行可修改停止点。' };
    if (!target) return { ok: false, code: 'AUDIT_ARG_INVALID', message: '用法：`/audit until <阶段>`' };
    return this.#call(id, (run) => {
      const r = run.until(target);
      return { changed: r.changed, stopAfter: run.s.stopAfter };
    });
  }
}
