#!/usr/bin/env node
import assert from 'node:assert';
import { FakeWebAuditRunner } from '../../src/audit/fake-web-audit-runner.js';
import { buildVerdictText } from '../../src/audit/protocol.js';
let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });
const packet = { runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, targetCommit: 'a'.repeat(40) };
await ok('accepts fixed packet and returns strict structured verdict', async () => { const r = new FakeWebAuditRunner({ script: [{ text: buildVerdictText({ state: 'APPROVE', ...packet, hostId: 'h1' }) }] }); const v = await r.review(packet); assert.equal(v.state, 'APPROVE'); assert.equal(r.calls.length, 1); });
await ok('malformed and missing verdicts fail closed', async () => { await assert.rejects(() => new FakeWebAuditRunner({ script: [{ text: 'ship it' }] }).review(packet), (e) => e.code === 'AUDIT_VERDICT_MALFORMED'); await assert.rejects(() => new FakeWebAuditRunner().review(packet), (e) => e.code === 'AUDIT_REVIEWER_SCRIPT_EXHAUSTED'); });
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
