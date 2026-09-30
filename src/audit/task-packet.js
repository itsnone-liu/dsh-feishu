/** A3 frozen task packet loader. The packet is explicit input, never inferred. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_TASK_PACKET = '.dsh-audit-task.json';

// 2026-09-30 业主指令（纯无人值守）：任务书 preauthorization 节解析
//（deriveStageGates）已随人工授权门整体删除。任务书若仍携带该节会被
// 加载层显式剔除——门位声明不再有任何效果。

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
  const { preauthorization, ...packetRest } = packet; // eslint-disable-line no-unused-vars
  return {
    ...packetRest,
    stages: stageIds,
    stageRequirements: Object.fromEntries(packet.stages.map((s) => [s.id, s.requirements])),
    taskPacketHash: crypto.createHash('sha256').update(canonical).digest('hex'),
    path: packetPath,
  };
}
