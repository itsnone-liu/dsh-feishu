/**
 * audit/preauth-store.js — [PREAUTH v1] 预授权登记 append-only 存储（P-A 批次）。
 *
 * 设计来源：audit-reviews/20260929/PREAUTH_DESIGN.md §1（约束集）/§2（数据模型与不变量）。
 * 目录布局（§2）：<storeRoot>/preauth/records.jsonl（与 runs 平级）。
 *
 * 语义对齐 src/audit/store.js 的 verdicts 文件实现：
 *  - append-only；末行写一半（crash 窗口）读取时容忍截断；中间坏行 = 损坏 fail loud
 *    （StoreCorruptionError，不猜、不清空、不静默重建）；
 *  - 读后逐行做完整记录 schema 校验（不只 JSON 可解析），存前/读后对称；
 *  - 全部方法同步 fs；无凭据落盘（G10）。
 *
 * 消费/撤销的 append-only 落盘机制（§2 记录含 consumedAt/revokedAt 字段）：
 *  - markConsumed/revoke 追加同 preauthId 的「覆盖行」（全量记录 + 状态字段），
 *    读取按行序归并，后行覆盖前行；
 *  - 归并时强制不变量：绑定字段（gateKind/stage/hash/constraints/runScope/…）跨行必须
 *    逐字一致（JSON 序列比较），consumedAt/revokedAt 只允许 null→值 单调转移一次；
 *    任何回退/改写 = 外部篡改 → StoreCorruptionError（I1/I4 的盘级防线）。
 *
 * 不变量落点（§2，I1-I8 全集见设计文档；本文件覆盖存储层可执行部分）：
 *  - I1 单次消费：consumedAt 非空后再 markConsumed → PreauthAlreadyConsumed（含重启后，
 *    状态从盘归并，不依赖内存）；
 *  - I3/I4：findEligible 只返回 stage+gateKind+rootRunId 匹配且未消费/未撤销/未过期的候选；
 *    markConsumed 对已撤销/已过期记录 fail loud（撤销即时生效：登记处同进程写盘）；
 *  - I2/I5/I6/I8 的 hash 比对、上游链核验、git blob 溯源、失配事件属 P-B 门位消费算法；
 *  - I7 执行器无登记权：写路径（append/markConsumed/revoke）只允许 router/commands
 *    （人类消息驱动）调用；executor/lifecycle 侧只应使用只读方法（list/findEligible/get）。
 *    该约束在 P-C 接线层强制，本模块无法自证调用方身份。
 *
 * 设计留白处的实现约定（详见批次完成报告）：
 *  - CONSTRAINT 登记无显式时间窗（§4 话术未含）→ append 时默认 createdAt+24h（§1“默认 24h”）；
 *  - EXACT 的 expiresAt 必填且不得早于当前时刻（登记即过期属输入错误，fail loud）；
 *  - receiptSource 在 §2 示例（path/fromCommitBlob）之上补 commit 字段——I6 溯源必须
 *    知道从哪个已推送提交取 blob；
 *  - 溯源锚点 chatId/messageRef/humanText 必填（I6）；taskPacketHash 可空（P-C 补）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuditError, StoreCorruptionError } from './errors.js';

/** §1：上限时间窗默认 24h（可调）。 */
export const DEFAULT_PREAUTH_EXPIRY_MS = 24 * 60 * 60 * 1000;

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_64_RE = /^(?:[0-9a-f]{64}|[0-9a-f]{40})$/;
const GATE_KIND_RE = /^[A-Z][A-Z0-9_]*$/;
const STAGE_RE = /^[A-Z][A-Z0-9]*$/;
const PA_ID_RE = /^pa_[0-9]+_[0-9a-f]{8,}$/;
const BINDINGS = ['EXACT', 'CONSTRAINT'];

const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

/** 记录的不可变字段：跨覆盖行必须逐字一致（篡改检测）。 */
const IMMUTABLE_FIELDS = [
  'binding', 'gateKind', 'stage', 'receiptHash', 'constraints',
  'runScope', 'chatId', 'messageRef', 'humanText', 'taskPacketHash',
  'createdAt', 'expiresAt',
];

