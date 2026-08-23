#!/usr/bin/env node
/** find-errors.mjs — 在解码后的会话里找错误证据：turn/end error、isError 工具结果、1210 等 */
import fs from 'node:fs';
import path from 'node:path';

const dir = 'D:/qjcNetDiskDownload/dsh-feishu/research/out';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const NEEDLES = ['1210', 'log-reconstruction', 'desync', 'image', 'glm-4.5v', 'glm-4.6v', 'vision'];

for (const f of files) {
  const recs = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log(`\n===== ${f} (${recs.length} records)`);
  for (const r of recs) {
    const d = JSON.stringify(r.data ?? {});
    const isErrTurnEnd = r.type === 'turn/end' && (r.data?.reason?.kind === 'error' || r.data?.reason?.kind === 'aborted' || r.data?.reason?.kind === 'cancelled');
    const isErrTool = r.type === 'tool/result' && d.includes('"isError":true');
    const has1210 = d.includes('1210');
    const hasDesync = d.includes('log-reconstruction') || d.includes('desync');
    if (isErrTurnEnd || has1210 || hasDesync) {
      const t = r.time ?? r.time0 ?? 0;
      console.log(`  ${new Date(t).toISOString().slice(5, 23)} seq=${r.seq ?? r.seq0} ${r.type} :: ${d.slice(0, 600)}`);
    } else if (isErrTool && (has1210 || d.includes('image') || d.includes('model'))) {
      const t = r.time ?? r.time0 ?? 0;
      console.log(`  ${new Date(t).toISOString().slice(5, 23)} seq=${r.seq ?? r.seq0} TOOLERR ${r.type} :: ${d.slice(0, 400)}`);
    }
  }
}
