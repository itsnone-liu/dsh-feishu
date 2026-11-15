/**
 * Voice ingress: let the voice service submit a user message into an existing
 * Feishu chat binding, and stream the assistant's text back.
 *
 * Why this lives inside the bridge: the audio channel already terminates in
 * `server/` (the Passport voice service), but the *conversation* must land in
 * the same session the user types into. The bridge is the only owner of that
 * session (`driver.ensure` / `driver.submit`), so the voice path enters here as
 * one more inbound transport — no second session, no second memory.
 *
 * Protocol (newline-delimited JSON over a unix socket):
 *
 *   client → {"id":1,"op":"ask","text":"..."}     submit a spoken turn
 *   client → {"id":1,"op":"cancel"}               stop generating this turn
 *   client → {"id":1,"op":"ping"}                 liveness
 *
 *   server → {"type":"ack","id":1}
 *   server → {"type":"delta","id":1,"text":"..."}  text-delta only, in order
 *   server → {"type":"done","id":1,"cancelled":false}
 *   server → {"type":"error","id":1,"message":"..."}
 *
 * Design notes that matter:
 * - `reasoning-delta` chunks are dropped: they are the model thinking, and
 *   speaking them would be both wrong and long.
 * - Deltas are forwarded raw. Sentence splitting belongs to the consumer (TTS),
 *   because only it knows its own synthesis granularity.
 * - Everything is injected (`router`, `driver`, `store`, `log`) so the module
 *   can be tested without dsh or Feishu running.
 * - The socket is 0600 and local-only: it drives a real session with real tools.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** How long a single spoken turn may run before we give up on it. */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
/** How long to wait for the first event after an ask. */
const FIRST_EVENT_MS = 60 * 1000;

