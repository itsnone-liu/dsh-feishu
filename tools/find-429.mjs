#!/usr/bin/env node
/** 上午错误全景：1210 失败回合 + 429 配额事件的完整文本 */
import fs from 'node:fs';

const f = 'D:/qjcNetDiskDownload/dsh-feishu/research/out/session-dd6a1a26-feb1-4e39-b437-017689bb8b11.jsonl';
const recs = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// 1) 1210 失败的 turn/end 清单
const failedTurns = [];
for (const r of recs) {
  if (r.type === 'turn/end' && /1210/.test(JSON.stringify(r.data))) {
    failedTurns.push({ seq: r.seq, time: new Date(r.time).toISOString().slice(5, 19), turn: r.data.turn });
  }
}
console.log('== 1210 失败回合 ==');
console.log(failedTurns.map((t) => `${t.time} turn=${t.turn} seq=${t.seq}`).join('\n') || '(无)');

// 2) 429 事件全文
console.log('\n== 429/配额事件 ==');
for (const r of recs) {
  const d = JSON.stringify(r.data ?? {});
  if (d.includes('429') || d.includes('1308') || d.includes('使用上限')) {
    console.log(`--- ${new Date(r.time ?? r.time0).toISOString().slice(5, 19)} seq=${r.seq ?? r.seq0} ${r.type}`);
    console.log(d.slice(0, 700));
  }
}

// 3) 第一个识图尝试（读图片失败）的时间线
console.log('\n== 图片准入拒绝(上午第一次) ==');
for (const r of recs) {
  const d = JSON.stringify(r.data ?? {});
  if (d.includes('does not declare image input')) {
    console.log(`--- ${new Date(r.time ?? r.time0).toISOString().slice(5, 19)} seq=${r.seq ?? r.seq0}`);
    console.log(d.slice(0, 300));
    break;
  }
}

// 4) 自杀重启命令（turn 11 最后）
console.log('\n== turn 11 最后的 pwsh 命令(自杀重启) ==');
for (const r of recs) {
  if (r.type === 'tool/call' && r.seq === 95875) {
    console.log(new Date(r.time).toISOString().slice(5, 19));
    console.log(JSON.parse(r.data.arguments).command);
  }
}
