/** A3 frozen task packet loader. The packet is explicit input, never inferred. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_TASK_PACKET = '.dsh-audit-task.json';

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
  return {
    ...packet,
    stages: packet.stages.map((s) => s.id),
    stageRequirements: Object.fromEntries(packet.stages.map((s) => [s.id, s.requirements])),
    taskPacketHash: crypto.createHash('sha256').update(canonical).digest('hex'),
    path: packetPath,
  };
}
