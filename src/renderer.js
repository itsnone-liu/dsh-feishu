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
import fs from 'node:fs';
import path from 'node:path';

const PHASE_BY_TURN_END = {
  completed: 'done',
  error: 'error',
  cancelled: 'stopped',
  stopped: 'stopped',
  aborted: 'stopped',
};

/**
 * Quota/window errors (GLM 1308 …) get a friendly line instead of the raw
 * JSON dump — the auto-continue module schedules the recovery and explains
 * the plan in its own card, so the turn card only needs the essence.
 */
function friendlyTurnError(message) {
  const text = String(message ?? '');
  if (/\b1308\b|使用上限|额度|配额|quota|exhausted/i.test(text)) {
    const hm = /(\d{1,2}:\d{2})/.exec(text);
    return `⏳ 额度窗口用尽${hm ? `（提示重置于 ${hm[1]}）` : ''}，桥会按计划自动继续；期间你发消息即可接管。`;
  }
  return `⚠️ ${text}`;
}

export class TurnRenderer {
  constructor({ transport, config, store }) {
    this.transport = transport;
    this.config = config;
    /** BindingStore — to resolve the workspace for full-output dumps. */
    this.store = store ?? null;
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
    if (st.retryTimer) clearTimeout(st.retryTimer);
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
      /** Consecutive card-patch failures (backoff + fallback-new-card source). */
      failCount: 0,
      retryTimer: null,
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
      case 'llm/retry':
        // 上游限流/网络抖动时 dsh 会静默重试 5 次（每次约 20s），期间没有任何
        // assistant 输出 —— 卡片会空着「工作中」两三分钟（2026-08-26 空卡事故）。
        // 把重试进度显式画进卡片，用户就知道桥没死。
        if (d?.retry && d.retry <= (d.maxRetries ?? 5)) {
          st.retryNote = `⏳ 模型请求自动重试 ${d.retry}/${d.maxRetries ?? '?'}（${d.provider ?? 'model'}，${Math.round((d.delayMs ?? 0) / 1000)}s 后）`;
          this.#schedule(st, null, true);
        }
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
    st.retryNote = '';
    st.outputNote = '';
    st.outputDumped = false;
    st.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    st.toolCount = 0;
    st.errorCount = 0;
    st.phase = 'working';
    st.startedAt = Date.now();
    st.endedAt = 0;
    st.messageId = null;
    st.failCount = 0;
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
    this.#schedule(st, null, true);
  }

  #onChunk(st, d) {
    const c = d.chunk;
    if (!c) return;
    if (c.type === 'block-start') {
      if (c.blockType === 'text' || c.blockType === 'reasoning') {
        // A tool-call block earlier in the same step never lands here, so the
        // array can hold holes at lower indices. Store a placeholder that all
        // iteration sites must tolerate (see #blocks iter helpers in cards.js).
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
    for (const b of st.blocks) if (b?.kind === 'tool' && b.tool?.callId) prevTools.set(b.tool.callId, b.tool);
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
    st.retryNote = ''; // the request went through — retry status is stale
    const u = d.usage ?? {};
    st.usage.inputTokens += u.inputTokens ?? 0;
    st.usage.outputTokens += u.outputTokens ?? 0;
    st.usage.cacheReadTokens += u.cacheReadTokens ?? 0;
    this.#schedule(st, null, true);
  }

  #onToolCall(st, d) {
    st.toolCount++;
    const existing = st.blocks.find((b) => b?.kind === 'tool' && b.tool?.callId === d.callId);
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
    const block = st.blocks.find((b) => b?.kind === 'tool' && b.tool?.callId === callId);
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
    st.retryNote = '';
    if (st.phase === 'error' && d.reason?.error?.message) {
      st.blocks.push({ kind: 'text', text: friendlyTurnError(
        `${d.reason.error.code ?? 'ERROR'}: ${d.reason.error.message}`,
      ) });
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
    if (!st.dirty) return;
    if (st.sending) {
      // A previous flush is mid-flight (throttle vs turn/end racing). Just
      // returning here would DROP this update — including final turn/end
      // renders, which froze cards at "工作中" forever (2026-08-26). Re-arm a
      // short retry instead: it fires after the in-flight patch lands.
      if (!st.retryTimer) {
        st.retryTimer = setTimeout(() => {
          st.retryTimer = null;
          this.#flush(st).catch(() => {});
        }, 150);
        st.retryTimer.unref?.();
      }
      return;
    }
    st.sending = true;
    st.dirty = false;
    try {
      // Final flush of an oversized turn → dump the FULL text to the
      // workspace so the truncated card stays readable (R2 may later upgrade
      // this to a real Feishu file upload).
      if (st.final && !st.outputDumped) {
        const texts = st.blocks.filter((b) => b?.kind === 'text').map((b) => b.text);
        const total = texts.reduce((n, t) => n + t.length, 0);
        if (total > this.config.cardTextLimit) {
          const dest = this.#dumpFullOutput(st, texts);
          if (dest) st.outputNote = `📄 回复超长（${total} 字符），卡片已截断，完整内容：\`${dest}\``;
        }
        st.outputDumped = true;
      }
      const card = buildTurnCard(
        { ...st, blocks: st.blocks.filter(Boolean), footer: this.#footer(st) },
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
      st.failCount = 0;
    } catch (e) {
      st.dirty = true; // retry on next schedule
      st.failCount += 1;
      log.warn(`card patch failed (attempt ${st.failCount}): ${e.message}`);
      // Bounded backoff retry — a failed update must not freeze the card
      // forever, and repeated failures fall back to a FRESH card (the old
      // message may be unpatchable, e.g. deleted or too large).
      const base = Number(this.config.cardRetryBaseMs) > 0 ? Number(this.config.cardRetryBaseMs) : 1000;
      const backoff = Math.min(15 * base, base * 2 ** (st.failCount - 1));
      if (st.retryTimer) clearTimeout(st.retryTimer);
      if (st.failCount >= 5) {
        st.failCount = 0;
        st.messageId = null; // next flush sends a new card instead of patching
        st.retryTimer = setTimeout(() => {
          st.retryTimer = null;
          this.#flush(st).catch(() => {});
        }, backoff);
      } else {
        st.retryTimer = setTimeout(() => {
          st.retryTimer = null;
          this.#flush(st).catch(() => {});
        }, backoff);
      }
      if (st.messageId == null && st.failCount === 1) {
        // Card never landed — tell the chat instead of failing silently.
        try {
          await this.transport.sendCard(st.chatId, buildErrorCard('卡片更新失败', e.message));
        } catch {}
      }
    } finally {
      st.sending = false;
    }
  }

  /** Write the full text of an oversized turn under the workspace. */
  #dumpFullOutput(st, texts) {
    try {
      const cwd = this.store?.get(st.chatId)?.cwd || this.config.defaultCwd;
      if (!cwd) return null;
      const dir = path.join(cwd, '.feishu-outputs');
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dest = path.join(dir, `turn${st.turnNo}-${ts}.md`);
      fs.writeFileSync(dest, texts.join('\n\n---\n\n'), 'utf8');
      return dest;
    } catch (e) {
      log.warn(`full-output dump failed: ${e.message}`);
      return null;
    }
  }
}