// ---------- 错误类型（新增文件，不改 errors.js；code 风格对齐 AuditError 家族） ----------

/** 预授权输入/记录结构非法。 */
export class PreauthValidationError extends AuditError {
  constructor(message, detail = {}) {
    super('AUDIT_PREAUTH_INVALID', message);
    this.detail = detail;
  }
}

/** preauthId 不存在。 */
export class PreauthNotFoundError extends AuditError {
  constructor(preauthId) {
    super('AUDIT_PREAUTH_NOT_FOUND', `preauth ${preauthId} not found`);
    this.preauthId = preauthId;
  }
}

/** I1 单次消费：已消费记录的再消费尝试（幂等拒绝，含重启后）。 */
export class PreauthAlreadyConsumedError extends AuditError {
  constructor(record) {
    super('AUDIT_PREAUTH_CONSUMED',
      `preauth ${record.preauthId} already consumed at ${record.consumedAt} by `
      + `${record.consumedBy?.runId ?? '?'} (I1 single-use; no further consumption)`);
    this.preauthId = record.preauthId;
    this.consumedAt = record.consumedAt;
    this.consumedBy = record.consumedBy;
  }
}

/** I4：消费已撤销的预授权（撤销即时生效）。 */
export class PreauthRevokedError extends AuditError {
  constructor(record) {
    super('AUDIT_PREAUTH_REVOKED',
      `preauth ${record.preauthId} revoked at ${record.revokedAt}; cannot consume (I4)`);
    this.preauthId = record.preauthId;
    this.revokedAt = record.revokedAt;
  }
}

/** I4：消费已过期的预授权。 */
export class PreauthExpiredError extends AuditError {
  constructor(record, now) {
    super('AUDIT_PREAUTH_EXPIRED',
      `preauth ${record.preauthId} expired at ${record.expiresAt} (now ${now}); cannot consume (I4)`);
    this.preauthId = record.preauthId;
    this.expiresAt = record.expiresAt;
    this.now = now;
  }
}

// ---------- 内部校验助手 ----------

/** consumedBy 形状校验：{runId, stage, ordinal>=1, receiptHash<64hex>}，键集封闭，hex 归一小写。 */
function validateConsumedBy(cb) {
  const bad = (msg) => { throw new PreauthValidationError(`consumedBy ${msg}`); };
  if (cb == null || typeof cb !== 'object' || Array.isArray(cb)) bad('must be {runId, stage, ordinal, receiptHash}');
  const keys = Object.keys(cb);
  for (const k of ['runId', 'stage', 'ordinal', 'receiptHash']) {
    if (!Object.prototype.hasOwnProperty.call(cb, k)) bad(`missing field ${k}`);
  }
  for (const k of keys) if (!['runId', 'stage', 'ordinal', 'receiptHash'].includes(k)) bad(`unknown field "${k}"`);
  if (!nonEmptyStr(cb.runId)) bad('runId must be a non-empty string');
  if (!nonEmptyStr(cb.stage)) bad('stage must be a non-empty string');
  if (!Number.isInteger(cb.ordinal) || cb.ordinal < 1) bad(`ordinal must be an integer >= 1, got ${JSON.stringify(cb.ordinal)}`);
  if (typeof cb.receiptHash !== 'string' || !HEX64_RE.test(cb.receiptHash)) bad('receiptHash must be lowercase 64-hex');
  return { runId: cb.runId, stage: cb.stage, ordinal: cb.ordinal, receiptHash: cb.receiptHash };
}

