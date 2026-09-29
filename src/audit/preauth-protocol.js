/**
 * audit/preauth-protocol.js — [PREAUTH v1] 审计人闸预授权逐字话术解析器（P-A 批次）。
 *
 * 设计来源：audit-reviews/20260929/PREAUTH_DESIGN.md §1（绑定形态）/§4（登记话术）。
 * 职责边界（P-A）：只做「话术 → 结构化登记输入」的纯解析；落盘见 preauth-store.js；
 * 门位消费算法 / 命令面路由 / 任务书修订属 P-B/P-C。
 *
 * 冻结语义（与 protocol.js 的 SEAL_APPROVAL_RE 同级严格正则，版本化 PREAUTH v1）：
 *  - 仅接受 §4 两种逐字登记话术：改写、缺句、弱化限制句 = 解析失败（语义不宽容）；
 *  - 空白宽容：模板所有单元之间以 \s* 连接——空白可增、可删、可换行（飞书折行），
 *    但单元内部（gateKind / sha256 / hash / 命令 / 时间戳）不允许空白（空白语义漂移=失配）；
 *  - 标点（：；、。≤）是语义单元，逐字匹配（`<=` 不可替代 `≤`）；
 *  - gateKind 封闭枚举 {SEAL_ANNOTATION_ONLY, NEXT_REVEAL_ONLY}（§2 已知集；"..." 的
 *    扩展留给 P-B 门位通用化）。binding×gateKind 的组合策略由任务书
 *    preauthorization.gates 声明约束（§5），解析层不重复执行该策略；
 *  - 大小写对齐 SEAL_APPROVAL_RE 的 /i 惯例；差异点：sealApprovalHash 原样返回捕获，
 *    本模块在解析边界归一（gateKind/stage 大写、hex 小写）以便逐字节比较（I2/I3）。
 *
 * 设计文档留白处的实现约定（详见批次完成报告）：
 *  - <expiresAt> 文本格式未定义 → 带显式时区的 ISO-8601（2026-09-30T12:00:00+08:00；
 *    日期时间分隔符允许 T 或单个空格；时区必须 Z 或 ±HH:MM）；日历合法性逐字段校验
 *    （拒绝 02-30 / 25:00 / 非法偏移），解析为 epoch 毫秒；
 *  - CONSTRAINT 话术不含时间窗与 rootRunId（“本运行链”）→ 解析结果 expiresAt=null、
 *    runScope.rootRunId=null；默认 24h 窗（§1）与运行链绑定由登记命令层在 append 时补齐；
 *  - 上游 “SEAL receipt” 归一为 §2 记录形态的 SEAL_ANNOTATION_ONLY（书写允许 SEAL 或全称）。
 *
 * 本文件是纯函数模块：无 IO、无时钟、无状态（expiresAt 一律取自话术文本本身）。
 */
import { AuditError } from './errors.js';

export const PREAUTH_VERSION = 1;

/** §4 逐字模板（占位符原样保留）——解析失败时作为可复制模板回显卡片。 */
export const PREAUTH_TEMPLATE_EXACT =
  '我预授权 SEAL_ANNOTATION_ONLY 于阶段 B4：仅当运行链 <rootRunId> 在 <expiresAt> 前到达该门且门位 receipt sha256 精确等于 <64hex> 时放行一次；不授权其他 receipt、REVEAL、outcome 或 ordinal；可随时 /audit preauth revoke 撤销。';
export const PREAUTH_TEMPLATE_CONSTRAINT =
  '我预授权 NEXT_REVEAL_ONLY 于阶段 C2：仅当本运行链 B4 已按规通过且其 SEAL receipt sha256 精确等于 <64hex>、C2 ordinal ≤ 1、且门位 receipt 等于提交 <commit> 内 <path> 的 blob 时放行一次；不授权其他阶段、receipt 或 ordinal；可随时 /audit preauth revoke 撤销。';

/**
 * 话术解析失败（不匹配任一模板 / 字段值非法）。
 * `.template` 恒为可复制模板字符串（默认 EXACT 形态），供卡片回显；
 * `.detail` 携带机器可读原因（field/got/reason）。
 */
export class PreauthParseError extends AuditError {
  constructor(message, detail = {}) {
    super('AUDIT_PREAUTH_PARSE', message);
    this.detail = detail;
    this.template = typeof detail.template === 'string' ? detail.template : PREAUTH_TEMPLATE_EXACT;
  }
}

// ---------- 正则装配：空白宽容、语义不宽容 ----------

/** CJK 表意文字：逐字成单元（字间空白视为无义）。 */
const isCJK = (ch) => /[\u4e00-\u9fff]/.test(ch);
/** ASCII 词字符（标识符 / 命令 / sha256 等词的组成部分）：连续成词，词内禁空白。 */
const isWordChar = (ch) => /[A-Za-z0-9_./\-]/.test(ch);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把字面量文本切成正则单元：CJK 单字 / ASCII 连续词 / 标点单字（：；、。≤ 等）。
 * 模板中的空白不生成单元——所有单元之间一律 \s* 连接（空白可增删换行），
 * 语义由单元序列 + 标点逐字保证。
 */
