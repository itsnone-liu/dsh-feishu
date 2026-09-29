import fs from 'node:fs';
import { AuditStore } from '../../src/audit/store.js';

const root = process.argv[2];
const runId = process.argv[3] ?? 'audit_process_sim';
const store = new AuditStore(root);
fs.mkdirSync(`${root}/runs/${runId}`, { recursive: true });
const incident = {
  incidentId: `${runId}:process-death`, runId, trigger: 'PROCESS_EXIT_SIMULATION',
  state: 'AUDITING', currentStage: 'T1', detail: { pid: process.pid },
};
store.appendRecoveryIncident({ runId, incident });
store.appendEvent({ runId, stage: 'T1', iteration: 1, headCommit: 'a'.repeat(40), event: 'AUDIT_PROCESS_DIED', timestamp: Date.now(), elapsedMs: null, dedupeKey: `${runId}|process-death` });
process.exit(23);
