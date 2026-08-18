/**
 * Turn-card renderer: the durable session event feed → one streaming Feishu
 * card per turn.
 *
 * Strategy (per SKETCH §4): during streaming, blocks are assembled from
 * `assistant/chunk` deltas and patched on a throttle; when the step lands,
 * `assistant/message` is the authoritative snapshot and rebuilds the blocks
 * (tool statuses keyed by callId survive the rebuild); `turn/end` finalizes.
 *
 * The renderer never talks to DSH APIs — it only consumes frozen events, so a
 * replayed or resumed session renders identically.
 */
import { buildTurnCard, buildErrorCard } from './cards.js';
import { hhmmss, fmtDuration, summarizeToolArguments, previewToolResult, clamp } from './util.js';
import { log } from './log.js';

const PHASE_BY_TURN_END = {
  completed: 'done',
  error: 'error',
  cancelled: 'stopped',
  stopped: 'stopped',
};

export class TurnRenderer {
  constructor({ transport, config }) {
    this.transport = transport;
    this.config = config;
    /** sessionId → render state */
    this.states = new Map();
  }

  /** Start rendering a session's events into a Feishu chat. */
  attach(sessionId, chatId) {
    this.states.set(sessionId, this.#newState(chatId));
  }

  detach(sessionId) {
    const st = this.states.get(sessionId);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    this.states.delete(sessionId);
  }

  chatOf(sessionId) {
    return this.states.get(sessionId)?.chatId ?? null;
  }

  #newState(chatId) {
    return {
      chatId,
      messageId: null,
      phase: 'idle',
      turnNo: 0,
      title: '会话',
      blocks: [],
      steerNote: '',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      toolCount: 0,
      errorCount: 0,
      startedAt: 0,
      endedAt: 0,
      dirty: false,
      timer: null,
      sending: false,
    };
  }

  /** Router calls this when it steers a running agent, so the card shows it. */
  setSteerNote(sessionId, text) {
    const st = this.states.get(sessionId);
    if (!st) return;
    st.steerNote = clamp(text, 200);
    this.#schedule(st, sessionId, true);
  }

  /** Main feed — called for every committed session event of every session. */
  onEvent(session, event) {
    const st = this.states.get(session.id);
    if (!st) return;
    const d = event.data ?? {};
    switch (event.type) {
      case 'session/title':
        st.title = String(d.title ?? st.title);
        return;
      case 'turn/start':
        this.#beginTurn(st, d.turn ?? ++st.turnNo);
        return;
      case 'step/start':
        return; // step count derived from blocks
      case 'assistant/chunk':
        this.#onChunk(st, d);
        return;
      case 'assistant/message':
        this.#onAssistantMessage(st, d);
        return;
      case 'tool/call':
        this.#onToolCall(st, d);
        return;
      case 'tool/result':
        this.#onToolResult(st, d);
        return;
      case 'turn/end':
        this.#endTurn(st, d);
        return;
      default:
        return;
    }
  }

