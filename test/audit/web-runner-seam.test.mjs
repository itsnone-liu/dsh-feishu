#!/usr/bin/env node
// A5 验收测试：把 FakeWebAuditRunner 换成真实 WebAuditRunner（注入 transport），
// A4 冻结的 AuditLifecycle orchestration 一行不改，全链路跑到 TARGET_REACHED。
import assert from 'node:assert';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AuditLifecycle } from '../../src/audit/lifecycle.js';
import { AuditController } from '../../src/audit/controller.js';
import { AuditStore } from '../../src/audit/store.js';
import { AuditExecutor } from '../../src/audit/executor.js';
import { GitRemoteGate } from '../../src/audit/git-gate.js';
import { WebAuditRunner } from '../../src/audit/web-runner.js';
import { buildExecutorMarkerText, buildVerdictText } from '../../src/audit/protocol.js';
import { parseExecutorMarker } from '../../src/audit/protocol.js';

let pass = 0, fail = 0;
const ok = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log(`PASS ${n}`); }).catch((e) => { fail++; console.error(`FAIL ${n}\n  ${e.stack}`); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-web-seam-'));
  const work = path.join(root, 'work'); mkdirSync(work);
  const origin = path.join(root, 'origin.git');
  const g = (args, cwd = work) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', HOME: root }, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main', work]); g(['init', '-q', '--bare', origin]);
  writeFileSync(path.join(work, 'README.md'), '# t\n');
  g(['add', '.']); const d = new Date('2026-01-01T00:00:00Z'); process.env.GIT_AUTHOR_DATE = d.toISOString(); process.env.GIT_COMMITTER_DATE = d.toISOString();
  g(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  g(['remote', 'add', 'origin', origin]); g(['push', '-q', 'origin', 'main']);
  return { root, work, origin, g };
}

function setup(x) {
  let clock = 1000;
  const store = new AuditStore(path.join(x.root, 'audit'));
  const controller = new AuditController({ store, hostId: 'h1', cwd: x.work, stages: ['T1', 'T2'], branch: 'main', now: () => ++clock });
  const prompts = []; const agent = { id: 'session-seam', status: 'idle' };
  const driver = { ensure: async () => agent, submit: (_a, t) => prompts.push(t) };
  const packet = { goal: 'ship T1+T2', stages: ['T1', 'T2'], stageRequirements: { T1: 'T1 done', T2: 'T2 done' } };
  const lifecycle = new AuditLifecycle({
    controller, driver,
    bindings: new Map([['chat-a', { sessionId: 'session-seam', cwd: x.work }]]),
    gitGateFactory: (o) => new GitRemoteGate({ ...o, allowNonGithubRemote: true }),
    taskPacketLoader: () => packet,
    executorFactory: (o) => new AuditExecutor(o),
  });
  const commit = (file, content, msg) => {
    writeFileSync(path.join(x.work, file), content);
    x.g(['add', '.']); x.g(['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: x.work, env: { ...process.env, HOME: x.root } }).toString().trim();
  };
  return { lifecycle, store, controller, prompts, agent, packet, commit, cleanup: () => rmSync(x.root, { recursive: true, force: true }) };
}

// 真实 WebAuditRunner + 注入 transport：模拟网页模型按轮返回 verdict 文本。
// 这是「A5 只替换 reviewer 实现」的直接证明 —— lifecycle 侧零改动。
function webModel(script) {
  const queue = [...script];
  const seenRequests = [];
  return {
    runner: new WebAuditRunner({
      readAuth: () => 'tok-seam',
      retryDelayMs: 1, transientRetries: 2, sleep: async () => {},
      transport: async (req) => {
        seenRequests.push(req);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'number') return { status: next, json: { error: { message: `http ${next}` } }, text: `http ${next}` };
        const text = typeof next === 'string' ? next : next.text;
        return {
          status: 200,
          json: { id: 'rs', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] },
          text: '',
        };
      },
    }),
    seenRequests,
  };
}

await ok('real WebAuditRunner type drives frozen lifecycle to TARGET_REACHED, zero lifecycle edits', async () => {
  const x = fixture(); const m = setup(x);
  try {
    const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T2' });
    const run = started.run;
    // 网页模型脚本：T1 直接 APPROVE；T2 先 REVISE 一次再 APPROVE（验证 web 侧 REVISE 全链路）。
    const web = webModel([
      { text: buildVerdictText({ state: 'APPROVE', runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, summary: ['T1 ok'], evidence: ['diff verified'] }) },
      { text: buildVerdictText({ state: 'REVISE', runId: run.runId, hostId: 'h1', stage: 'T2', iteration: 1, reason: ['missing test'], p0: ['add test'] }) },
      { text: buildVerdictText({ state: 'APPROVE', runId: run.runId, hostId: 'h1', stage: 'T2', iteration: 2, summary: ['T2 ok'], evidence: ['test present'] }) },
    ]);
    m.lifecycle.reviewer = web.runner; // A4 冻结的注入点，唯一接线

    const a = m.commit('a.txt', 'A', 'A');
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
    assert.equal(run.s.state, 'AUDITING'); // turn/end 前不审核
    assert.equal(web.runner.calls.length, 0);
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(web.runner.calls.length, 1); // turn/end 自动审核
    assert.equal(run.s.currentStage, 'T2'); // APPROVE → 下一阶段

    // T2 第一轮 REVISE → executor 收到 P0 重做提示
    const b = m.commit('b.txt', 'B', 'B');
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 2 } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T2', iteration: 1, head: b }) }] } } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    assert.equal(web.runner.calls.length, 2);
    assert.equal(run.s.state, 'EXECUTING'); // REVISE → 回执行
    assert.ok(m.prompts.some((p) => p.includes('missing test')), 'REVISE reason must reach executor prompt');

    // T2 第二轮 APPROVE → TARGET_REACHED
    const c = m.commit('c.txt', 'C', 'C');
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 3 } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T2', iteration: 2, head: c }) }] } } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
    assert.equal(web.runner.calls.length, 3);
    assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');

    // 请求面：每轮 handoff 身份字段 + verdict 模板都进入网页模型 prompt
    const bodies = web.seenRequests.map((r) => r.body);
    assert.equal(bodies.length, 3);
    assert.ok(bodies.every((b) => b.input.some((msg) => msg.role === 'developer' && msg.content.includes('independent auditor'))));
    assert.ok(bodies[0].input.some((msg) => msg.content.includes(`RUN_ID: ${run.runId}`) && msg.content.includes('HOST_ID: h1')));
    assert.ok(bodies.every((b) => b.model === 'gpt-5.6-luna' && b.stream === true && b.store === false));
  } finally { m.cleanup(); }
});

