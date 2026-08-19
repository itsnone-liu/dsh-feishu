#!/usr/bin/env node
/**
 * REAL-agent offline scenario (no mockAgent):
 *
 * phase 1 — boot the real profile; /new creates a real agent (no LLM needed),
 *           one message drives a model request which MUST fail offline
 *           (bounded retries) → error turn card; session persists to disk.
 * phase 2 — fresh process; /resume rebinds via ctx.agents.resume over the
 *           REAL persistence layer (no LLM involved in resume itself).
 *
 * This validates the production driver paths that the mock scenario cannot:
 * agents.create with setup(), real loop request-failure turns, disk layout,
 * cross-process resume.
 *
 * Usage: node test/scenario-real.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const DSH_BIN =
  process.env.DSH_BIN ||
  `${process.env.HOME}/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js`;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feishu-real-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'ws');
fs.mkdirSync(workspace, { recursive: true });

const setup = spawnSync('bash', [path.join(REPO, 'scripts/setup-profile.sh')], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
});
if (setup.status !== 0) {
  console.error(setup.stderr);
  process.exit(1);
}

fs.mkdirSync(path.join(home, 'feishu'), { recursive: true });
fs.writeFileSync(
  path.join(home, 'feishu', 'config.json'),
  JSON.stringify({
    transport: 'mock',
    mockAgent: false,
    allowedOpenIds: ['ou_mock_me'],
    defaultCwd: workspace,
    allowedWorkspaces: [workspace],
    agentPreset: 'minimal',
    approval: 'never',
    throttleMs: 60,
  }, null, 1)
);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

const md = (item) => JSON.stringify(item.card ?? {}) + JSON.stringify(item.text ?? '');

function runPhase(label, scriptSteps, tailWait) {
  const scriptFile = path.join(sandbox, `${label}-script.json`);
  const outFile = path.join(sandbox, `${label}-out.json`);
  fs.writeFileSync(scriptFile, JSON.stringify(scriptSteps));
  const run = spawnSync('node', [DSH_BIN, '--profile', 'feishu'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 150_000,
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: 'sk-offline-test',
      DSH_FEISHU_SCRIPT: scriptFile,
      DSH_FEISHU_OUT: outFile,
      DSH_FEISHU_TAIL_WAIT: String(tailWait),
      DSH_FEISHU_LOG: 'info',
    },
  });
  fs.writeFileSync(path.join(sandbox, `${label}-boot.log`), (run.stdout || '') + (run.stderr || ''));
  if (!fs.existsSync(outFile)) {
    console.error(`phase ${label}: no output (exit=${run.status} signal=${run.signal})`);
    console.error(((run.stdout || '') + (run.stderr || '')).split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

// ------------------------------------------------------------------ phase 1
const p1 = runPhase('p1', [
  { text: '/new' },
  { wait: 500 },
  // blank real session → REAL recompose path (agentPresets service + live ctx)
  { text: '/preset standard' },
  { wait: 800 },
  // real selection-object model switch (provider route check, no network)
  { text: '/model deepseek-official/deepseek-v4-pro' },
  { wait: 500 },
  { text: 'hi, this must fail offline' },
  { wait: 20000 }, // request + bounded retries + turn close
  { text: '/status' },
  { wait: 500 },
], 2000);

const p1cards = p1.filter((x) => x.kind === 'card');
check('p1: /new created a real agent', p1cards.some((c) => md(c).includes('新会话已就绪')));
check('p1: real blank-session preset recompose', p1cards.some((c) => (c.card?.header?.title?.content ?? '') === '预设已切换' && md(c).includes('standard')));
check('p1: real model switch (selection object)', p1cards.some((c) => (c.card?.header?.title?.content ?? '') === '模型已切换' && md(c).includes('deepseek-v4-pro')));
check('p1: request failure → error turn card', p1cards.some((c) => (c.card?.header?.title?.content ?? '').startsWith('✗')));
check('p1: session persisted to real disk', (() => {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return false;
  for (const proj of fs.readdirSync(root)) {
    for (const id of fs.readdirSync(path.join(root, proj))) {
      if (fs.existsSync(path.join(root, proj, id, 'session.jsonl.zstd'))) return true;
    }
  }
  return false;
})());

const bindings = JSON.parse(fs.readFileSync(path.join(home, 'feishu', 'bindings.json'), 'utf8'));
const bound = Object.values(bindings)[0];
check('p1: binding points at persisted session', Boolean(bound?.sessionId));

// ------------------------------------------------------------------ phase 2
const p2 = runPhase('p2', [
  { resumeFromBindings: 0 },
  { wait: 1200 },
  { text: '/status' },
  { wait: 500 },
], 1500);

const p2cards = p2.filter((x) => x.kind === 'card');
check('p2: cross-process resume succeeded', p2cards.some((c) => md(c).includes('已接续会话')));
check('p2: status shows resumed session', p2cards.some((c) => md(c).includes('桥状态')));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
console.log(`sandbox: ${sandbox}`);
process.exit(failed.length ? 1 : 0);