  #beginTurn(st, turnNo) {
    // New turn → new card; the old one is already finalized.
    st.turnNo = turnNo;
    st.blocks = [];
    st.steerNote = '';
    st.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    st.toolCount = 0;
    st.errorCount = 0;
    st.phase = 'working';
    st.startedAt = Date.now();
    st.endedAt = 0;
    st.messageId = null;
    this.#schedule(st, null, true);
  }

  #onChunk(st, d) {
    const c = d.chunk;
    if (!c) return;
    if (c.type === 'block-start') {
      if (c.blockType === 'text' || c.blockType === 'reasoning') {
        st.blocks[c.index] = { kind: c.blockType, text: '' };
      }
      // tool-call blocks render from the durable tool/call event instead
      return;
    }
    if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const b = st.blocks[c.index];
      if (b && typeof c.text === 'string') {
        b.text += c.text;
        this.#schedule(st, null, false);
      }
      return;
    }
    // 'finish' — nothing to render; assistant/message lands next
  }

  #onAssistantMessage(st, d) {
    // Authoritative snapshot for the step: rebuild blocks, keep tool statuses.
    const prevTools = new Map();
    for (const b of st.blocks) if (b.kind === 'tool' && b.tool?.callId) prevTools.set(b.tool.callId, b.tool);
    const blocks = [];
    const content = d.message?.content ?? [];
    for (const part of content) {
      if (part.type === 'reasoning') {
        blocks.push({ kind: 'reasoning', text: part.text ?? '' });
      } else if (part.type === 'text') {
        blocks.push({ kind: 'text', text: part.text ?? '' });
      } else if (part.type === 'tool-call') {
        const prev = prevTools.get(part.id);
        blocks.push({
          kind: 'tool',
          tool: {
            callId: part.id,
            name: part.name,
            args: summarizeToolArguments(part.name, part.arguments),
            status: prev?.status ?? 'running',
            preview: prev?.preview ?? '',
          },
        });
      }
    }
    st.blocks = blocks;
    const u = d.usage ?? {};
    st.usage.inputTokens += u.inputTokens ?? 0;
    st.usage.outputTokens += u.outputTokens ?? 0;
    st.usage.cacheReadTokens += u.cacheReadTokens ?? 0;
    this.#schedule(st, null, true);
  }

  #onToolCall(st, d) {
    st.toolCount++;
    const existing = st.blocks.find((b) => b.kind === 'tool' && b.tool?.callId === d.callId);
    const tool = {
      callId: d.callId,
      name: d.name,
      args: summarizeToolArguments(d.name, d.arguments),
      status: 'running',
      preview: '',
    };
    if (existing) existing.tool = tool;
    else st.blocks.push({ kind: 'tool', tool });
    this.#schedule(st, null, true);
  }

  #onToolResult(st, d) {
    const callId = d.message?.source?.callId ?? d.message?.content?.[0]?.toolCallId;
    const block = st.blocks.find((b) => b.kind === 'tool' && b.tool?.callId === callId);
    const isError = Boolean(d.message?.content?.[0]?.isError);
    if (isError) st.errorCount++;
    if (block) {
      block.tool.status = isError ? 'error' : 'ok';
      block.tool.preview = previewToolResult(d.message?.content?.[0]?.content);
    }
    this.#schedule(st, null, true);
  }

  #endTurn(st, d) {
    st.endedAt = Date.now();
    st.phase = PHASE_BY_TURN_END[d.reason?.kind] ?? 'done';
    if (st.phase === 'error' && d.reason?.error?.message) {
      st.blocks.push({ kind: 'text', text: `⚠️ ${d.reason.error.code ?? 'ERROR'}: ${d.reason.error.message}` });
    }
    this.#schedule(st, null, true, true);
  }

  #footer(st) {
    const parts = [];
    if (st.toolCount) parts.push(`🔧×${st.toolCount}${st.errorCount ? `（❌${st.errorCount}）` : ''}`);
    const dur = st.startedAt ? fmtDuration((st.endedAt || Date.now()) - st.startedAt) : '';
    if (dur) parts.push(dur);
    const { inputTokens, outputTokens, cacheReadTokens } = st.usage;
    if (inputTokens || outputTokens) {
      const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      parts.push(`tok ↑${fmt(inputTokens)} ↓${fmt(outputTokens)}${cacheReadTokens ? ` ⚡${fmt(cacheReadTokens)}` : ''}`);
    }
    parts.push(hhmmss(st.endedAt || Date.now()));
    return parts.join(' · ') || '…';
  }

  /**
   * Coalesced card patch. `force` bypasses the throttle window; `final`
   * flushes and stops the timer. Never overlaps an in-flight send.
   */
  #schedule(st, _sessionId, force = false, final = false) {
    st.dirty = true;
    if (final) st.final = true;
    const due = st.lastPatchAt ? st.lastPatchAt + this.config.throttleMs : 0;
    const wait = force || final || st.final ? 0 : Math.max(0, due - Date.now());
    if (st.timer && !force && !final && st.timerWhen !== undefined && st.timerWhen <= wait) return; // earlier timer pending
    if (st.timer) clearTimeout(st.timer);
    st.timerWhen = wait;
    st.timer = setTimeout(() => {
      st.timer = null;
      this.#flush(st).catch((e) => log.error(`render: ${e.message}`));
    }, wait);
  }

  async #flush(st) {
    if (!st.dirty || st.sending) return;
    st.sending = true;
    st.dirty = false;
    try {
      const card = buildTurnCard(
        { ...st, footer: this.#footer(st) },
        this.config.cardTextLimit
      );
      if (!st.messageId) {
        const { messageId } = await this.transport.sendCard(st.chatId, card);
        st.messageId = messageId;
      } else {
        await this.transport.updateCard(st.messageId, card);
      }
      st.lastPatchAt = Date.now();
      if (st.final) st.final = false;
    } catch (e) {
      st.dirty = true; // retry on next schedule
      log.warn(`card patch failed: ${e.message}`);
      if (st.messageId == null) {
        // Card never landed — tell the chat instead of failing silently.
        try {
          await this.transport.sendCard(st.chatId, buildErrorCard('卡片更新失败', e.message));
        } catch {}
      }
    } finally {
      st.sending = false;
    }
  }
}
