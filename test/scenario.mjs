#!/usr/bin/env node
/**
 * Offline end-to-end scenario for the feishu bridge.
 *
 * Boots the REAL dsh profile (base + bridge) in a sandbox $DSH_HOME with:
 *   - transport = mock (script-driven, writes every outbound card to JSON)
 *   - mockAgent = true (scripted agent over the REAL session event pipeline)
 *
 * Covers: streaming turn cards, tool rows, ask buttons, approval buttons,
 * steer-while-running, /stop cancellation, /new, /sessions, /resume,
 * error turns, whitelist fail-closed, bindings persistence.
 *
 * Usage: node test/scenario.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const DSH_BIN =
  process.env.DSH_BIN ||
  `${process.env.HOME}/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js`;

// ---------------------------------------------------------------- sandbox
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feishu-e2e-'));
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

// bridge config in the sandbox
fs.mkdirSync(path.join(home, 'feishu'), { recursive: true });
fs.writeFileSync(
  path.join(home, 'feishu', 'config.json'),
  JSON.stringify(
    {
      transport: 'mock',
      mockAgent: true,
      allowedOpenIds: ['ou_mock_me'],
      defaultCwd: workspace,
      allowedWorkspaces: [workspace],
      agentPreset: 'minimal',
      approval: 'cards',
      throttleMs: 40,
      askTimeoutMs: 0,
    },
    null,
    1
  )
);

// ---------------------------------------------------------------- script
const script = [
  { text: 'let me in', openId: 'ou_evil' }, // whitelist: dropped silently
  { wait: 200 },
  { text: '你好，桥通了吗' },
  { wait: 900 },
  { text: 'TOOL: 跑个工具' },
  { wait: 900 },
  { text: 'ASK: 问我一个问题' },
  { click: { bridge: 'ask', label: '选项B' } },
  { wait: 900 },
  { text: 'APPROVE: 需要审批' },
  { click: { bridge: 'approval', decision: 'allowed-once' } },
  { wait: 900 },
  { text: 'SLOW 慢慢来' },
  { wait: 500 },
  { text: '等等，先别动' }, // steer while running
  { wait: 2500 },
  { text: 'SLOW 再来一次这次要停' },
  { wait: 500 },
  { text: '/stop' },
  { wait: 900 },
  { text: '/new' },
  { wait: 300 },
  { text: '新会话第一条' },
  { wait: 900 },
  { text: '/status' },
  { wait: 300 },
  { text: '/sessions' },
  { wait: 400 },
  { resumeFromBindings: 0 }, // /resume the FIRST bound session
  { wait: 500 },
  { text: '/mode' },
  { wait: 400 },
  { text: '/mode ro' },
  { wait: 400 },
  { text: '/mode' },
  { wait: 400 },
  { text: '/mode full' },
  { wait: 400 },
  { text: '/mode bogus' },
  { wait: 400 },
  { text: 'ERR: 报个错' },
  { wait: 900 },
  { text: '/model' },
  { wait: 800 },
  { text: '/model deepseek-official/deepseek-v4-pro' },
  { wait: 400 },
  { text: '/model' },
  { wait: 800 },
  { text: '/model nosuch' },
  { wait: 900 },
  { text: '/preset' },
  { wait: 500 },
  { text: '/preset standard' },
  { wait: 600 },   // session has history (ERR turn) → fresh session card
  { text: '/preset' },
  { wait: 500 },
  { text: '/preset cordis' },
  { wait: 600 },   // the fresh session is BLANK → mock live-switch card
  { text: '/preset' },
  { wait: 500 },   // bare re-read must show cordis (event-backed)
  { text: '/preset bogus' },
  { wait: 500 },
];
const scriptFile = path.join(sandbox, 'script.json');
fs.writeFileSync(scriptFile, JSON.stringify(script));
const outFile = path.join(sandbox, 'out.json');

// ---------------------------------------------------------------- boot
const run = spawnSync('node', [DSH_BIN, '--profile', 'feishu'], {
  cwd: workspace,
  encoding: 'utf8',
  timeout: 120_000,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_FEISHU_SCRIPT: scriptFile,
    DSH_FEISHU_OUT: outFile,
    DSH_FEISHU_TAIL_WAIT: '1500',
    DSH_FEISHU_MOCK_DELTA_MS: '8',
    DSH_FEISHU_LOG: 'debug',
  },
});

const bootLog = (run.stdout || '') + (run.stderr || '');
fs.writeFileSync(path.join(sandbox, 'boot.log'), bootLog);
if (!fs.existsSync(outFile)) {
  console.error('=== boot log (tail) ===\n' + bootLog.split('\n').slice(-40).join('\n'));
  console.error(`exit=${run.status} signal=${run.signal}`);
  process.exit(1);
}

// ------------------------------------------------------------- assertions
const sent = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const cards = sent.filter((x) => x.kind === 'card');
const texts = sent.filter((x) => x.kind === 'text');
const md = (item) =>
  JSON.stringify(item.card ?? {})
    + JSON.stringify(item.text ?? '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

const turnFinal = (needle) =>
  cards.find((c) => (c.card?.header?.title?.content ?? '').startsWith('✓') && md(c).includes(needle));
const anyCard = (needle) => cards.find((c) => md(c).includes(needle));

check('turn card streams & finalizes', Boolean(turnFinal('收到：你好，桥通了吗')));
check('usage footer present', Boolean(turnFinal('收到：你好') && /tok/.test(turnFinal('收到：你好').card?.elements?.at(-1)?.elements?.[0]?.content ?? '')));
check('tool row rendered with result', Boolean(anyCard('🔧 `bash` ✅') && anyCard('echo hi')));
check('ask card + button answered', Boolean(anyCard('选项B') && turnFinal('ASK 回答') && /选项B/.test(md(turnFinal('ASK 回答')))));
check('approval allowed-once', Boolean(turnFinal('APPROVE 结果：allowed-once') && anyCard('已允许（本次）')));
check('steer note + steer step', Boolean(turnFinal('等等，先别动')));
check('stop cancels turn', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '').startsWith('⏹'))));
check('/new starts fresh session', Boolean(anyCard('新会话已就绪')));
check('second session works', Boolean(turnFinal('收到：新会话第一条')));
check('/status reflects binding', Boolean(anyCard('桥状态')));
check('/sessions lists', Boolean(anyCard('会话（')));
check('/resume rebinds', Boolean(anyCard('已接续会话')));
check('error turn renders', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '').startsWith('✗') && md(c).includes('MOCK_ERROR'))));
check('whitelist drops stranger', !cards.some((c) => md(c).includes('收到：let me in')));

const bindings = JSON.parse(fs.readFileSync(path.join(home, 'feishu', 'bindings.json'), 'utf8'));
const bound = Object.values(bindings)[0];
check('bindings persisted', Boolean(bound?.sessionId && bound?.cwd === workspace), JSON.stringify(bound));

// /mode: bare shows table; ro switch; second bare shows read-only (derived from
// REAL session events written by permissionPresets.set); full warns; bogus errors
const modeCards = cards.filter((c) => (c.card?.header?.title?.content ?? '') === '权限模式');
const modeSwitch = cards.find((c) => (c.card?.header?.title?.content ?? '') === '模式已切换');
check('/mode lists preset table', modeCards.length >= 1 && md(modeCards[0]).includes('read-only') && md(modeCards[0]).includes('workspace-write'));
check('/mode ro switches (event-backed)', Boolean(modeSwitch && md(modeSwitch).includes('read-only') && modeCards.some((c) => md(c).includes('当前模式：**read-only**'))));
check('/mode full warns + auto-never approval', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '') === '模式已切换' && md(c).includes('danger-full-access') && md(c).includes('审批：`never`'))));
check('/mode bogus rejected', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '').includes('未知模式'))));

// /model
const modelCards = cards.filter((c) => (c.card?.header?.title?.content ?? '') === '模型');
const modelSwitch = cards.find((c) => (c.card?.header?.title?.content ?? '') === '模型已切换');
check('/model bare lists providers', modelCards.length >= 1 && md(modelCards[0]).includes('当前模型'));
check('/model explicit switch + reflected', Boolean(modelSwitch && md(modelSwitch).includes('deepseek-v4-pro') && modelCards.some((c) => md(c).includes('当前模型：**deepseek-official/deepseek-v4-pro**'))));
check('/model unknown rejected', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '').includes('未找到模型'))));

// /preset
const presetCards = cards.filter((c) => (c.card?.header?.title?.content ?? '') === 'Agent 预设');
check('/preset lists roster', presetCards.some((c) => md(c).includes('minimal') && md(c).includes('standard')));
check('/preset on history → fresh session', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '') === '已用新预设开会话' && md(c).includes('standard'))));
check('/preset blank → live switch (event)', Boolean(presetCards.some((c) => md(c).includes('当前预设：**cordis**'))));
check('/preset bogus rejected', Boolean(cards.some((c) => (c.card?.header?.title?.content ?? '').includes('未知预设'))));

// sessions actually persisted to disk (real session pipeline ran)
const sessionsRoot = path.join(home, 'sessions');
let persisted = 0;
if (fs.existsSync(sessionsRoot)) {
  const proj = fs.readdirSync(sessionsRoot)[0];
  if (proj) persisted = fs.readdirSync(path.join(sessionsRoot, proj), { withFileTypes: true }).length;
}
check('sessions persisted to disk', persisted >= 2, `count=${persisted}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
console.log(`sandbox: ${sandbox}`);
process.exit(failed.length ? 1 : 0);
