/** Shared helpers: ids, truncation, time formatting, markdown escaping. */
import { randomUUID } from 'node:crypto';

/** Millisecond timestamp → local HH:MM:SS. */
export function hhmmss(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Duration ms → "1m23s" style short form. */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Fresh session id in the harness's `session-<uuid>` shape. */
export function newSessionId() {
  return `session-${randomUUID()}`;
}

/**
 * Group-message admission per config.groups:
 *  - 'off'     p2p only, never respond in groups (default, fail-closed)
 *  - 'mention' only when the bot itself is @-mentioned; unknown bot identity
 *              (open_id unresolvable) also fails closed
 *  - 'all'     any group message (sender still passes the open_id whitelist)
 * Non-text messages in groups require 'all' (images/files cannot carry a
 * mention). Mention shape per official docs: { key: '@_user_1',
 * id: { open_id } } — to be cross-checked by research R2.
 * @returns {{ ok: boolean, botMentionKey?: string }}
 */
export function groupAdmission(config, chatType, messageType, mentions = [], botOpenId = null) {
  if (chatType === 'p2p') return { ok: true };
  const mode = config.groups ?? 'off';
  if (mode === 'off') return { ok: false, reason: 'groups=off（仅私聊响应，config.json 可设 groups）' };
  if (mode === 'all') return { ok: true };
  // 'mention'
  if (messageType !== 'text') return { ok: false, reason: 'groups=mention 只响应文本，非文本消息被丢弃' };
  if (!botOpenId) return { ok: false, reason: 'bot open_id 未解析，群聊 @ 门控失效关闭' };
  const hit = (mentions ?? []).find((m) => m?.id?.open_id === botOpenId || m?.open_id === botOpenId);
  return hit ? { ok: true, botMentionKey: hit.key } : { ok: false, reason: 'groups=mention 需 @机器人，本消息未提及' };
}

/** Random interaction id (ask / approval cards). */
export function newInteractionId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Clamp a string to `max` chars keeping head and tail with an elision marker. */
export function clamp(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.7);
  const tail = Math.floor(max * 0.25);
  return `${text.slice(0, head)}\n\n…（已截断 ${text.length - head - tail} 字符）…\n\n${text.slice(-tail)}`;
}

/** Escape lark_md sensitive characters so model output cannot break card layout. */
export function mdEscape(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Summarize a tool-call arguments JSON string for one line of card text:
 * bash → first command line; otherwise short key=value sketch.
 */
export function summarizeToolArguments(name, argsJson) {
  let args;
  try {
    args = JSON.parse(argsJson ?? '{}');
  } catch {
    return clamp(String(argsJson ?? ''), 120);
  }
  if (name === 'bash' && typeof args.command === 'string') {
    return clamp(args.command.split('\n')[0], 160);
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return '{}';
  return keys
    .slice(0, 3)
    .map((k) => `${k}=${clamp(JSON.stringify(args[k]) ?? '', 40)}`)
    .join(' ')
    .concat(keys.length > 3 ? ' …' : '');
}

/** One preview line from a tool-result content block array. */
export function previewToolResult(contentBlocks) {
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return clamp(b.text.trim().split('\n')[0], 100);
    }
  }
  return '';
}

/** Simple retrying delay helper. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sniff an image's media type from magic bytes (Feishu downloads carry no
 * usable content-type). Returns one of the four media types the attachment
 * service accepts, or null when the bytes are none of them.
 */
export function sniffImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const b = bytes;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
