#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AuditStore } from '../../src/audit/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-process-'));
const child = spawn(process.execPath, ['test/audit/process-recovery-child.mjs', root, 'audit_process_sim'], { cwd: process.cwd(), stdio: 'ignore' });
const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
assert.equal(code, 23);
const store = new AuditStore(root);
const incidents = store.listRecoveryIncidents('audit_process_sim');
assert.equal(incidents.length, 1);
assert.equal(incidents[0].incident.trigger, 'PROCESS_EXIT_SIMULATION');
assert.throws(() => store.loadRun('audit_process_sim'), /store corrupted/, 'incomplete simulated run is detected loudly');
console.log('PASS process death writes durable incident and fresh process reads it');
