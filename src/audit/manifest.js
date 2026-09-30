/**
 * audit/manifest.js — AuditRun manifest：自动模式的授权边界（§7 / v0.2 §6.2·§7.2·§7.3 / v0.3）。
 *
 * Manifest 在 /audit 启动时冻结，运行期只有两个合法变更通道：
 *  - stopAfter（/audit until，受 §6.2 竞态规则约束）；
 *  - currentStage / stageBaseCommit / auditedCommits（状态机推进时同步）。
 * 其余字段一律不可变。Auditor 不得通过任何 verdict 改写本文件（§7.1 / G5）。
 */
import { ManifestValidationError } from './errors.js';

export const MANIFEST_SCHEMA_VERSION = 1;

const isNonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 校验并规范化 manifest 输入。任何不满足冻结结构的输入都抛 ManifestValidationError。
 * @param {object} raw
 * @param {() => number} [now]
 * @returns {object} 规范化后的 manifest（新对象）
 */
export function createManifest(raw, now = Date.now) {
  const req = (field) => {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) {
      throw new ManifestValidationError(`missing field: ${field}`);
    }
    return raw[field];
  };

  const runId = req('runId');
  if (!isNonEmptyStr(runId)) throw new ManifestValidationError('runId must be a non-empty string');
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new ManifestValidationError(`runId "${runId}" contains path-unsafe characters`);
  }

  for (const f of ['hostId', 'cwd', 'repo', 'branch']) {
    if (!isNonEmptyStr(req(f))) throw new ManifestValidationError(`${f} must be a non-empty string`);
  }

  const stages = req('stages');
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new ManifestValidationError('stages must be a non-empty array');
  }
  for (const s of stages) {
    if (!isNonEmptyStr(s)) throw new ManifestValidationError('every stage must be a non-empty string');
  }
  if (new Set(stages).size !== stages.length) {
    throw new ManifestValidationError('stages must not contain duplicates');
  }

  const stopAfter = req('stopAfter');
  if (!stages.includes(stopAfter)) throw new ManifestValidationError(`stopAfter "${stopAfter}" not in stages`);

  const currentStage = raw.currentStage ?? stages[0];
  if (!stages.includes(currentStage)) throw new ManifestValidationError(`currentStage "${currentStage}" not in stages`);
  if (stages.indexOf(currentStage) > stages.indexOf(stopAfter)) {
    throw new ManifestValidationError(`currentStage "${currentStage}" is past stopAfter "${stopAfter}"`);
  }
  // continuation lineage 校验：带 parentRunId 的 manifest（/audit next 产物）
  // 必须从父链已完成阶段的下一阶段开始，且不得回退到更早阶段。
  if (raw.parentRunId != null) {
    const completed = raw.completedStages ?? [];
    const lastDone = completed.at(-1);
    if (lastDone == null) {
      throw new ManifestValidationError('continuation requires at least one completed stage in completedStages');
    }
    if (stages.indexOf(currentStage) !== stages.indexOf(lastDone) + 1) {
      throw new ManifestValidationError(
        `continuation currentStage "${currentStage}" must be the stage immediately after the last completed stage "${lastDone}"`,
      );
    }
  }

  const startingCommit = req('startingCommit');
  if (!isNonEmptyStr(startingCommit)) throw new ManifestValidationError('startingCommit must be a non-empty string');

  const goal = req('goal');
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new ManifestValidationError('goal must be a non-empty string (frozen task book reference)');
  }
  const approvedPlan = raw.approvedPlan ?? goal;
  if (typeof approvedPlan !== 'string' || approvedPlan.trim() === '') {
    throw new ManifestValidationError('approvedPlan must be a non-empty string');
  }

  const arr = (v, field) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.some((x) => !isNonEmptyStr(x))) {
      throw new ManifestValidationError(`${field} must be an array of non-empty strings`);
    }
    return [...v];
  };

  const ts = now();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    hostId: raw.hostId,
    chatId: raw.chatId ?? null,
    observerSessionId: raw.observerSessionId ?? null,
    dshSessionId: raw.dshSessionId ?? null,
    cwd: raw.cwd,

    goal,
    approvedPlan,
    taskPacketHash: raw.taskPacketHash ?? null,
    stageRequirements: raw.stageRequirements ?? null,
    // 2026-09-30：stageGates/preauthorization 已随人工授权门删除；旧 run
    // manifest 里的同名字段加载时被显式忽略（不再进内存 manifest）。
    stages: [...stages],
    currentStage,
    stopAfter,

    // v0.4 continuation lineage：/audit next 创建的 run 继承父 run 的任务链。
    // parentRunId = 直接父 run；rootRunId = 链首（自身为链首时等于 runId）；
    // completedStages = 父链已 APPROVE 的阶段（含父 run 的 stopAfter）。
    parentRunId: raw.parentRunId ?? null,
    rootRunId: raw.rootRunId ?? raw.runId,
    completedStages: arr(raw.completedStages, 'completedStages'),

    // v0.3：GitHub 审计事实源。
    repo: raw.repo,
    branch: raw.branch,
    startingCommit,
    stageBaseCommit: raw.stageBaseCommit ?? startingCommit,
    auditedCommits: arr(raw.auditedCommits, 'auditedCommits'),

    ignorePaths: arr(raw.ignorePaths, 'ignorePaths'), // v0.2 §7.3

    createdAt: ts,
    updatedAt: ts,
  };
}

/** 从持久化 JSON 重建 manifest（reload 路径）：结构与 v0.3 冻结字段全量校验。 */
export function loadManifest(obj, now = Date.now) {
  if (obj?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestValidationError(`unsupported schemaVersion: ${obj?.schemaVersion}`);
  }
  const m = createManifest(obj, now);
  // 保留持久化时间戳（createManifest 会重写 createdAt/updatedAt）。
  m.createdAt = obj.createdAt;
  m.updatedAt = obj.updatedAt;
  return m;
}

/**
 * /audit until X（v0.2 §6.2 竞态规则）：
 *  - X 必须 ∈ stages；
 *  - index(X) >= index(currentStage)，否则拒绝（目标早于当前阶段无定义语义）；
 *  - X == stopAfter：幂等成功，无变更；
 *  - 其余：更新 stopAfter 与 updatedAt。
 * @returns {{manifest: object, changed: boolean}}
 */
export function changeStopAfter(manifest, target, now = Date.now) {
  if (!manifest.stages.includes(target)) {
    throw new ManifestValidationError(`until target "${target}" not in stages`);
  }
  const cur = manifest.stages.indexOf(manifest.currentStage);
  const tgt = manifest.stages.indexOf(target);
  if (tgt < cur) {
    throw new ManifestValidationError(
      `until target "${target}" is before currentStage "${manifest.currentStage}" — rejected (v0.2 §6.2)`);
  }
  if (target === manifest.stopAfter) return { manifest, changed: false };
  const next = { ...manifest, stopAfter: target, updatedAt: now() };
  return { manifest: next, changed: true };
}
