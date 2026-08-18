/**
 * FakeAgent — TEST ONLY (config.mockAgent).
 *
 * Implements the `Agent` surface well enough for the registry, the bridge, and
 * the user-questions/approval seams, and drives a REAL `Session` (created via
 * `ctx.sessions`) through the REAL event pipeline with valid event sequences.
 * The renderer, router, bindings, and cards therefore run the exact production
 * path; only the model loop is scripted.
 *
 * Event order mirrors a real step (verified against on-disk sessions):
 *   turn/start → step/start → user/message → assistant/chunk*
 *   (block-start/delta…/finish) → assistant/message → tool/call → tool/result
 *   → step/end → turn/end
 *
 * Message markers (prefix of the user text):
 *   TOOL:…     also perform one tool call/result round
 *   ASK:…      mid-turn ctx.userQuestions.ask (one question, 3 options)
 *   APPROVE:…  mid-turn ctx.approval.request
 *   ERR:…      end the turn with an error reason
 *   …SLOW…     slow deltas (racing steer/stop)
 */
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { sleep, clamp } from './util.js';
import { log } from './log.js';

const INERT_INBOX = {
  nextTurn: [],
  nextStep: [],
  append() { throw new Error('fake inbox is inert'); },
  prepend() { throw new Error('fake inbox is inert'); },
  replace() { throw new Error('fake inbox is inert'); },
  remove() { throw new Error('fake inbox is inert'); },
  clear() {},
  splice() {},
  claim() { return []; },
};

export class FakeAgent {
  constructor(ctx, session, config) {
    this.ctx = ctx;
    this.session = session;
    this.id = session.id;
    this.status = 'idle';
    this.inbox = INERT_INBOX;
    this.options = { provider: 'mock', model: 'mock-1' };
    this.#pendingSteer = [];
    this.#cancel = null;
    this.#idleWaiters = [];
    this.#turn = 0;
    this.deltaMs = Number(process.env.DSH_FEISHU_MOCK_DELTA_MS || 15);
  }

  #pendingSteer;
  #cancel;
  #idleWaiters;
  #turn;
  #openTurn = 0;
  #openStep = null;

  whenIdle() {
    if (this.status === 'idle') return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #setIdle() {
    this.status = 'idle';
    for (const w of this.#idleWaiters.splice(0)) w();
  }

  followup(message) {
    this.#run(message).catch((e) => log.error(`fake agent: ${e.stack ?? e}`));
  }

  steer(message) {
    this.#pendingSteer.push(message);
    if (this.status === 'idle') this.#run(null).catch((e) => log.error(`fake agent: ${e.stack ?? e}`));
  }

  inject(message) {
    this.#pendingSteer.push(message);
  }

  cancel(cause) {
    this.#cancel?.abort(cause ?? { kind: 'user' });
    this.#pendingSteer = [];
  }

  get #aborted() {
    return Boolean(this.#cancel?.signal?.aborted);
  }

  async #run(firstMessage) {
    if (this.status === 'running') return;
    this.status = 'running';
    const ac = new AbortController();
    this.#cancel = ac;
    try {
      await this.#simulate(firstMessage);
    } catch (e) {
      if (e?.name !== 'AbortError') log.error(`fake agent crashed: ${e.stack ?? e}`);
      this.#closeInterrupted();
    } finally {
      this.#cancel = null;
      this.#setIdle();
    }
  }

  /** Close whatever turn/step is open after an interruption. */
  #closeInterrupted() {
    try {
      if (this.#openStep) this.session.append('step/end', this.#openStep);
      if (this.#openTurn) {
        this.session.append('turn/end', {
          turn: this.#openTurn,
          reason: { kind: 'cancelled', cause: { kind: 'user' } },
        });
      }
    } catch (e) {
      log.error(`fake agent close: ${e.message}`);
    } finally {
      this.#openStep = null;
      this.#openTurn = 0;
    }
  }

  async #simulate(firstMessage) {
    const s = this.session;
    const turn = ++this.#turn;
    this.#openTurn = turn;
    s.append('turn/start', { turn });

    const inputs = [firstMessage].filter(Boolean);
    let step = 0;