await ok('web infrastructure failure (429) latches round in frozen orchestration; explicit review() recovers', async () => {
  const x = fixture(); const m = setup(x);
  try {
    const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T1' });
    const run = started.run;
    const web = webModel([429, { text: buildVerdictText({ state: 'APPROVE', runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, summary: ['ok'], evidence: ['ok'] }) }]);
    m.lifecycle.reviewer = web.runner;
    const a = m.commit('a.txt', 'A', 'A');
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
    await assert.rejects(() => m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), (e) => e.code === 'AUDIT_WEB_QUOTA');
    assert.equal(web.runner.calls.length, 1);
    assert.equal(run.s.state, 'AUDITING'); // 不自动迁移
    // 重复 turn/end：round latched → 不再打网页额度
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }).catch(() => undefined);
    assert.equal(web.runner.calls.length, 1);
    // 显式恢复出口仍可用
    await m.lifecycle.review(run.runId, web.runner);
    assert.equal(web.runner.calls.length, 2);
    assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  } finally { m.cleanup(); }
});

await ok('web malformed verdict walks frozen verdictMissing retry (exactly one VERDICT_RETRY)', async () => {
  const x = fixture(); const m = setup(x);
  try {
    const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T1' });
    const run = started.run;
    const web = webModel([
      { text: '我觉得没问题，可以合并。' }, // 无 [DSH-AUDIT] 块 → MALFORMED
      { text: buildVerdictText({ state: 'APPROVE', runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, summary: ['ok'], evidence: ['ok'] }) },
    ]);
    m.lifecycle.reviewer = web.runner;
    const a = m.commit('a.txt', 'A', 'A');
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(web.runner.calls.length, 2); // MALFORMED → 立即同轮重试一次
    assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
    const events = m.store.loadRun(run.runId).events;
    assert.equal(events.filter((e) => e.event === 'VERDICT_RETRY').length, 1);
  } finally { m.cleanup(); }
});

await ok('HTTP 200 + stream failure inside frozen lifecycle: no VERDICT_RETRY, round latched, explicit review() recovers', async () => {
  const x = fixture(); const m = setup(x);
  try {
    const started = await m.lifecycle.start({ chatId: 'chat-a', stopAfter: 'T1' });
    const run = started.run;
    // 先流内失败一次（200 + response.failed），再正常返回 verdict。
    let failNext = true;
    const runner = new WebAuditRunner({
      readAuth: () => 't', retryDelayMs: 1, sleep: async () => {},
      transport: async () => {
        if (failNext) {
          failNext = false;
          return { status: 200, json: null, outputText: null,
            streamError: { type: 'response.failed', code: 'server_error', status: null, message: 'upstream exploded' } };
        }
        const text = buildVerdictText({ state: 'APPROVE', runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, summary: ['ok'], evidence: ['ok'] });
        return { status: 200, json: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }, outputText: null, streamError: null };
      },
    });
    m.lifecycle.reviewer = runner;
    const a = m.commit('a.txt', 'A', 'A');
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/start', data: { turn: 1 } });
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: buildExecutorMarkerText({ runId: run.runId, hostId: 'h1', stage: 'T1', iteration: 1, head: a }) }] } } });
    await assert.rejects(() => m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), (e) => e.code === 'AUDIT_WEB_UPSTREAM_ERROR');
    assert.equal(runner.calls.length, 1);
    assert.equal(run.s.state, 'AUDITING');
    // 关键：infrastructure failure 不得触发 verdictMissing 自动重试
    const events = m.store.loadRun(run.runId).events;
    assert.equal(events.filter((e) => e.event === 'VERDICT_RETRY').length, 0);
    // round latched：重复 turn/end 不再打网页额度
    await m.lifecycle.onEvent({ id: m.agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }).catch(() => undefined);
    assert.equal(runner.calls.length, 1);
    // 显式恢复出口仍可用
    await m.lifecycle.review(run.runId, runner);
    assert.equal(runner.calls.length, 2);
    assert.equal(run.s.state, 'STOPPED_TARGET_REACHED');
  } finally { m.cleanup(); }
});

console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
