/**
 * audit/protocol.js — [DSH-AUDIT] 冻结协议：严格逐行解析器与构造器。
 *
 * 冻结语义（docs/AUDIT-MODE-DESIGN.md v0.3 §9/§10/§11/§15）：
 *  - marker 块必须以独立的 [DSH-AUDIT] 行开始，块体延伸到文本末尾；
 *  - 头段为连续 `KEY: value` 行，键白名单封闭，缺必填键=解析失败，不补默认值；
 *  - 禁止宽松正则全文搜索、禁止从普通 prose 推断 APPROVE；
 *  - 身份四元组 HOST_ID/RUN_ID/STAGE/ITERATION 任一不匹配 → fail closed。
 *
 * 本文件是纯函数模块：无 IO、无时钟、无状态。
 */
import { ProtocolParseError, IdentityMismatchError } from './errors.js';

export const MARKER_TAG = '[DSH-AUDIT]';
export const HANDOFF_TAG = '[DSH-AUDIT HANDOFF]';

export const EXECUTOR_MARKER_STATES = ['READY_FOR_AUDIT'];
export const VERDICT_STATES = ['APPROVE', 'REVISE', 'NEED_USER'];

/** 头段键白名单（封闭集合）。 */
const HEADER_KEYS = new Set(['STATE', 'RUN_ID', 'STAGE', 'ITERATION', 'HEAD', 'HOST_ID']);
/** 段落键白名单（封闭集合）。 */
const SECTION_KEYS = new Set([
  'SUMMARY', 'TESTS', 'EVIDENCE', 'RESIDUAL_RISKS',
  'P0', 'P1', 'TESTS_REQUIRED', 'REASON', 'QUESTION',
]);
/** 头段必填键（executor 与 auditor 共同要求；HEAD 仅 executor 必填）。 */
const REQUIRED_COMMON = ['STATE', 'RUN_ID', 'STAGE', 'ITERATION'];

const KEY_LINE_RE = /^([A-Z][A-Z0-9_]*):(?:.*)$/;

/**
 * 解析一个 [DSH-AUDIT] 块。任何不符合冻结格式的情况都抛 ProtocolParseError —— 永不返回半成品。
 * @param {string} text 完整消息文本
 * @param {{allowedStates:string[], requireHead:boolean}} opts
 * @returns {{state:string, runId:string, stage:string, iteration:number, head?:string,
 *            hostId?:string|null, sections:Record<string,string[]>}}
 */
export function parseAuditBlock(text, opts) {
  const { allowedStates, requireHead } = opts;
  if (typeof text !== 'string' || text.length === 0) {
    throw new ProtocolParseError('empty message');
  }
  const lines = text.split('\n');

  // 1. 定位 marker 行：严格全等（trim 后），恰好一个。
  const tagIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === MARKER_TAG) tagIdx.push(i);
  }
  if (tagIdx.length === 0) throw new ProtocolParseError(`missing ${MARKER_TAG} block`, { text: text.slice(0, 80) });
  if (tagIdx.length > 1) throw new ProtocolParseError(`ambiguous: ${tagIdx.length} ${MARKER_TAG} blocks`, { positions: tagIdx });

  const body = lines.slice(tagIdx[0] + 1);

  // 2. 头段：连续 HEADER_KEYS 键行；遇到非头段键行（含段落键）即转入段落区。
  const headers = new Map();
  let i = 0;
  for (; i < body.length; i++) {
    const ln = body[i];
    if (ln.trim() === '') continue; // 头段内允许空行分隔
    const m = KEY_LINE_RE.exec(ln);
    if (!m) break; // 头段结束，进入段落区
    const key = m[1];
    if (!HEADER_KEYS.has(key)) break; // 段落键或其他行：头段结束
    if (headers.has(key)) {
      throw new ProtocolParseError(`duplicate header key ${key}`, { line: ln });
    }
    const value = ln.slice(key.length + 1).trim();
    if (value === '') throw new ProtocolParseError(`empty value for ${key}`, { line: ln });
    headers.set(key, value);
  }

  // 3. 必填键检查（缺字段=失败，绝不补默认值）。
  for (const k of REQUIRED_COMMON) {
    if (!headers.has(k)) throw new ProtocolParseError(`missing required key ${k}`);
  }
  if (requireHead && !headers.has('HEAD')) throw new ProtocolParseError('missing required key HEAD');

  const state = headers.get('STATE');
  if (!allowedStates.includes(state)) {
    throw new ProtocolParseError(`STATE ${state} not in [${allowedStates.join('|')}]`, { state });
  }

  const iterationRaw = headers.get('ITERATION');
  if (!/^[1-9][0-9]*$/.test(iterationRaw)) {
    throw new ProtocolParseError(`ITERATION must be a positive integer, got "${iterationRaw}"`);
  }

  // 4. 段落区：SECTION: 行开启段落，后续行（任何内容）归入该段落直到下一个段落键。
  const sections = {};
  let current = null;
  for (; i < body.length; i++) {
    const ln = body[i];
    const m = KEY_LINE_RE.exec(ln);
    if (m && SECTION_KEYS.has(m[1])) {
      current = m[1];
      if (sections[current]) throw new ProtocolParseError(`duplicate section ${current}`);
      sections[current] = [];
      const inline = ln.slice(current.length + 1).trim();
      if (inline) sections[current].push(inline);
    } else if (m && HEADER_KEYS.has(m[1])) {
      // 段落区出现头段键 = 结构错误（头段必须在最前且连续）。
      throw new ProtocolParseError(`header key ${m[1]} appears after sections`, { line: ln });
    } else if (current) {
      const t = ln.trim();
      if (t !== '') sections[current].push(t);
    } else if (ln.trim() !== '') {
      throw new ProtocolParseError(`stray line outside any section: "${ln.trim()}"`, { line: ln });
    }
  }

  return {
    state,
    runId: headers.get('RUN_ID'),
    stage: headers.get('STAGE'),
    iteration: Number(iterationRaw),
    head: headers.has('HEAD') ? headers.get('HEAD') : undefined,
    hostId: headers.has('HOST_ID') ? headers.get('HOST_ID') : null,
    sections,
  };
}