function literalUnits(litText) {
  const units = [];
  let buf = '';
  const flush = () => { if (buf !== '') { units.push(escapeRe(buf)); buf = ''; } };
  for (const ch of litText) {
    if (/\s/.test(ch)) { flush(); continue; }
    if (isWordChar(ch)) { buf += ch; continue; }
    flush();
    units.push(escapeRe(ch));
  }
  flush();
  return units;
}

/**
 * 由模板骨架装配严格正则：parts 为字面量字符串与 {re} 捕获槽的序列，
 * 依序以 \s* 连接并锚定整段（^...$，先 trim）。
 */
function buildPattern(parts) {
  const units = [];
  for (const part of parts) {
    if (typeof part === 'string') units.push(...literalUnits(part));
    else units.push(part.re);
  }
  return new RegExp(`^${units.join('\\s*')}$`, 'i');
}

// <expiresAt>：带显式时区的 ISO-8601 瞬时（T 或单空格分隔；Z 或 ±HH:MM）。
const DATETIME_UNIT = String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})`;
/** 已知门位种类（§2 已知集；P-B 门位通用化时扩展）。 */
const GATE_KIND_ALT = 'SEAL_ANNOTATION_ONLY|NEXT_REVEAL_ONLY';

/**
 * EXACT 精确 hash 预授权话术（§4）。捕获：gateKind/stage/rootRunId/expiresAt/receiptHash。
 * 与 PREAUTH_TEMPLATE_EXACT 逐字同构（字面量 + 占位符 = 模板原文）。
 */
export const PREAUTH_RE_EXACT = buildPattern([
  '我预授权 ',
  { re: `(?<gateKind>${GATE_KIND_ALT})` },
  ' 于阶段 ',
  { re: String.raw`(?<stage>[A-Z][A-Z0-9]*)` },
  '：仅当运行链 ',
  { re: String.raw`(?<rootRunId>\S+)` },
  ' 在 ',
  { re: `(?<expiresAt>${DATETIME_UNIT})` },
  ' 前到达该门且门位 receipt sha256 精确等于 ',
  { re: String.raw`(?<receiptHash>[0-9a-f]{64})` },
  ' 时放行一次；不授权其他 receipt、REVEAL、outcome 或 ordinal；可随时 /audit preauth revoke 撤销。',
]);

/**
 * CONSTRAINT 可验证约束预授权话术（§4）。捕获：gateKind/stage/upstreamStage/
 * upstreamHash/stageRef/maxOrdinal/commit/path。
 * 上游门限定为 SEAL 门（§4 模板原文“其 SEAL receipt”；§2 记录示例 gateKind=
 * SEAL_ANNOTATION_ONLY），书写允许 SEAL 或全称，解析归一为 SEAL_ANNOTATION_ONLY。
 * 与 PREAUTH_TEMPLATE_CONSTRAINT 逐字同构。
 */
export const PREAUTH_RE_CONSTRAINT = buildPattern([
  '我预授权 ',
  { re: `(?<gateKind>${GATE_KIND_ALT})` },
  ' 于阶段 ',
  { re: String.raw`(?<stage>[A-Z][A-Z0-9]*)` },
  '：仅当本运行链 ',
  { re: String.raw`(?<upstreamStage>[A-Z][A-Z0-9]*)` },
  ' 已按规通过且其 ',
  { re: String.raw`(?:SEAL_ANNOTATION_ONLY|SEAL)` },
  ' receipt sha256 精确等于 ',
  { re: String.raw`(?<upstreamHash>[0-9a-f]{64})` },
  '、',
  { re: String.raw`(?<stageRef>[A-Z][A-Z0-9]*)` },
  ' ordinal ≤ ',
  { re: String.raw`(?<maxOrdinal>[0-9]+)` },
  '、且门位 receipt 等于提交 ',
  { re: String.raw`(?<commit>[0-9a-f]{64}|[0-9a-f]{40})` },
  ' 内 ',
  { re: String.raw`(?<path>\S+)` },
  ' 的 blob 时放行一次；不授权其他阶段、receipt 或 ordinal；可随时 /audit preauth revoke 撤销。',
]);

// ---------- <expiresAt> 严格解析 ----------

const DATETIME_FIELDS_RE = new RegExp(
  '^(?<Y>\\d{4})-(?<Mo>\\d{2})-(?<D>\\d{2})[T ](?<h>\\d{2}):(?<mi>\\d{2}):(?<s>\\d{2})'
  + '(?:Z|(?<sign>[+-])(?<oh>\\d{2}):(?<om>\\d{2}))$',
);

/**
 * 把话术中的时间戳解析为 epoch 毫秒。形状已由 DATETIME_UNIT 保证；
 * 这里做日历合法性（月/日含闰年、时/分/秒、时区偏移）与年份下界（>=1970）校验。
 * 非法 → null（调用方转 PreauthParseError）。
 */
function parsePreauthDatetime(raw) {
  const m = DATETIME_FIELDS_RE.exec(raw);
  if (!m) return null;
  const g = m.groups;
  const Y = Number(g.Y), Mo = Number(g.Mo), D = Number(g.D);
  const h = Number(g.h), mi = Number(g.mi), s = Number(g.s);
  if (Y < 1970) return null;
  if (Mo < 1 || Mo > 12) return null;
  const daysInMonth = new Date(Date.UTC(Y, Mo, 0)).getUTCDate(); // 闰年感知
  if (D < 1 || D > daysInMonth) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  let offsetMin = 0;
  if (g.sign) {
    const oh = Number(g.oh), om = Number(g.om);
    if (oh > 23 || om > 59) return null;
    offsetMin = (oh * 60 + om) * (g.sign === '+' ? 1 : -1);
  }
  return Date.UTC(Y, Mo - 1, D, h, mi, s) - offsetMin * 60000;
}

// ---------- 解析入口 ----------

/**
 * 解析 §4 逐字登记话术（先 trim；两个模板依次尝试）。
 *
 * EXACT → { binding:'EXACT', gateKind, stage, receiptHash, expiresAt:number(ms),
 *           runScope:{rootRunId} }
 * CONSTRAINT → { binding:'CONSTRAINT', gateKind, stage,
 *                constraints:{ maxOrdinal, upstream:[{gateKind,stage,receiptHash}],
 *                              receiptSource:{path, commit, fromCommitBlob:true} },
 *                expiresAt:null, runScope:{rootRunId:null} }
 *   （话术未含时间窗与运行链 id——由登记命令层补默认 24h 与当前运行链，见文件头注。）
 * 非适用字段键不出现（EXACT 无 constraints；CONSTRAINT 无 receiptHash），对齐 §2 记录形态。
 *
 * @param {string} text 完整消息文本
 * @returns 见上
 * @throws {PreauthParseError} 失配 / 字段值非法（.template 为可复制模板）
 */
export function parsePreauthText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PreauthParseError('preauth text is empty or not a string', { reason: 'EMPTY' });
  }
  const t = text.trim();

  let m = PREAUTH_RE_EXACT.exec(t);
  if (m) {
    const expiresAt = parsePreauthDatetime(m.groups.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new PreauthParseError(
        `expiresAt "${m.groups.expiresAt}" is not a calendar-valid ISO-8601 instant `
        + '(need valid date incl. leap years, 00-23h/00-59m/00-59s, explicit Z or ±HH:MM timezone)',
        { template: PREAUTH_TEMPLATE_EXACT, field: 'expiresAt', got: m.groups.expiresAt, reason: 'BAD_EXPIRES_AT' },
      );
    }
    return {
      binding: 'EXACT',
      gateKind: m.groups.gateKind.toUpperCase(),
      stage: m.groups.stage.toUpperCase(),
      receiptHash: m.groups.receiptHash.toLowerCase(),
      expiresAt,
      runScope: { rootRunId: m.groups.rootRunId },
    };
  }

  m = PREAUTH_RE_CONSTRAINT.exec(t);
  if (m) {
    const stage = m.groups.stage.toUpperCase();
    const stageRef = m.groups.stageRef.toUpperCase();
    if (stageRef !== stage) {
      throw new PreauthParseError(
        `ordinal clause stage "${stageRef}" != registered stage "${stage}"`,
        { template: PREAUTH_TEMPLATE_CONSTRAINT, field: 'stage', reason: 'STAGE_SELF_REF_MISMATCH' },
      );
    }
    const maxOrdinal = Number(m.groups.maxOrdinal);
    if (!Number.isInteger(maxOrdinal) || maxOrdinal < 1) {
      throw new PreauthParseError(
        `maxOrdinal must be an integer >= 1, got "${m.groups.maxOrdinal}"`,
        { template: PREAUTH_TEMPLATE_CONSTRAINT, field: 'maxOrdinal', reason: 'BAD_MAX_ORDINAL' },
      );
    }
    return {
      binding: 'CONSTRAINT',
      gateKind: m.groups.gateKind.toUpperCase(),
      stage,
      constraints: {
        maxOrdinal,
        upstream: [{
          gateKind: 'SEAL_ANNOTATION_ONLY', // §4 模板 “其 SEAL receipt” 的规范记录形态（§2 示例）
          stage: m.groups.upstreamStage.toUpperCase(),
          receiptHash: m.groups.upstreamHash.toLowerCase(),
        }],
        receiptSource: {
          path: m.groups.path,
          commit: m.groups.commit.toLowerCase(),
          fromCommitBlob: true, // §1：git object db 内已推送提交的 blob 取证
        },
      },
      expiresAt: null,
      runScope: { rootRunId: null },
    };
  }

  // 失配：附可复制模板（按内容嗅探更可能是哪种形态，降低复制错模板的概率）。
  const likelyConstraint = /提交|ordinal|blob/.test(t);
  throw new PreauthParseError(
    'text does not match any PREAUTH v1 verbatim registration phrase '
    + '(whitespace-lenient, semantics-strict; verbatim template required)',
    {
      template: likelyConstraint ? PREAUTH_TEMPLATE_CONSTRAINT : PREAUTH_TEMPLATE_EXACT,
      reason: 'MISMATCH',
    },
  );
}
