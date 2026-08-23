#!/usr/bin/env node
/**
 * analyze-session.mjs — 分析解码后的 session JSONL：时间线 + turn/end + 错误 + 尾部事件
 * Usage: node tools/analyze-session.mjs <decoded.jsonl> [--tail N] [--full]
 */
import fs from 'node:fs';

const file = process.argv[2];
const tailN = Number(process.argv.includes('--tail') ? process.argv[process.argv.indexOf('--tail') + 1] : 40);
const full = process.argv.includes('--full');

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const records = [];
for (const l of lines) {
  try { records.push(JSON.parse(l)); } catch {}
}

const ts = (t) => new Date(t).toISOString().slice(11, 23);
const brief = (r) => {
  const d = r.data ?? {};
  switch (r.type) {
    case 'session': return `header cwd=${r.cwd} preset=${r.agentPreset}`;
    case 'user/message': {
      const c = d.content ?? [];
      const parts = c.map((b) => b.type === 'text' ? `text(${(b.text ?? '').slice(0, 80)})` : b.type).join(',');
      return `content=[${parts}]`;
    }
    case 'assistant/message': {
      const c = d.message?.content ?? [];
      const parts = c.map((b) => b.type === 'text' ? `text(${(b.text ?? '').length}ch)` : b.type === 'tool-call' ? `tool:${b.name}` : b.type).join(',');
      return `content=[${parts}]`;
    }
    case 'tool/call': return `${d.name} callId=${(d.callId ?? '').slice(0, 12)}`;
    case 'tool/result': {
      const c0 = d.message?.content?.[0] ?? {};
      return `callId=${(d.message?.source?.callId ?? c0.toolCallId ?? '').slice(0, 12)} err=${c0.isError ? 'YES' : 'no'} ${(String(c0.content ?? '')).slice(0, 120).replace(/\n/g, ' ')}`;
    }
    case 'turn/end': return `reason=${JSON.stringify(d.reason)}`;
    case 'turn/start': return `turn=${d.turn}`;
    case 'text-chunks': case 'reasoning-chunks': case 'tool-call-chunks':
      return `turn=${d.turn} step=${d.step} idx=${d.index} n=${d.texts?.length ?? d.dt?.length}`;
    default: return JSON.stringify(d).slice(0, 150);
  }
};

// 时间线（跳过 chunk packed rows，保持紧凑）
console.log(`== ${records.length} records ==`);
for (const r of records) {
  if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'assistant/chunk'].includes(r.type)) continue;
  const t = r.time ?? r.time0 ?? 0;
  console.log(`${String(r.seq ?? r.seq0 ?? '?').padStart(5)} ${ts(t)} ${r.type.padEnd(20)} ${full ? JSON.stringify(r.data).slice(0, 2000) : brief(r)}`);
}

// 尾部原始事件（含 packed rows）
console.log(`\n== tail ${tailN} (raw records) ==`);
for (const r of records.slice(-tailN)) {
  const t = r.time ?? r.time0 ?? 0;
  console.log(`${String(r.seq ?? r.seq0 ?? '?').padStart(5)} ${ts(t)} ${r.type.padEnd(20)} ${brief(r)}`);
}
