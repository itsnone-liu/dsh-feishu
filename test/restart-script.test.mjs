#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildWindowsRestartScript } from '../src/commands.js';

const runBridge = 'D:\\dsh-install\\run_bridge.ps1';
const launcher = runBridge;
const logFile = 'C:\\Users\\pc\\.dsh\\feishu\\restart.log';
const script = buildWindowsRestartScript({
  pid: 12345,
  stamp: '2026-09-20T00:00:00.000Z',
  launcher,
  runBridge,
  logFile,
});

assert.match(script, /run_bridge\.ps1/);
assert.doesNotMatch(script, /&\s+'[^']*start_bridge\.ps1'/i, 'must never execute legacy start_bridge fallback');
assert.doesNotMatch(script, /falling back to direct/i, 'must fail closed instead of direct launch');
assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
assert.match(script, /WorkingDirectory 'D:\\dsh-install'/);
assert.match(script, /-NoProfile -ExecutionPolicy Bypass -File/);
assert.match(script, /exit 2/);
assert.match(script, /exit 3/);
assert.match(script, /exit 4/);
assert.match(script, /exit 5/);
assert.match(script, /bridge up/);
assert.match(script, /ws client ready/);
assert.match(script, /TotalSeconds -ge 3/);
assert.match(script, /Select-Object -Last 1/);
assert.match(script, /dsh-feishu\\\\node_modules/);
assert.match(script, /schtasks \/Run \/TN 'dsh-feishu-bridge'/);

if (process.platform === 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-script-'));
  const file = path.join(dir, 'restart-now.ps1');
  fs.writeFileSync(file, script, 'ascii');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}`,
    ], { stdio: 'inherit' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('PASS restart script is fail-closed and PowerShell-valid');