export function createVoiceIn({ router, driver, store, config, log, socketPath }) {
  const cfg = config?.voice ?? {};
  const chatId = cfg.chatId;
  // The router drops any inbound message whose openId is not whitelisted
  // (`router.js:127`), so a synthetic sender would be silently discarded and the
  // voice service would hear nothing at all. Default to the owner: the first
  // allowed open id, which is the account that talks to this bot.
  const configuredOpenId = cfg.openId || config?.allowedOpenIds?.[0] || '';
  const openIdWhitelisted = () =>
    Boolean(configuredOpenId) && (config?.allowedOpenIds ?? []).includes(configuredOpenId);
  const sockPath = socketPath || cfg.socketPath || '/tmp/dsh-feishu-voice.sock';

  let server = null;
  let clients = new Set();
  let active = null; // { id, chatId, sessionId, blockKinds: Map, timer, firstTimer }
  let seq = 0;

  function send(socket, obj) {
    try {
      if (socket && !socket.destroyed) socket.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      log?.warn?.(`voice: write failed: ${e.message}`);
    }
  }

  function broadcast(obj, socket) {
    if (socket) return send(socket, obj);
    for (const c of clients) send(c, obj);
  }

  function clearTimers() {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    if (active.firstTimer) clearTimeout(active.firstTimer);
    active.timer = null;
    active.firstTimer = null;
  }

  function finish(obj) {
    if (!active) return;
    clearTimers();
    broadcast(obj, active.socket);
    active = null;
  }

  /** Resolve which session this chat currently talks to (changes on /new). */
  function sessionOf(chatIdValue) {
    try {
      return store?.get?.(chatIdValue)?.sessionId ?? null;
    } catch {
      return null;
    }
  }

  function ask(socket, id, text) {
    if (!chatId) {
      send(socket, { type: 'error', id, message: 'voice.chatId 未配置' });
      return;
    }
    if (!openIdWhitelisted()) {
      // Refuse loudly here: the alternative is the router dropping the message
      // while every other layer reports success.
      send(socket, {
        type: 'error', id,
        message: `voice 的 openId 不在 allowedOpenIds 里（当前 ${configuredOpenId || '空'}）`,
      });
      return;
    }
    if (active) {
      send(socket, { type: 'error', id, message: '上一轮还没结束', busyWith: active.id });
      return;
    }
    const sessionId = sessionOf(chatId);
    // If the agent is mid-turn, our submit is a *steer*: the running turn will
    // end first, and only then does the user's new turn start. Treating that
    // first turn/end as ours answered an interrupting question with an empty
    // `done` -- the exact failure seen on the first live device turn.
    // driver.live maps sessionId → {handle, agent} (or {agent}), not the agent
    // itself. Reading .status off the wrapper is always undefined, so steer
    // detection silently never fired -- exposed by the missing log line on the
    // first real steering turn.
    const entry = sessionId ? driver?.live?.get?.(sessionId) : null;
    const agentNow = entry?.agent ?? entry ?? null;
    const steering = Boolean(agentNow && agentNow.status === 'running');
    active = {
      id, chatId, sessionId, socket, blockKinds: new Map(),
      timer: null, firstTimer: null,
      skipEnds: steering ? 1 : 0,   // ignore the in-flight turn's end(s)
    };
    if (steering) log?.info?.(`voice: ask#${id} steers a running turn; its end is not ours`);
    active.firstTimer = setTimeout(() => {
      if (!active || active.id !== id) return;
      finish({ type: 'error', id, message: '提交后没有任何事件（turn/start 未到达）' });
    }, FIRST_EVENT_MS);
    active.timer = setTimeout(() => {
      if (!active || active.id !== id) return;
      cancel(id, 'timeout');
    }, ASK_TIMEOUT_MS);

    send(socket, { type: 'ack', id, sessionId });
    log?.info?.(`voice: ask#${id} → chat=${chatId} session=${sessionId ?? '(new)'}`);
    try {
      // Same entry point as a Feishu message: commands, per-chat queue and
      // binding all behave identically. `messageId` keeps the router's dedupe
      // from collapsing two identical sentences into one turn.
      router.onMessage({
        chatId,
        text,
        openId: configuredOpenId,
        messageId: `voice-${Date.now()}-${++seq}`,
      });
    } catch (e) {
      finish({ type: 'error', id, message: `提交失败：${e.message}` });
    }
  }

  function cancel(id, reason = 'client') {
    if (!active) {
      broadcast({ type: 'done', id, cancelled: true });
      return;
    }
    const target = active;
    const sessionId = target.sessionId ?? sessionOf(target.chatId);
    try {
      const entry = sessionId ? driver?.live?.get?.(sessionId) : null;
      const agent = entry?.agent ?? entry ?? null;   // live stores wrappers
      if (agent && driver?.stop) driver.stop(agent);
      log?.info?.(`voice: cancel#${target.id} (${reason}) session=${sessionId ?? '?'}`);
    } catch (e) {
      log?.warn?.(`voice: cancel failed: ${e.message}`);
    }
    finish({ type: 'done', id: target.id, cancelled: true });
  }

  /**
   * Feed from the bridge's existing `session/event` listener.
   * Never throws: dsh calls listeners synchronously inside session.append().
   */
  function onSessionEvent(session, event) {
    try {
      if (!active) return;
      if (active.sessionId && session?.id && session.id !== active.sessionId) return;
      const type = event?.type;
      if (!type) return;

      if (type === 'turn/start') {
        // First turn after the ask: adopt the session if we did not know it yet
        // (a brand-new chat has no binding until driver.ensure runs).
        if (!active.sessionId) active.sessionId = session.id;
        if (active.firstTimer) {
          clearTimeout(active.firstTimer);
          active.firstTimer = null;
        }
        // A turn that starts *while we are skipping ends* is still the old one
        // finishing its tail; only a start after the skipped end is ours.
        if (active.skipEnds > 0 && active.started) return;
        active.started = true;
        return;
      }
      if (type === 'assistant/chunk') {
        const chunk = event.data?.chunk;
        if (!chunk) return;
        if (chunk.type === 'block-start') {
          active.blockKinds.set(chunk.index, chunk.blockType);
          return;
        }
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          if (active.blockKinds.get(chunk.index) === 'reasoning') return;
          if (chunk.text) send(active.socket, { type: 'delta', id: active.id, text: chunk.text });
        }
        return;
      }
      if (type === 'turn/end') {
        if (active.skipEnds > 0) {
          active.skipEnds -= 1;
          active.started = false;      // next turn/start is the steered one
          // The skipped end proves the pipeline is alive; the steered turn has
          // not started yet. Letting the first-event timer keep running killed
          // a healthy steer whose old turn simply took longer than the timer
          // (a long reply in flight at ask time).
          if (active.firstTimer) {
            clearTimeout(active.firstTimer);
            active.firstTimer = null;
          }
          log?.info?.(`voice: ask#${active.id} skipped the steered turn's end (still waiting for our turn)`);
          return;
        }
        finish({ type: 'done', id: active.id, cancelled: false, reason: event.data?.reason });
      }
    } catch (e) {
      log?.error?.(`voice: onSessionEvent failed (contained): ${e?.stack ?? e}`);
    }
  }

  function handleClient(socket) {
    clients.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send(socket, { type: 'error', id: null, message: 'bad json' });
          continue;
        }
        const id = msg.id ?? null;
        try {
          if (msg.op === 'ask' && typeof msg.text === 'string') ask(socket, id, msg.text);
          else if (msg.op === 'cancel') cancel(id);
          else if (msg.op === 'ping') send(socket, { type: 'pong', id });
          else send(socket, { type: 'error', id, message: `unknown op ${msg.op}` });
        } catch (e) {
          send(socket, { type: 'error', id, message: String(e?.message ?? e) });
        }
      }
    });
    socket.on('error', (e) => log?.warn?.(`voice: client error: ${e.message}`));
    socket.on('close', () => clients.delete(socket));
  }

  function start() {
    try {
      fs.mkdirSync(path.dirname(sockPath), { recursive: true });
      if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
      server = net.createServer(handleClient);
      server.on('error', (e) => log?.error?.(`voice: server error: ${e.message}`));
      server.listen(sockPath, () => {
        try {
          fs.chmodSync(sockPath, 0o600);
        } catch {}
        log?.info?.(`voice: listening on ${sockPath} (chat=${chatId ?? 'unset'}, `
          + `openId=${configuredOpenId || 'UNSET'}${openIdWhitelisted() ? '' : ' ⚠ not whitelisted'})`);
      });
    } catch (e) {
      log?.error?.(`voice: failed to start: ${e.message}`);
    }
    return api;
  }

  function stop() {
    try {
      if (active) cancel(active.id, 'shutdown');
      for (const c of clients) c.destroy();
      clients = new Set();
      server?.close();
      if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
    } catch {}
  }

  const api = {
    start,
    stop,
    onSessionEvent,
    /** test/diagnostic only */
    _state: () => ({ active, clients: clients.size, socketPath: sockPath }),
  };
  return api;
}