/** 解析 DSH executor 的 READY_FOR_AUDIT marker（§9）。HEAD 必填。 */
export function parseExecutorMarker(text) {
  const b = parseAuditBlock(text, { allowedStates: EXECUTOR_MARKER_STATES, requireHead: true });
  return {
    state: b.state,
    runId: b.runId,
    stage: b.stage,
    iteration: b.iteration,
    head: b.head,
    hostId: b.hostId,
    summary: b.sections.SUMMARY ?? null,
    tests: b.sections.TESTS ?? null,
  };
}

/** 解析 Web GPT 审核结论（§10）。STATE ∈ APPROVE|REVISE|NEED_USER。 */
export function parseAuditorVerdict(text) {
  const b = parseAuditBlock(text, { allowedStates: VERDICT_STATES, requireHead: false });
  return {
    state: b.state,
    runId: b.runId,
    stage: b.stage,
    iteration: b.iteration,
    hostId: b.hostId,
    summary: b.sections.SUMMARY ?? null,
    evidence: b.sections.EVIDENCE ?? null,
    residualRisks: b.sections.RESIDUAL_RISKS ?? null,
    p0: b.sections.P0 ?? [],
    p1: b.sections.P1 ?? [],
    testsRequired: b.sections.TESTS_REQUIRED ?? [],
    reason: b.sections.REASON ?? null,
    question: b.sections.QUESTION ?? null,
  };
}

/**
 * 身份校验（§11.1 / G3，A1.1 收紧）：claimed 必须匹配 expected。
 * runId/stage/iteration 总是比较。
 * hostId（A1.1 P0-1 fail-closed）：expected 提供时（正式 manifest 必填 hostId，
 * 因此正式 executor marker / auditor verdict 全部受此约束），claimed 缺失或不一致
 * 都抛 AUDIT_IDENTITY_MISMATCH —— 防止漏带 HOST_ID 的 verdict 串入其他 host 的 run。
 * @throws {IdentityMismatchError}
 */
export function validateIdentity(expected, claimed) {
  if (expected.hostId != null && claimed.hostId == null) {
    throw new IdentityMismatchError('HOST_ID', expected.hostId, null);
  }
  const pairs = [
    ['RUN_ID', expected.runId, claimed.runId],
    ['STAGE', expected.stage, claimed.stage],
    ['ITERATION', expected.iteration, claimed.iteration],
  ];
  if (expected.hostId != null) {
    pairs.push(['HOST_ID', expected.hostId, claimed.hostId]);
  }
  for (const [field, exp, got] of pairs) {
    if (String(exp) !== String(got)) {
      throw new IdentityMismatchError(field, exp, got);
    }
  }
  return true;
}

