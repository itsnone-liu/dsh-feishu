/**
 * voice_in tests: no Feishu, no dsh, no socket to the bridge — fakes only.
 *
 * The point of these tests is the contract the voice service depends on:
 *   1. an ask reaches the same `router.onMessage` a typed message would;
 *   2. text-deltas come back in order, and reasoning deltas never do;
 *   3. turn/end closes the exchange exactly once;
 *   4. cancel stops the driver and still reports done;
 *   5. a second ask while one is running is refused, not queued silently;
 *   6. nothing thrown by the events feed can escape into dsh's append path.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createVoiceIn } from '../src/voice_in.js';

const OWNER = 'ou_owner_1';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function tmpSock(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), `${name}.sock`);
}

/** Minimal client: send JSON lines, collect replies. */
function connect(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath, () => resolve(sock));
    sock.on('error', reject);
  });
}

function collector(sock) {
  const out = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) out.push(JSON.parse(line));
    }
  });
  return {
    out,
    async waitFor(pred, timeoutMs = 2000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const hit = out.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timeout; got ${JSON.stringify(out)}`);
    },
  };
}

function harness({ chatId = 'chat-1', sessionId = 's-1', running = false } = {}) {
  const submitted = [];
  const stopped = [];
  const router = { onMessage: (msg) => submitted.push(msg) };
  const store = {
    get: (id) => (id === chatId ? { chatId: id, sessionId, cwd: '/tmp' } : null),
  };
  // idle by default: an ask on an idle agent is a normal followup. Tests that
  // need the steer path set status explicitly.
  const agent = { id: sessionId, status: 'idle' };
  // Real shape: live maps sessionId → {agent} wrapper (see driver.js live.set).
  const live = new Map([[sessionId, { agent }]]);
  const driver = {
    live,
    stop: (agent) => stopped.push(agent?.id),
    submit: () => 'followup',
  };
  const voice = createVoiceIn({
    router,
    driver,
    store,
    config: { allowedOpenIds: [OWNER], voice: { chatId } },
    log: quiet,
    socketPath: tmpSock('t'),
  });
  if (running) agent.status = 'running';
  return { voice, submitted, stopped, sessionId, chatId, agent };
}

/** Synthesises the bridge's session/event stream for one turn. */
function playTurn(voice, sessionId, { reasoning = false, text = ['你', '好'], end = true } = {}) {
  const emit = (type, data) => voice.onSessionEvent({ id: sessionId }, { type, data });
  emit('turn/start', { turn: 1 });
  if (reasoning) {
    emit('assistant/chunk', { chunk: { type: 'block-start', blockType: 'reasoning', index: 0 } });
    emit('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: '内部推理不该被念出来' } });
  }
  emit('assistant/chunk', { chunk: { type: 'block-start', blockType: 'text', index: 1 } });
  for (const t of text) emit('assistant/chunk', { chunk: { type: 'text-delta', index: 1, text: t } });
  if (end) emit('turn/end', { reason: { kind: 'completed' } });
}

test('ask goes through the same router entry as a typed message', async () => {
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);

  sock.write(JSON.stringify({ id: 1, op: 'ask', text: '今天天气怎么样' }) + '\n');
  const ack = await c.waitFor((m) => m.type === 'ack');
  assert.equal(ack.id, 1);
  assert.equal(ack.sessionId, h.sessionId, 'the bound session must be visible to the caller');

  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].chatId, h.chatId);
  assert.equal(h.submitted[0].text, '今天天气怎么样');
  assert.ok(h.submitted[0].messageId.startsWith('voice-'), 'dedupe key must be unique per ask');

  playTurn(h.voice, h.sessionId);
  const done = await c.waitFor((m) => m.type === 'done');
  assert.equal(done.id, 1);
  assert.equal(done.cancelled, false);
  const deltas = c.out.filter((m) => m.type === 'delta').map((m) => m.text);
  assert.deepEqual(deltas, ['你', '好']);
  h.voice.stop();
  sock.destroy();
});

test('reasoning deltas are never forwarded', async () => {
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 2, op: 'ask', text: '解释一下' }) + '\n');
  await c.waitFor((m) => m.type === 'ack');
  playTurn(h.voice, h.sessionId, { reasoning: true, text: ['答案来了'] });
  await c.waitFor((m) => m.type === 'done');
  const text = c.out.filter((m) => m.type === 'delta').map((m) => m.text).join('');
  assert.equal(text, '答案来了');
  assert.ok(!text.includes('推理'), 'thinking must not reach the speaker');
  h.voice.stop();
  sock.destroy();
});

test('cancel stops the live agent and reports done exactly once', async () => {
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 3, op: 'ask', text: '讲个长故事' }) + '\n');
  await c.waitFor((m) => m.type === 'ack');
  sock.write(JSON.stringify({ id: 3, op: 'cancel' }) + '\n');
  const done = await c.waitFor((m) => m.type === 'done');
  assert.equal(done.cancelled, true);
  assert.deepEqual(h.stopped, [h.sessionId], 'generation must be stopped, not left running');
  // A late turn/end from the dying turn must not produce a second completion.
  playTurn(h.voice, h.sessionId, { text: ['残'] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.out.filter((m) => m.type === 'done').length, 1);
  h.voice.stop();
  sock.destroy();
});

test('a second ask while one is running is refused with the busy id', async () => {
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 4, op: 'ask', text: '第一句' }) + '\n');
  await c.waitFor((m) => m.type === 'ack');
  sock.write(JSON.stringify({ id: 5, op: 'ask', text: '第二句' }) + '\n');
  const err = await c.waitFor((m) => m.type === 'error' && m.id === 5);
  assert.equal(err.busyWith, 4);
  assert.equal(h.submitted.length, 1, 'the second ask must not reach the agent');
  h.voice.stop();
  sock.destroy();
});

test('events from another session are ignored', async () => {
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 6, op: 'ask', text: '你好' }) + '\n');
  await c.waitFor((m) => m.type === 'ack');
  playTurn(h.voice, 'some-other-session', { text: ['不该出现'] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.out.filter((m) => m.type === 'delta').length, 0);
  playTurn(h.voice, h.sessionId, { text: ['对'] });
  await c.waitFor((m) => m.type === 'done');
  assert.deepEqual(c.out.filter((m) => m.type === 'delta').map((m) => m.text), ['对']);
  h.voice.stop();
  sock.destroy();
});

test('a throwing event listener cannot escape into dsh append', () => {
  const h = harness();
  h.voice.start();
  // session without id + malformed event: must be contained
  assert.doesNotThrow(() => h.voice.onSessionEvent(null, { type: 'assistant/chunk' }));
  assert.doesNotThrow(() => h.voice.onSessionEvent({ id: h.sessionId }, null));
  h.voice.stop();
});

test('ping answers pong', async () => {
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 9, op: 'ping' }) + '\n');
  await c.waitFor((m) => m.type === 'pong');
  h.voice.stop();
  sock.destroy();
});

test('the submitted openId is the whitelisted owner, not a synthetic "voice"', async () => {
  // The router drops unknown senders (router.js:127), so this is the difference
  // between "voice works" and "voice silently produces nothing".
  const h = harness();
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 20, op: 'ask', text: '你好' }) + '\n');
  await c.waitFor((m) => m.type === 'ack');
  assert.equal(h.submitted[0].openId, OWNER);
  h.voice.stop();
  sock.destroy();
});

test('an unwhitelisted sender is refused before reaching the agent', async () => {
  const router = { onMessage: () => { throw new Error('must not be called'); } };
  const voice = createVoiceIn({
    router,
    driver: { live: new Map(), stop() {} },
    store: { get: () => ({ sessionId: 's-1' }) },
    config: { allowedOpenIds: [], voice: { chatId: 'chat-1' } },
    log: quiet,
    socketPath: tmpSock('nw'),
  });
  voice.start();
  const sock = await connect(voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 21, op: 'ask', text: '你好' }) + '\n');
  const err = await c.waitFor((m) => m.type === 'error');
  assert.match(err.message, /openId/);
  voice.stop();
  sock.destroy();
});


test("interrupting a running turn: the old turn's end is not our answer", async () => {
  // The first live device turn failed exactly here: the user spoke while the
  // previous turn was still generating, the submit became a steer, and the
  // in-flight turn's turn/end was answered as OUR done with zero deltas.
  const h = harness({ running: true });
  h.voice.start();
  const sock = await connect(h.voice._state().socketPath);
  const c = collector(sock);
  sock.write(JSON.stringify({ id: 30, op: 'ask', text: '插话：先回答我' }) + '\n');
  await c.waitFor((m) => m.type === 'ack');

  const emit = (type, data) => h.voice.onSessionEvent({ id: h.sessionId }, { type, data });
  // the old turn ends first — must be skipped, not treated as our answer
  emit('turn/end', { reason: { kind: 'completed' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.out.filter((m) => m.type === 'done').length, 0,
    'the steered-away turn\'s end must not close our ask');

  // then OUR turn starts and streams
  emit('turn/start', { turn: 2 });
  emit('assistant/chunk', { chunk: { type: 'block-start', blockType: 'text', index: 0 } });
  emit('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: '好的，先答你' } });
  emit('turn/end', { reason: { kind: 'completed' } });
  const done = await c.waitFor((m) => m.type === 'done');
  assert.equal(done.cancelled, false);
  const text = c.out.filter((m) => m.type === 'delta').map((m) => m.text).join('');
  assert.equal(text, '好的，先答你');
  h.voice.stop();
  sock.destroy();
});