/** constraints 形状校验（CONSTRAINT 必填；键集封闭，对齐 §2 记录 + commit 补字段）。 */
function validateConstraints(c) {
  const bad = (msg) => { throw new PreauthValidationError(`constraints ${msg}`); };
  if (c == null || typeof c !== 'object' || Array.isArray(c)) bad('must be an object');
  for (const k of Object.keys(c)) if (!['maxOrdinal', 'upstream', 'receiptSource'].includes(k)) bad(`unknown field "${k}"`);
  if (!Number.isInteger(c.maxOrdinal) || c.maxOrdinal < 1) {
    bad(`maxOrdinal must be an integer >= 1, got ${JSON.stringify(c.maxOrdinal)}`);
  }
  if (!Array.isArray(c.upstream) || c.upstream.length === 0) bad('upstream must be a non-empty array');
  c.upstream.forEach((u, i) => {
    if (u == null || typeof u !== 'object' || Array.isArray(u)) bad(`upstream[${i}] must be an object`);
    for (const k of Object.keys(u)) if (!['gateKind', 'stage', 'receiptHash'].includes(k)) bad(`upstream[${i}] unknown field "${k}"`);
    if (typeof u.gateKind !== 'string' || !GATE_KIND_RE.test(u.gateKind)) bad(`upstream[${i}].gateKind must be UPPER_IDENT`);
    if (typeof u.stage !== 'string' || !STAGE_RE.test(u.stage)) bad(`upstream[${i}].stage must be UPPER stage token`);
    if (typeof u.receiptHash !== 'string' || !HEX64_RE.test(u.receiptHash)) bad(`upstream[${i}].receiptHash must be lowercase 64-hex`);
  });
  const rs = c.receiptSource;
  if (rs == null || typeof rs !== 'object' || Array.isArray(rs)) bad('receiptSource must be an object');
  for (const k of Object.keys(rs)) if (!['path', 'commit', 'fromCommitBlob'].includes(k)) bad(`receiptSource unknown field "${k}"`);
  if (!nonEmptyStr(rs.path) || /\s/.test(rs.path)) bad('receiptSource.path must be a whitespace-free non-empty string');
  if (typeof rs.commit !== 'string' || !HEX40_64_RE.test(rs.commit)) bad('receiptSource.commit must be lowercase 40/64-hex');
  if (rs.fromCommitBlob !== true) bad('receiptSource.fromCommitBlob must be true');
  return true;
}

// ---------- PreauthStore ----------

export class PreauthStore {
  /**
   * @param {string} storeRoot audit 数据根目录（与 AuditStore 同一根；生产：$DSH_HOME/feishu/audit）
   * @param {{now?: () => number}} [opts] 可注入时钟（测试确定性）
   */
  constructor(storeRoot, { now = Date.now } = {}) {
    if (!nonEmptyStr(storeRoot)) throw new PreauthValidationError('PreauthStore: storeRoot directory required');
    this.root = storeRoot;
    this.now = now;
  }

  #recordsFile() { return path.join(this.root, 'preauth', 'records.jsonl'); }

  #appendLine(record) {
    const file = this.#recordsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  }

  /**
   * 追加一条新登记（I7：仅 router/commands 调用）。生成 preauthId/createdAt；
   * expiresAt 缺省 = createdAt + 24h（§1）；存前过完整 schema 校验（与读后对称）。
   * @param {object} input 解析产物（parsePreauthText）+ 溯源上下文
   *   {chatId, messageRef, humanText, binding, gateKind, stage,
   *    receiptHash|constraints, expiresAt?, runScope{rootRunId, repo?, branch?}, taskPacketHash?}
   * @returns {object} 落盘记录（副本）
   */
  append(input) {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      throw new PreauthValidationError('append: input must be an object');
    }
    const ALLOWED = new Set([
      'chatId', 'messageRef', 'humanText', 'binding', 'gateKind', 'stage',
      'receiptHash', 'constraints', 'expiresAt', 'runScope', 'taskPacketHash',
    ]);
    for (const k of Object.keys(input)) {
      if (!ALLOWED.has(k)) throw new PreauthValidationError(`append: unknown input field "${k}"`);
    }
    if (input.preauthId !== undefined) {
      throw new PreauthValidationError('append: preauthId is store-generated; caller must not supply it');
    }
    if (input.consumedAt !== undefined || input.revokedAt !== undefined || input.consumedBy !== undefined) {
      throw new PreauthValidationError('append: fresh record cannot carry consumedAt/consumedBy/revokedAt');
    }