    while (inputs.length > 0) {
      if (this.#aborted) throw new DOMException('aborted', 'AbortError');
      const message = inputs.shift();
      const text = message?.content?.[0]?.text ?? '';
      const slow = /SLOW/.test(text);
      const d = () => sleep(slow ? 160 : this.deltaMs);

      step += 1;
      this.#openStep = { turn, step };
      s.append('step/start', { turn, step });
      s.append('user/message', {
        content: message?.content ?? [{ type: 'text', text }],
        source: message?.source ?? { kind: 'user' },
        role: 'user',
        id: message?.id ?? `fake-${turn}-${Math.random().toString(36).slice(2, 10)}`,
      }, { surfaceOp: 'append' });

      const chunkSeqs = [];
      const chunk = (data) => {
        if (this.#aborted) throw new DOMException('aborted', 'AbortError');
        const ev = s.append('assistant/chunk', { turn, step, chunk: data });
        chunkSeqs.push(ev.seq);
      };

      // 1) stream reasoning
      const reasoningText = `让我想想…用户说：${clamp(text, 60)}`;
      chunk({ type: 'block-start', index: 0, blockType: 'reasoning' });
      for (const piece of ['让我想想…', '用户说：', clamp(text, 60)]) {
        chunk({ type: 'reasoning-delta', index: 0, text: piece });
        await d();
      }

      // 2) interactive seams before the final text
      let finalText = `收到：${clamp(text, 200)}\n（mock agent 完成）`;
      if (text.startsWith('ASK:')) {
        chunk({ type: 'block-start', index: 1, blockType: 'text' });
        chunk({ type: 'text-delta', index: 1, text: '等待你的选择…' });
        const answer = await this.#ask();
        finalText = `ASK 回答：${JSON.stringify(answer)}`;
      }
      if (text.startsWith('APPROVE:')) {
        chunk({ type: 'block-start', index: 1, blockType: 'text' });
        chunk({ type: 'text-delta', index: 1, text: '等待审批…' });
        const outcome = await this.ctx.approval.request({
          agent: this,
          toolName: 'bash',
          reason: 'mock 工具请求升级权限',
          signal: this.#cancel.signal,
        });
        finalText = `APPROVE 结果：${outcome}`;
      }

      // 3) stream final text
      chunk({ type: 'block-start', index: 1, blockType: 'text' });
      chunk({ type: 'text-delta', index: 1, text: finalText });
      await d();

      // 4) optional tool-call stream
      const wantsTool = text.startsWith('TOOL:');
      if (wantsTool) {
        chunk({ type: 'tool-call-delta', index: 2, text: '{"command":"echo hi"}' });
        await d();
      }

      chunk({ type: 'finish', reason: { kind: 'stop' } });

      // 5) authoritative assistant message for the step
      const content = [
        { type: 'reasoning', text: reasoningText },
        { type: 'text', text: finalText },
      ];
      if (wantsTool) {
        content.push({ type: 'tool-call', id: 'call_mock_1', name: 'bash', arguments: '{"command":"echo hi"}' });
      }
      s.append('assistant/message', {
        turn,
        step,
        message: createAssistantMessage({
          content,
          source: { provider: 'mock', model: 'mock-1' },
        }),
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 512 },
      }, { surfaceOp: 'append', sourceEventSeqs: [...chunkSeqs] });

      // 6) tool execution
      if (wantsTool) {
        s.append('tool/call', {
          turn, step, callId: 'call_mock_1', name: 'bash',
          arguments: '{"command":"echo hi"}',
        });
        await d();
        s.append('tool/result', {
          turn, step,
          message: createToolResultMessage({
            callId: 'call_mock_1',
            content: [{ type: 'text', text: 'hi' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' });
      }

      s.append('step/end', { turn, step });
      this.#openStep = null;

      // consume steering that arrived while working → next step input
      while (this.#pendingSteer.length > 0) {
        inputs.push(this.#pendingSteer.shift());
      }
    }

    this.#openTurn = 0;
    const firstText = firstMessage?.content?.[0]?.text ?? '';
    const reason = firstText.startsWith('ERR:')
      ? { kind: 'error', error: { code: 'MOCK_ERROR', message: 'mock 模型失败' } }
      : { kind: 'completed' };
    s.append('turn/end', { turn, reason });
  }

  async #ask() {
    const res = await this.ctx.userQuestions.ask({
      questions: [{
        id: 'q1',
        question: 'mock 问题：选一个',
        options: [
          { label: '选项A', description: '第一个' },
          { label: '选项B', description: '第二个' },
          { label: '选项C', description: '第三个' },
        ],
      }],
      agent: this,
      signal: this.#cancel.signal,
    });
    return res.answers[0];
  }
}