/** 构造 executor marker 文本（fake runner / 测试使用，保证与解析器双向一致）。 */
export function buildExecutorMarkerText(f) {
  const out = [MARKER_TAG,
    `STATE: READY_FOR_AUDIT`,
    `RUN_ID: ${f.runId}`,
    f.hostId ? `HOST_ID: ${f.hostId}` : null,
    `STAGE: ${f.stage}`,
    `ITERATION: ${f.iteration}`,
    `HEAD: ${f.head}`,
  ].filter(Boolean);
  if (f.summary?.length) { out.push('SUMMARY:'); out.push(...f.summary); }
  if (f.tests?.length) { out.push('TESTS:'); out.push(...f.tests); }
  return out.join('\n');
}

/**
 * A5.4 executor stage prompt 携带的 marker 模板（真实 E2E 前的已知接线缺口修复）。
 * 字段顺序/格式与 buildExecutorMarkerText 双向一致；RUN_ID/HOST_ID/STAGE/ITERATION
 * 填入当前 run 的真实值，HEAD 为占位符（executor 填其新创建 commit 的哈希）。
 * SUMMARY/TESTS 为可选段（缺省也合法）。
 */
export function executorMarkerTemplate(f) {
  const out = [MARKER_TAG,
    `STATE: READY_FOR_AUDIT`,
    `RUN_ID: ${f.runId}`,
    f.hostId ? `HOST_ID: ${f.hostId}` : null,
    `STAGE: ${f.stage}`,
    `ITERATION: ${f.iteration}`,
    `HEAD: <本阶段新创建 commit 的完整哈希>`,
  ].filter(Boolean);
  out.push('SUMMARY: <可选：一行本阶段完成内容>');
  out.push('TESTS: <可选：一行测试结果>');
  return out.join('\n');
}

/** 构造 auditor verdict 文本。 */
export function buildVerdictText(f) {
  const out = [MARKER_TAG,
    `STATE: ${f.state}`,
    `RUN_ID: ${f.runId}`,
    f.hostId ? `HOST_ID: ${f.hostId}` : null,
    `STAGE: ${f.stage}`,
    `ITERATION: ${f.iteration}`,
  ].filter(Boolean);
  const sec = (key, lines) => { if (lines?.length) { out.push(`${key}:`); out.push(...lines); } };
  sec('SUMMARY', f.summary);
  sec('EVIDENCE', f.evidence);
  sec('RESIDUAL_RISKS', f.residualRisks);
  sec('P0', f.p0);
  sec('P1', f.p1);
  sec('TESTS_REQUIRED', f.testsRequired);
  sec('REASON', f.reason);
  sec('QUESTION', f.question);
  return out.join('\n');
}

/**
 * 构造审核 handoff 文本（§15 / v0.3：审计事实源 = GitHub @ TARGET_COMMIT）。
 */
export function buildHandoff(f) {
  return [
    HANDOFF_TAG,
    '',
    `RUN_ID: ${f.runId}`,
    `HOST_ID: ${f.hostId}`,
    `STAGE: ${f.stage}`,
    `ITERATION: ${f.iteration}`,
    '',
    `REPO: ${f.repo}`,
    `BRANCH: ${f.branch}`,
    `TARGET_COMMIT: ${f.targetCommit}`,
    '',
    'ORIGINAL_GOAL:',
    ...(Array.isArray(f.goal) ? f.goal : [f.goal ?? '...']),
    '',
    'FROZEN_STAGE_REQUIREMENTS:',
    ...(Array.isArray(f.stageRequirements) ? f.stageRequirements : [f.stageRequirement ?? f.stageRequirements ?? '...']),
    '',
    'COMPLETED:',
    ...(f.completed ?? ['...']),
    '',
    `BASE_COMMIT: ${f.baseCommit}`,
    '',
    'INSTRUCTION:',
    'Independently inspect the GitHub repo at TARGET_COMMIT',
    '(diff BASE_COMMIT..TARGET_COMMIT, files, committed test reports).',
    'Do not trust executor claims.',
    'Return APPROVE / REVISE / NEED_USER.',
  ].join('\n');
}
