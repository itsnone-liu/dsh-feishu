#!/usr/bin/env node
import assert from 'node:assert';
import { FakeWebAuditRunner } from '../../src/audit/fake-web-audit-runner.js';
import { buildVerdictText } from '../../src/audit/protocol.js';
const v = (state) => buildVerdictText({ state, runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1 });
const calls = []; const runner = new FakeWebAuditRunner({ script: [{ text: 'bad' }, { text: v('APPROVE') }] });
const run = { s: { state: 'AUDITING', auditInFlight: { headCommit: 'a', stage: 'T1', iteration: 1 }, verdictRetries: 0 }, manifest: { hostId: 'h1', repo: 'r', branch: 'main', goal: 'g', stageRequirements: { T1: 'req' } }, verdictMissing() { this.s.verdictRetries++; calls.push('missing'); return this.s.verdictRetries === 1 ? { retry: true } : { failed: true }; } };
const packet = { runId: 'r1', hostId: 'h1', stage: 'T1', iteration: 1, targetCommit: 'a', baseCommit: 'b', repo: 'r', branch: 'main', goal: 'g', stageRequirement: 'req' };
let first; try { first = await runner.review(packet); } catch (e) { assert.equal(e.code, 'AUDIT_VERDICT_MALFORMED'); }
assert.equal(calls.length, 0); assert.equal(first, undefined);
const second = await runner.review(packet); assert.equal(second.state, 'APPROVE');
console.log('PASS reviewer malformed output is available for lifecycle verdictMissing retry');
