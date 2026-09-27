/**
 * audit/errors.js — Audit Mode 错误类型。
 *
 * 所有错误都带稳定 code，调用方按 code 分类处理（v0.2 §14）：
 * fail-closed（不猜、不静默重试）是唯一默认行为。
 *
 * DesignConflictError 专用：当实现过程中发现冻结设计（docs/AUDIT-MODE-DESIGN.md v0.2）
 * 存在无法实现或内部矛盾时，停止并抛出该错误——不得自行改语义。
 */

export class AuditError extends Error {
  /** @param {string} code 稳定错误码 @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** marker / verdict 文本不符合冻结协议（缺字段、非法枚举、重复块、未知键）。 */
export class ProtocolParseError extends AuditError {
  constructor(message, detail = {}) {
    super('AUDIT_PROTOCOL_PARSE', message);
    this.detail = detail;
  }
}

/** 身份四元组（HOST_ID/RUN_ID/STAGE/ITERATION）任一不匹配。 */
export class IdentityMismatchError extends AuditError {
  constructor(field, expected, claimed) {
    super('AUDIT_IDENTITY_MISMATCH', `identity mismatch on ${field}: expected ${JSON.stringify(expected)}, claimed ${JSON.stringify(claimed)}`);
    this.field = field;
    this.expected = expected;
    this.claimed = claimed;
  }
}

/** 状态机收到当前状态下不合法的转移。 */
export class IllegalTransitionError extends AuditError {
  constructor(from, to, reason = '') {
    super('AUDIT_ILLEGAL_TRANSITION', `illegal transition ${from} -> ${to}${reason ? ` (${reason})` : ''}`);
    this.from = from;
    this.to = to;
  }
}

/** manifest 输入不满足 §7 冻结结构。 */
export class ManifestValidationError extends AuditError {
  constructor(message, detail = {}) {
    super('AUDIT_MANIFEST_INVALID', message);
    this.detail = detail;
  }
}

/** 持久化文件损坏（JSON parse 失败、结构缺失）。fail loud：不猜、不清空。 */
export class StoreCorruptionError extends AuditError {
  constructor(file, cause) {
    super('AUDIT_STORE_CORRUPTION', `store corrupted: ${file} (${cause})`);
    this.file = file;
    this.cause = cause;
  }
}

/** 对 terminal run 的继续推进尝试（幂等拒绝，不产生副作用）。 */
export class FrozenStateException extends AuditError {
  constructor(runId, state) {
    super('AUDIT_RUN_FROZEN', `run ${runId} is terminal (${state}); no further transitions`);
    this.runId = runId;
    this.runState = state;
  }
}

/** 冻结设计存在无法实现或自相矛盾之处 —— 停止并上报，不得自行改语义。 */
export class DesignConflictError extends AuditError {
  constructor(conflict) {
    super('AUDIT_DESIGN_CONFLICT', `frozen design conflict: ${conflict}`);
    this.conflict = conflict;
  }
}
