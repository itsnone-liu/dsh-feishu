// 复现 T2 迭代2 的评审请求（只读，不触状态机）：拿原始回复诊断解析失败根因。
import { readFileSync } from 'node:fs';
import { WebAuditRunner } from '../src/audit/web-runner.js';
import { GitEvidenceProvider } from '../src/audit/git-evidence.js';
import { parseAuditorVerdict } from '../src/audit/protocol.js';

const manifest = JSON.parse(readFileSync('/root/.dsh/feishu/audit/runs/audit_20260928055411432/manifest.json', 'utf8'));
const state = JSON.parse(readFileSync('/root/.dsh/feishu/audit/runs/audit_20260928055411432/state.json', 'utf8'));

const packet = {
  runId: manifest.runId,
  hostId: manifest.hostId,
  stage: 'T2',
  iteration: 2,
  repo: manifest.repo,
  branch: manifest.branch,
  targetCommit: state.auditInFlight.headCommit,
  baseCommit: state.stageBaseCommit,
  goal: manifest.goal,
  stageRequirement: manifest.stageRequirements?.T2 ?? null,
};

const runner = new WebAuditRunner({
  baseUrl: 'http://127.0.0.1:8787',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  timeoutMs: 300_000,
  transientRetries: 0,
  evidence: {
    provider: new GitEvidenceProvider(),
    resolve: async () => ({ cwd: manifest.cwd, repo: manifest.repo, branch: manifest.branch }),
  },
  rawDumpDirFor: () => '/tmp/audit-repro',
});

console.log(`packet: stage=${packet.stage} iter=${packet.iteration} target=${packet.targetCommit.slice(0, 8)} base=${packet.baseCommit.slice(0, 8)}`);
try {
  const v = await runner.review(packet);
  console.log('PARSE OK →', v.state);
  console.log('p0:', JSON.stringify(v.p0));
} catch (e) {
  console.log('FAILED code=', e.code, 'msg=', e.message);
  if (e.cause) console.log('cause:', e.cause.message, JSON.stringify(e.cause.details ?? ''));
}
