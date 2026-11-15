#!/usr/bin/env node
/**
 * Offline end-to-end for the voice ingress.
 *
 * Boots the REAL bridge profile in a sandbox $DSH_HOME with transport=mock and
 * mockAgent, enables config.voice, then drives it exclusively through the unix
 * socket — no Feishu, no dsh model calls, nothing touched in production.
 *
 * What this proves that the unit tests cannot:
 *   - the socket really comes up inside the live bridge process;
 *   - `router.onMessage` accepts our synthetic message (openId whitelist!);
 *   - the fake agent's REAL session events reach voice_in and come back as
 *     deltas, with reasoning filtered out;
 *   - `turn/end` closes the exchange.
 *
 * Usage: node test/voice_scenario.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const DSH_BIN = process.env.DSH_BIN || '/opt/dsh-021/node_modules/.bin/dsh';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-e2e-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'ws');
const sockPath = path.join(sandbox, 'voice.sock');
const outFile = path.join(sandbox, 'out.json');
fs.mkdirSync(workspace, { recursive: true });

// Copy the *production* profile: it is the one known to boot against this dsh
// build. The repo's profile/ template still points at @deepseek-ai/dsh-agent-presets
// rc.8, which 0.2.1 refuses to load.
const prodProfile = path.join(os.homedir(), '.dsh', 'profiles', 'feishu');
fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
spawnSync('cp', ['-a', prodProfile, path.join(home, 'profiles', 'feishu')]);


// The sandbox profile resolves @deepseek-ai/* through $DSH_HOME/profiles/
// node_modules, which production has installed (202 packages) but a fresh
// sandbox does not. Point the sandbox at the same flat module dir instead of
// installing anything: offline, and identical resolution to production.
const prodModules = path.join(os.homedir(), '.dsh', 'profiles', 'node_modules');
if (fs.existsSync(prodModules)) {
  const link = path.join(home, 'profiles', 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(prodModules, link, 'dir');
}

fs.mkdirSync(path.join(home, 'feishu'), { recursive: true });
fs.writeFileSync(
  path.join(home, 'feishu', 'config.json'),
  JSON.stringify({
    transport: 'mock',
    mockAgent: true,
    allowedOpenIds: ['ou_mock_me'],
    defaultCwd: workspace,
    allowedWorkspaces: [workspace],
    agentPreset: 'minimal',
    approval: 'cards',
    voice: { enabled: true, chatId: 'chat-voice-e2e', socketPath: sockPath },
  }, null, 1),
);
// the mock transport wants a script; we drive everything through the socket
const scriptFile = path.join(sandbox, 'script.json');
fs.writeFileSync(scriptFile, JSON.stringify([{ wait: 30_000 }]));

const child = spawn(DSH_BIN, ['--profile', 'feishu'], {
  cwd: workspace,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_FEISHU_SCRIPT: scriptFile,
    DSH_FEISHU_OUT: outFile,
    DSH_FEISHU_MOCK_DELTA_MS: '5',
    DSH_FEISHU_LOG: 'debug',
  },
});
let bootLog = '';
child.stdout.on('data', (d) => (bootLog += d));
child.stderr.on('data', (d) => (bootLog += d));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSocket(ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(sockPath)) return true;
    await sleep(100);
  }
  return false;
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath, () => resolve(sock));
    sock.on('error', reject);
  });
}

async function main() {
  const up = await waitForSocket();
  check('voice socket appeared inside the live bridge', up,
        up ? sockPath : bootLog.split('\n').slice(-12).join('\n'));
  if (!up) return;

  const sock = await connectOnce();
  const messages = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });

  const ask = '你好，语音通道';
  sock.write(JSON.stringify({ id: 1, op: 'ask', text: ask }) + '\n');

  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (messages.some((m) => m.type === 'done' || m.type === 'error')) break;
    await sleep(50);
  }

  const ack = messages.find((m) => m.type === 'ack');
  const deltas = messages.filter((m) => m.type === 'delta').map((m) => m.text).join('');
  const done = messages.find((m) => m.type === 'done');
  const err = messages.find((m) => m.type === 'error');

  check('ask was acknowledged', Boolean(ack), JSON.stringify(messages.slice(0, 3)));
  // A brand-new chat has no binding until driver.ensure runs, so the ack may
  // legitimately carry sessionId:null; the turn still streams (that is the
  // authoritative proof). A bound chat (production) does return the id.
  check('ack is usable (session id present, or a fresh chat still streamed)',
        Boolean(ack) && (Boolean(ack.sessionId) || deltas.length > 0),
        JSON.stringify(ack));
  check('text deltas streamed', deltas.length > 0, JSON.stringify(messages.slice(0, 6)));
  check('the answer is the agent\'s own text', deltas.includes('收到：'), deltaPreview(deltas));
  check('reasoning never leaked into the stream', !deltas.includes('让我想想'), deltaPreview(deltas));
  check('the turn closed with done', Boolean(done), JSON.stringify(messages.slice(-3)));
  check('no error on the wire', !err, JSON.stringify(err));

  console.log('\n--- deltas as received ---');
  console.log(JSON.stringify(deltas));

  sock.destroy();
}

function deltaPreview(s) {
  return s ? `got ${JSON.stringify(s.slice(0, 80))}` : 'got nothing';
}

try {
  await main();
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  fs.writeFileSync(path.join(sandbox, 'boot.log'), bootLog);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`sandbox: ${sandbox}`);
  process.exit(failed.length ? 1 : 0);
}