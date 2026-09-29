/** A3 frozen task packet loader. The packet is explicit input, never inferred. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_TASK_PACKET = '.dsh-audit-task.json';

/** P-B：preauthorization 节允许的门型（与 protocol.APPROVAL_PHRASES 对齐）。 */
const GATE_KINDS = new Set(['SEAL', 'REVEAL']);
const BINDING_MODES = new Set(['EXACT', 'CONSTRAINT']);

/**
 * P-B 门位通用化：解析可选 `preauthorization` 节（PREAUTH v1 §5 任务书修订）并派生
 * `stageGates: { <STAGE>: { kind, gateKind, bindings } }`。缺省（节不存在）返回 {}，
 * 行为与现在完全一致（无任何人闸声明，executor 不注入人闸流程）。
 * 校验 fail-closed：version 必须 1；gates 的 stage 必须在 stages[].id 中；
 * binding 非空且 ∈ {EXACT, CONSTRAINT}；kind ∈ {SEAL, REVEAL}（默认 SEAL）；
 * maxOrdinal（可选）为 >=1 整数；defaultExpiryH（可选）为 >0 数。
 * @throws {AUDIT_TASK_PACKET_INVALID}
 */
function deriveStageGates(packet, stageIds) {
  const pre = packet.preauthorization;
  if (pre == null) return { stageGates: {}, preauthorization: null };
  const bad = (why) => {
    throw Object.assign(new Error(`task packet preauthorization invalid: ${why}`), { code: 'AUDIT_TASK_PACKET_INVALID' });
  };
  if (typeof pre !== 'object' || Array.isArray(pre)) bad('must be an object');
  if (pre.version !== 1) bad(`version must be 1, got ${JSON.stringify(pre.version)}`);
  if (pre.gates == null || typeof pre.gates !== 'object' || Array.isArray(pre.gates)) bad('gates must be an object keyed by stage');
  const idSet = new Set(stageIds);
  const stageGates = {};
  for (const [stage, g] of Object.entries(pre.gates)) {
    if (!/^[A-Z][A-Z0-9]*$/.test(stage) || !idSet.has(stage)) bad(`gate stage "${stage}" not in stages [${stageIds.join(',')}]`);
    if (g == null || typeof g !== 'object' || Array.isArray(g)) bad(`gates.${stage} must be an object`);
    const bindings = g.binding ?? ['EXACT'];
    if (!Array.isArray(bindings) || bindings.length === 0 || bindings.some((b) => !BINDING_MODES.has(b))) {
      bad(`gates.${stage}.binding must be a non-empty array of EXACT|CONSTRAINT`);
    }
    const kind = g.kind ?? 'SEAL';
    if (!GATE_KINDS.has(kind)) bad(`gates.${stage}.kind must be SEAL|REVEAL, got ${JSON.stringify(kind)}`);
    if (g.maxOrdinal != null && (!Number.isInteger(g.maxOrdinal) || g.maxOrdinal < 1)) bad(`gates.${stage}.maxOrdinal must be an integer >= 1`);
    if (g.defaultExpiryH != null && !(Number(g.defaultExpiryH) > 0)) bad(`gates.${stage}.defaultExpiryH must be > 0`);
    stageGates[stage] = { kind, bindings: [...bindings] };
  }
  return { stageGates, preauthorization: { ...pre, gates: { ...pre.gates } } };
}

export function loadTaskPacket(cwd, file = DEFAULT_TASK_PACKET) {
  const packetPath = path.isAbsolute(file) ? file : path.join(cwd, file);
  let packet;
  try { packet = JSON.parse(fs.readFileSync(packetPath, 'utf8')); }
  catch (e) { throw Object.assign(new Error(`frozen task packet unavailable: ${packetPath}`), { code: 'AUDIT_TASK_PACKET_REQUIRED', cause: e }); }
  if (!packet || typeof packet.goal !== 'string' || !packet.goal.trim()
      || typeof packet.approvedPlan !== 'string' || !packet.approvedPlan.trim()
      || !Array.isArray(packet.stages) || packet.stages.length === 0
      || packet.stages.some((s) => typeof s !== 'object' || !s.id || typeof s.requirements !== 'string')) {
    throw Object.assign(new Error('frozen task packet must contain goal, approvedPlan and stages[{id,requirements}]'), { code: 'AUDIT_TASK_PACKET_INVALID' });
  }
  const canonical = JSON.stringify(packet);
  const stageIds = packet.stages.map((s) => String(s.id));
  const { stageGates, preauthorization } = deriveStageGates(packet, stageIds);
  return {
    ...packet,
    stages: stageIds,
    stageRequirements: Object.fromEntries(packet.stages.map((s) => [s.id, s.requirements])),
    // P-B：派生字段不参与 taskPacketHash（hash 计算于原始 packet，见上）。
    stageGates,
    preauthorization,
    taskPacketHash: crypto.createHash('sha256').update(canonical).digest('hex'),
    path: packetPath,
  };
}
