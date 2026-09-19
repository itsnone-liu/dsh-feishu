#!/usr/bin/env node
/**
 * phases.test.mjs — /plan /exec /review 网页额度相位的针对性单元测试（纯 Node）。
 *
 *  1. parsePhaseArg：档位 / 完整 slug / commit / 空。
 *  2. extractAssistantText：从 session events 提取 text parts。
 *  3. collectReviewPack：临时 git 仓库 diff 收集、预算截断、无变更 empty。
 *  4. /plan → /exec 全流程：模型切换对、产物落盘、startCommit、提示注入。
 *  5. /review：无起点报错、坏 commit 报错、正常收集注入。
 *  6. 降级：plan 相位网页侧 turn error → 切回 execPair + 降级卡；
 *     autocontinue 钩子认领后不建 watcher。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePhaseArg, extractAssistantText, collectReviewPack, PhaseManager } from '../src/phases.js';
import { AutoContinue } from '../src/autocontinue.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.log(`FAIL ${name}: ${e?.stack ?? e}`); });

// ------------------------------------------------------------ 1 参数解析
await ok('parsePhaseArg: effort / full slug / base / empty', () => {
  assert.deepEqual(parsePhaseArg(''), {});
  assert.deepEqual(parsePhaseArg('light'), { effort: 'chatgpt-web/light' });
  assert.deepEqual(parsePhaseArg('high'), { effort: 'chatgpt-web/high' });
  assert.deepEqual(parsePhaseArg('chatgpt-web/extra-high'), { effort: 'chatgpt-web/extra-high' });
  assert.deepEqual(parsePhaseArg('v1.2.0'), { base: 'v1.2.0' });
  assert.deepEqual(parsePhaseArg('HEAD~3'), { base: 'HEAD~3' });
});

// ------------------------------------------------------------ 2 产物提取
await ok('extractAssistantText: text parts only, from index', () => {
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'assistant/message', data: { parts: [{ type: 'reasoning', text: '思考中' }] } },
    { type: 'assistant/message', data: { parts: [{ type: 'text', text: '方案第一稿' }] } },
    { type: 'tool/call', data: {} },
    { type: 'assistant/message', data: { parts: [{ type: 'text', text: '方案第二稿' }, { type: 'tool-call' }] } },
  ];
  assert.equal(extractAssistantText(events, 0), '方案第一稿\n\n方案第二稿');
  assert.equal(extractAssistantText(events, 4), '方案第二稿');
  assert.equal(extractAssistantText(events, 99), '');
});

// ------------------------------------------------------------ 3 diff 收集
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'ignore', 'ignore'] });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.js'), 'function a() { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(2000));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const baseSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  // 变更：改 a.js + 新增 b.js + 删 big.txt
  fs.writeFileSync(path.join(dir, 'a.js'), 'function a() { return 2; }\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'const b = 3;\n');
  fs.rmSync(path.join(dir, 'big.txt'));
  return { dir, baseSha };
}

await ok('collectReviewPack: diff + status + files, budget honored', async () => {
  const { dir, baseSha } = makeRepo();
  const pack = await collectReviewPack(dir, baseSha, { budgetChars: 150_000, fileMaxChars: 60_000 });
  assert.ok(!pack.error && !pack.empty, `no error/empty (${pack.error ?? ''})`);
  assert.match(pack.body, /git diff/);
  assert.match(pack.body, /return 2/);       // diff 内容
  assert.match(pack.body, /const b = 3/);    // 新文件 diff + 全文
  assert.match(pack.body, /## 文件 a\.js/);  // 全文块
  assert.equal(pack.truncatedCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok('collectReviewPack: tiny budget truncates file blocks, keeps diff', async () => {
  const { dir, baseSha } = makeRepo();
  const pack = await collectReviewPack(dir, baseSha, { budgetChars: 600, fileMaxChars: 60_000 });
  assert.ok(!pack.error && !pack.empty);
  assert.ok(pack.body.includes('## git diff'), 'diff section survives');
  assert.ok(pack.truncatedCount >= 1, `file blocks truncated (got ${pack.truncatedCount})`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok('collectReviewPack: no changes since HEAD → empty', async () => {
  const { dir } = makeRepo();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'ignore', 'ignore'] });
  g('add', '.');
  g('commit', '-q', '-m', 'commit the changes');
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  const pack = await collectReviewPack(dir, head);
  assert.ok(pack.empty, 'empty when base == HEAD and tree clean');
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok('collectReviewPack: bad ref → error', async () => {
  const { dir, baseSha } = makeRepo();
  const pack = await collectReviewPack(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  assert.ok(pack.error, 'error for unresolvable ref');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 4/5/6 相位机
function harness(cfgOver = {}) {
  const cards = [];
  const submitted = [];
  const modelLog = [];
  let cur = { provider: 'glm_coding', model: 'glm-5.3' };
  const cfg = {
    phaseWeb: true,
    phaseWebProvider: 'chatgpt-web',
    phaseWebModel: 'chatgpt-web/light',
    phaseWebProbeUrl: '',           // 测试禁探针定时器
    phaseWebProbeAuthEnv: 'CHATGPT_WEB_TOKEN',
    phaseReviewBudgetChars: 150_000,
    phaseReviewFileMaxChars: 60_000,
    ...cfgOver,
  };
  const agent = {
    id: 'session-test',
    status: 'idle',
    session: { events: [] },
  };
  const driver = {
    live: new Map([['session-test', { agent }]]),
    currentModel: () => ({ ...cur }),
    setModel(_a, provider, model) { cur = { provider, model }; modelLog.push({ provider, model }); },
    submit(_a, text) { submitted.push(text); return 'followup'; },
  };
  const renderer = { chatOf: (id) => (id === 'session-test' ? 'chat-1' : null) };
  const transport = { async sendCard(_c, card) { cards.push(card); return { messageId: `m${cards.length}` }; } };
  const autoContinue = new AutoContinue({ config: { autoContinue: true, autoContinueMessage: '继续' }, driver, renderer, transport });
  const phases = new PhaseManager({ config: cfg, driver, transport, autoContinue });
  autoContinue.phases = phases;
  const say = (text) => {
    agent.session.events.push({ type: 'assistant/message', data: { parts: [{ type: 'text', text }] } });
  };
  return { phases, autoContinue, cards, submitted, modelLog, agent, say, curRef: () => cur };
}

await ok('/plan → /exec: switch pairs, archive artifact, record startCommit', async () => {
  const repo = makeRepo();
  const { phases, cards, submitted, modelLog, agent, say, curRef } = harness();
  say('exec 期间的旧输出（不应进 plan 产物）');

  let r = await phases.handle('chat-1', agent, repo.dir, 'plan', '');
  assert.ok(r.ok, r.text);
  assert.equal(curRef().provider, 'chatgpt-web');
  assert.equal(curRef().model, 'chatgpt-web/light');
  assert.match(submitted[submitted.length - 1], /规划模式/);
  assert.equal(phases.statusLine('chat-1'), '相位：**规划**（网页额度）');

  say('方案：三步走。第一步……');
  say('更新：加一个风险节。');

  r = await phases.handle('chat-1', agent, repo.dir, 'exec', '');
  assert.ok(r.ok, r.text);
  assert.equal(curRef().provider, 'glm_coding', 'back to exec pair');
  assert.ok(phases.phases.get('chat-1').startCommit, 'startCommit recorded');
  assert.match(submitted[submitted.length - 1], /执行模式/);

  // 产物落盘：只含 plan 相位两条，不含旧输出
  const files = fs.readdirSync(path.join(repo.dir, '.dsh', 'phases'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^plan-\d{14}\.md$/);
  const artifact = fs.readFileSync(path.join(repo.dir, '.dsh', 'phases', files[0]), 'utf8');
  assert.match(artifact, /三步走/);
  assert.match(artifact, /风险节/);
  assert.ok(!artifact.includes('旧输出'), 'pre-plan output excluded');
  assert.match(r.text, /执行模式/);
  assert.match(r.text, /plan-/);
  phases.dispose();
  fs.rmSync(repo.dir, { recursive: true, force: true });
});

await ok('/review: no base → guidance; bad ref → error; good → injected diff', async () => {
  const repo = makeRepo();
  const { phases, submitted, curRef } = harness();

  // 无起点（新会话直接 /review）
  let r = await phases.handle('chat-1', { ...harnessAgent(), session: { events: [] } }, repo.dir, 'review', '');
  assert.ok(!r.ok);
  assert.match(r.text, /审计起点/);

  // 坏 ref
  const agent = harnessAgent();
  r = await phases.handle('chat-1', agent, repo.dir, 'review', 'no-such-ref');
  assert.ok(!r.ok);
  assert.match(r.text, /无法解析/);

  // 好：显式 commit 起点
  r = await phases.handle('chat-1', agent, repo.dir, 'review', repo.baseSha);
  assert.ok(r.ok, `review must succeed (${r.text})`);
  assert.equal(curRef().provider, 'chatgpt-web');
  const note = submitted[submitted.length - 1];
  assert.match(note, /审计模式/);
  assert.match(note, /return 2/, 'diff body injected');
  fs.rmSync(repo.dir, { recursive: true, force: true });
});

function harnessAgent() {
  return { id: 'session-test', status: 'idle', session: { events: [] } };
}

await ok('degrade: web error in plan phase → back to exec pair + card; auto hook claims', async () => {
  const repo = makeRepo();
  const { phases, autoContinue, cards, modelLog, agent, curRef } = harness();
  await phases.handle('chat-1', agent, repo.dir, 'plan', '');
  assert.equal(curRef().provider, 'chatgpt-web');

  // 网页侧 turn/end error（401 类）
  const claimed = phases.onTurnError(
    { id: 'session-test' },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'Not authenticated. Please login first at /' } } } },
  );
  assert.equal(claimed, true, 'phases claims the error');
  assert.equal(curRef().provider, 'glm_coding', 'degraded back to exec pair');
  const st = phases.phases.get('chat-1');
  assert.equal(st.degraded, true);
  assert.ok(st.phase === 'plan', 'phase preserved');
  assert.ok(cards.some((c) => /降级/.test(JSON.stringify(c.header.title.content) + JSON.stringify(c))), 'degrade card sent');

  // autocontinue 不再建 watcher（错误被认领）
  autoContinue.onEvent(
    { id: 'session-test' },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'Not authenticated. Please login first at /' } } } },
  );
  assert.equal(autoContinue.watchers.size, 0, 'no watcher for web-side error');

  // 已降级后的重复错误被吞（不再重复切/发卡）
  const cardsBefore = cards.length;
  const again = phases.onTurnError(
    { id: 'session-test' },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'still down' } } } },
  );
  assert.equal(again, true);
  assert.equal(cards.length, cardsBefore, 'no duplicate card');
  phases.dispose();
  fs.rmSync(repo.dir, { recursive: true, force: true });
});

await ok('degrade does NOT trigger for exec-phase or non-web errors', async () => {
  const repo = makeRepo();
  const { phases, agent, curRef } = harness();
  // exec 相位（默认）+ 当前在 glm：不认领
  let claimed = phases.onTurnError({ id: 'session-test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'quota used up' } } } });
  assert.equal(claimed, false);

  // plan 相位但错误来自非网页模型（手动切走）：不认领
  await phases.handle('chat-1', agent, repo.dir, 'plan', '');
  phases.driver.setModel(agent, 'glm_coding', 'glm-5.3');
  claimed = phases.onTurnError({ id: 'session-test' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'quota' } } } });
  assert.equal(claimed, false);
  phases.dispose();
  fs.rmSync(repo.dir, { recursive: true, force: true });
});

await ok('/exec after /review archives the report', async () => {
  const repo = makeRepo();
  const { phases, agent, say } = harness();
  let r = await phases.handle('chat-1', agent, repo.dir, 'exec', '');     // 记起点
  assert.ok(r.ok, r.text);
  r = await phases.handle('chat-1', agent, repo.dir, 'review', '');
  assert.ok(r.ok, `review must succeed (${r.text})`);
  say('审计发现：P0 一个（a.js 边界）。');
  r = await phases.handle('chat-1', agent, repo.dir, 'exec', '');
  assert.ok(r.ok);
  const files = fs.readdirSync(path.join(repo.dir, '.dsh', 'phases')).filter((f) => f.startsWith('review-'));
  assert.equal(files.length, 1, 'review artifact archived');
  const artifact = fs.readFileSync(path.join(repo.dir, '.dsh', 'phases', files[0]), 'utf8');
  assert.match(artifact, /P0/);
  phases.dispose();
  fs.rmSync(repo.dir, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