    const createdAt = this.now();
    // 绑定形态互斥字段显式拒绝（不静默丢弃：登记输入与绑定形态矛盾=输入错误）
    if (input.binding === 'EXACT' && input.constraints != null) {
      throw new PreauthValidationError('append: EXACT binding must not carry constraints');
    }
    if (input.binding === 'CONSTRAINT' && input.receiptHash != null) {
      throw new PreauthValidationError('append: CONSTRAINT binding must not carry receiptHash');
    }
    let expiresAt;
    if (input.expiresAt == null) {
      expiresAt = createdAt + DEFAULT_PREAUTH_EXPIRY_MS; // §1 默认 24h（CONSTRAINT 话术无时间窗）
    } else if (Number.isFinite(input.expiresAt) && input.expiresAt >= createdAt) {
      expiresAt = input.expiresAt;
    } else {
      throw new PreauthValidationError(
        `append: expiresAt must be a finite number >= now (${createdAt}), got ${JSON.stringify(input.expiresAt)}`,
      );
    }

    const rs = input.runScope;
    if (rs == null || typeof rs !== 'object' || Array.isArray(rs)) {
      throw new PreauthValidationError('append: runScope{rootRunId} required (I3 scope binding)');
    }
    for (const k of Object.keys(rs)) if (!['rootRunId', 'repo', 'branch'].includes(k)) {
      throw new PreauthValidationError(`append: runScope unknown field "${k}"`);
    }

