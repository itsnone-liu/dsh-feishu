#!/usr/bin/env node
// A5 live 冒烟测试 —— 默认跳过；显式开启：
//   DSH_AUDIT_LIVE_WEB=1 node test/audit/web-runner-live.test.mjs
// 前置：headroom(:8787) 在跑且 ~/.codex/auth.json 为有效 ChatGPT 登录态。
// 本测试只验证「真实网页额度链路能吐出符合冻结协议的 verdict」，
// 不触碰任何 audit run / orchestration。
import assert from 'node:assert';
import { WebAuditRunner } from '../../src/audit/web-runner.js';
import { buildVerdictText } from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });

if (process.env.DSH_AUDIT_LIVE_WEB !== '1') {
  console.log('SKIP live web smoke (set DSH_AUDIT_LIVE_WEB=1 to enable)');
  process.exit(0);
}

const packet = {
  runId: `live-smoke-${Date.now()}`, hostId: process.env.HOST_ID ?? 'live',
  stage: 'T1', iteration: 1,
  repo: 'github.com/itsnone-liu/dsh-feishu', branch: 'main',
  targetCommit: process.env.DSH_AUDIT_LIVE_COMMIT ?? '711eb29',
  baseCommit: '222b800',
  goal: ['A5 live smoke: verify the web quota chain returns a frozen-protocol verdict'],
  stageRequirement: ['Return APPROVE with a one-line SUMMARY; this is a transport smoke, not a real review.'],
};

await ok('real web chain returns a parseable frozen-protocol verdict', async () => {
  const r = new WebAuditRunner({});
  const v = await r.review(packet);
  console.log(`  state=${v.state} stage=${v.stage} iteration=${v.iteration} summary=${JSON.stringify(v.summary?.[0] ?? null)}`);
  assert.equal(v.runId, packet.runId, 'verdict must echo the packet RUN_ID (identity is kernel-validated)');
  assert.equal(v.stage, packet.stage);
  assert.ok(['APPROVE', 'REVISE', 'NEED_USER'].includes(v.state));
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
