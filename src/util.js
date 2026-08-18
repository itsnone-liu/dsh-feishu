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