    const record = {
      preauthId: `pa_${createdAt}_${randomBytes(4).toString('hex')}`,
      chatId: input.chatId,
      messageRef: input.messageRef,
      humanText: input.humanText,
      binding: input.binding,
      gateKind: input.gateKind,
      stage: input.stage,
      ...(input.binding === 'EXACT' ? { receiptHash: input.receiptHash } : { constraints: input.constraints }),
      runScope: { rootRunId: rs.rootRunId, repo: rs.repo ?? null, branch: rs.branch ?? null },
      taskPacketHash: input.taskPacketHash ?? null,
      createdAt,
      expiresAt,
      consumedAt: null,
      consumedBy: null,
      revokedAt: null,
    };
    PreauthStore.validatePersistedRecord(record);
    this.#appendLine(record);
    return { ...record };
  }

  /**
   * 读取全部登记（按 preauthId 归并为最新状态，时间序不保证；findEligible 自排序）。
   * @param {object|function|null} filter 对象=浅相等子集匹配；函数=谓词；null=全部
   */
  list(filter = null) {
    const records = this.#readAll().records;
    if (filter == null) return records;
    if (typeof filter === 'function') return records.filter(filter);
    if (typeof filter !== 'object') {
      throw new PreauthValidationError('list: filter must be an object (subset match) or a predicate function');
    }
    const entries = Object.entries(filter);
    return records.filter((r) => entries.every(([k, v]) => r[k] === v));
  }

  /** 按 preauthId 取最新状态；不存在 → null。 */
  get(preauthId) {
    if (!nonEmptyStr(preauthId)) throw new PreauthValidationError('get: preauthId required');
    return this.list().find((r) => r.preauthId === preauthId) ?? null;
  }

  #resolve(preauthId) {
    const rec = this.get(preauthId);
    if (!rec) throw new PreauthNotFoundError(preauthId);
    return rec;
  }

  /**
   * I1 单次消费：写 consumedAt+consumedBy（追加覆盖行）。已消费 → PreauthAlreadyConsumed；
   * 已撤销/已过期 → fail loud（I4）。重启后从盘归并，同样生效。
   * @param {string} preauthId
   * @param {{runId:string, stage:string, ordinal:number, receiptHash:string}} consumedBy
   * @returns {object} 消费后的记录（副本）
   */
  markConsumed(preauthId, consumedBy) {
    const cb = validateConsumedBy(consumedBy);
    const rec = this.#resolve(preauthId);
    if (rec.consumedAt != null) throw new PreauthAlreadyConsumedError(rec);
    if (rec.revokedAt != null) throw new PreauthRevokedError(rec);
    const now = this.now();
    if (rec.expiresAt <= now) throw new PreauthExpiredError(rec, now);
    const updated = { ...rec, consumedAt: now, consumedBy: cb };
    PreauthStore.validatePersistedRecord(updated);
    this.#appendLine(updated);
    return updated;
  }

  /**
   * 撤销（§4 /audit preauth revoke；I4 即时生效——登记处同进程写盘）。
   * 幂等：重复撤销不报错、不追加新行。撤销已消费的记录不回滚消费（I1 不变量优先）。
   * @returns {{record: object, revoked: boolean}} revoked=false 表示此前已撤销（本次无操作）
   */
  revoke(preauthId) {
    const rec = this.#resolve(preauthId);
    if (rec.revokedAt != null) return { record: rec, revoked: false };
    const updated = { ...rec, revokedAt: this.now() };
    PreauthStore.validatePersistedRecord(updated);
    this.#appendLine(updated);
    return { record: updated, revoked: true };
  }

  /**
   * 门位候选查询（§3 步骤 2）：stage+gateKind+rootRunId 匹配且未消费/未撤销/未过期的记录，
   * 按 createdAt 升序（先登记先候选）。hash 比对/上游链核验在 P-B 门位算法做（I2/I5/I6）。
   * @param {{stage:string, gateKind:string, rootRunId:string, now?:number}} q
   */
  findEligible({ stage, gateKind, rootRunId, now } = {}) {
    if (!nonEmptyStr(stage) || !nonEmptyStr(gateKind) || !nonEmptyStr(rootRunId)) {
      throw new PreauthValidationError('findEligible requires {stage, gateKind, rootRunId}');
    }
    if (now != null && !Number.isFinite(now)) {
      throw new PreauthValidationError(`findEligible: now must be a finite number, got ${JSON.stringify(now)}`);
    }
    const t = now ?? this.now();
    const s = stage.toUpperCase();
    const g = gateKind.toUpperCase();
    return this.list()
      .filter((r) => r.stage === s && r.gateKind === g
        && r.runScope.rootRunId === rootRunId
        && r.consumedAt == null && r.revokedAt == null && r.expiresAt > t)
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.preauthId < b.preauthId ? -1 : 1));
  }

  // ---------- 读取（损坏语义对齐 store.js verdicts/events） ----------

  /**
   * 持久化记录 schema 校验（存前 append 与读后 #readAll 共用，对称）。
   * @throws {PreauthValidationError}
   */
  static validatePersistedRecord(rec) {
    const bad = (msg) => { throw new PreauthValidationError(`record schema: ${msg}`); };
    if (rec == null || typeof rec !== 'object' || Array.isArray(rec)) bad('must be an object');
    if (typeof rec.preauthId !== 'string' || !PA_ID_RE.test(rec.preauthId)) {
      bad(`preauthId "${rec.preauthId}" malformed (expect pa_<ts>_<rand>)`);
    }
    for (const f of ['chatId', 'messageRef', 'humanText']) {
      if (!nonEmptyStr(rec[f])) bad(`${f} must be a non-empty string (provenance anchor, §2/I6)`);
    }
    if (!BINDINGS.includes(rec.binding)) bad(`binding must be one of ${BINDINGS.join('|')}, got ${JSON.stringify(rec.binding)}`);
    if (typeof rec.gateKind !== 'string' || !GATE_KIND_RE.test(rec.gateKind)) bad('gateKind must be UPPER_IDENT (e.g. SEAL_ANNOTATION_ONLY)');
    if (typeof rec.stage !== 'string' || !STAGE_RE.test(rec.stage)) bad('stage must be an UPPER stage token (e.g. B4)');
    const rs = rec.runScope;
    if (rs == null || typeof rs !== 'object' || Array.isArray(rs)) bad('runScope must be an object');
    if (!nonEmptyStr(rs.rootRunId)) bad('runScope.rootRunId must be a non-empty string (I3)');
    if (rs.repo != null && !nonEmptyStr(rs.repo)) bad('runScope.repo must be a non-empty string or null');
    if (rs.branch != null && !nonEmptyStr(rs.branch)) bad('runScope.branch must be a non-empty string or null');
    if (rec.taskPacketHash != null && !nonEmptyStr(rec.taskPacketHash)) bad('taskPacketHash must be a non-empty string or null');
    for (const f of ['createdAt', 'expiresAt']) {
      if (!Number.isFinite(rec[f])) bad(`${f} must be a finite number`);
    }
    if (rec.expiresAt < rec.createdAt) bad(`expiresAt (${rec.expiresAt}) < createdAt (${rec.createdAt})`);
    if (rec.consumedAt != null && !Number.isFinite(rec.consumedAt)) bad('consumedAt must be a finite number or null');
    if (rec.revokedAt != null && !Number.isFinite(rec.revokedAt)) bad('revokedAt must be a finite number or null');
    if (rec.consumedAt != null) validateConsumedBy(rec.consumedBy);
    else if (rec.consumedBy != null) bad('consumedBy must be null while consumedAt is null');

    if (rec.binding === 'EXACT') {
      if (typeof rec.receiptHash !== 'string' || !HEX64_RE.test(rec.receiptHash)) {
        bad('EXACT requires receiptHash as lowercase 64-hex (I2)');
      }
      if (rec.constraints != null) bad('EXACT must not carry constraints');
    } else {
      if (rec.receiptHash != null) bad('CONSTRAINT must not carry receiptHash');
      validateConstraints(rec.constraints);
    }
    return true;
  }

  /**
   * 读盘：逐行 JSON.parse + schema 校验；末行不完整容忍截断；中间坏行 fail loud。
   * 按 preauthId 归并（后行覆盖前行），并强制跨行不变量（不可变字段一致、
   * consumedAt/revokedAt 单调一次性转移）——违反 = StoreCorruptionError。
   */
  #readAll() {
    const file = this.#recordsFile();
    if (!fs.existsSync(file)) return { records: [], truncated: false };
    const raw = fs.readFileSync(file, 'utf8');
    if (raw === '') return { records: [], truncated: false };
    const lines = raw.split('\n');
    // append 写入永远以 \n 结尾；不以 \n 结尾 = 最后一行写了一半（crash 窗口），容忍截断。
    const truncated = !raw.endsWith('\n');
    if (truncated) lines.pop();
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln === '') continue;
      let obj;
      try {
        obj = JSON.parse(ln);
      } catch {
        throw new StoreCorruptionError(file, `corrupt preauth line ${i + 1} (not the trailing partial line)`);
      }
      try {
        PreauthStore.validatePersistedRecord(obj);
      } catch (e) {
        throw new StoreCorruptionError(file, `preauth line ${i + 1} fails record schema: ${e.message}`);
      }
      entries.push(obj);
    }
    const byId = new Map();
    for (const e of entries) {
      const prev = byId.get(e.preauthId);
      if (prev) {
        for (const f of IMMUTABLE_FIELDS) {
          if (JSON.stringify(prev[f]) !== JSON.stringify(e[f])) {
            throw new StoreCorruptionError(file,
              `preauth ${e.preauthId}: immutable field "${f}" diverges across appended lines (tampering?)`);
          }
        }
        if (prev.consumedAt != null && e.consumedAt == null) {
          throw new StoreCorruptionError(file, `preauth ${e.preauthId}: consumedAt disappears in a later line (un-consume tampering)`);
        }
        if (prev.consumedAt != null && e.consumedAt !== prev.consumedAt) {
          throw new StoreCorruptionError(file, `preauth ${e.preauthId}: consumedAt rewritten across lines`);
        }
        if (prev.revokedAt != null && e.revokedAt == null) {
          throw new StoreCorruptionError(file, `preauth ${e.preauthId}: revokedAt disappears in a later line`);
        }
        if (prev.revokedAt != null && e.revokedAt !== prev.revokedAt) {
          throw new StoreCorruptionError(file, `preauth ${e.preauthId}: revokedAt rewritten across lines`);
        }
      }
      byId.set(e.preauthId, e);
    }
    return { records: [...byId.values()], truncated };
  }
}
