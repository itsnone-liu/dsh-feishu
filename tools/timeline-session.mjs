#!/usr/bin/env node
/** Incident analysis: extract turn/error/retry timeline from a decoded session jsonl. */
import fs from 'node:fs';

const file = process.argv[2];
const since = process.argv[3] ? new Date(process.argv[3]) : new Date(0);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  const ts = j.ts ?? j.timestamp ?? j.time ?? null;
  const d = ts ? new Date(ts) : null;
  if (d && d < since) continue;
  const t = j.type;
  if (t === 'turn/start' || t === 'turn/end' || t === 'user/message' || t === 'llm/retry' || t === 'llm/retry-started' || t === 'agent/inbox/spliced' || t === 'request/context') {
    let detail = '';
    if (t === 'user/message') {
      detail = (j.data?.message?.content ?? []).map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join(' ').slice(0, 80);
    } else if (t === 'turn/end') {
      detail = JSON.stringify(j.data?.reason ?? {}).slice(0, 260);
    } else if (t === 'llm/retry') {
      detail = JSON.stringify(j.data).slice(0, 260);
    } else if (t === 'request/context') {
      detail = JSON.stringify(j.data);
    } else if (t === 'agent/inbox/spliced') {
      detail = JSON.stringify(j.data).slice(0, 160);
    }
    console.log(`${ts ?? '?'} ${t} ${detail}`);
  }
}
