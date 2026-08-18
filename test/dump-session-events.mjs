#!/usr/bin/env node
/**
 * dump-session-events.mjs — 录制/检查 DSH 持久 session 的事件形状
 *
 * 数据源: $DSH_HOME/sessions/--<workspace>--/<session-id>/session.jsonl(.zstd)
 * 格式:   独立 zstd 帧拼接 + JSONL；首行是 SessionHeader，其余为存储记录
 *         （原样 SessionEvent，或 text-chunks/reasoning-chunks/tool-call-chunks packed row）。
 * 解码:   优先 import @deepseek-ai/dsh-session 的 decodeStorageRecord（无损、权威），
 *         解析路径: $DSH_SESSION_PKG > ~/.dsh/profiles/node_modules > 本地安装。
 *
 * Usage:
 *   node dump-session-events.mjs                     # 所有 session 概览
 *   node dump-session-events.mjs <id前缀|路径>        # header + 直方图 + 每类型形状样本
 *   node dump-session-events.mjs <sel> --type tool/call --full   # 完整事件 JSON
 *   node dump-session-events.mjs <sel> --raw         # 看原始存储行（含 packed row）
 *   node dump-session-events.mjs <sel> --json        # 机器可读（喂 renderer 开发）
 *
 * Flags:
 *   --type <t>   过滤事件类型（可重复；raw 模式下也可匹配 packed row 标签）
 *   --full       不截断打印
 *   --limit <n>  每类型采样上限，默认 2（--type 时默认 5）
 *   --raw        跳过 decodeStorageRecord
 *   --json       全量 JSON 输出（忽略 --limit；与 --raw 组合输出存储记录）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const positional = argv.filter((a) => !a.startsWith('--'));
const typeFilters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--type') typeFilters.push(argv[++i]);
  if (argv[i] === '--limit') var limitOverride = Number(argv[++i]);
}
if (argv.includes('--type') && typeFilters.some((t) => t == null)) {
  console.error('--type 需要一个值');
  process.exit(2);
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');

// ---------- 解压: zstdcat（Node 22 的 zlib.zstd 只解单帧，多帧文件必须走 CLI） ----------
function decompress(file) {
  const r = spawnSync('zstdcat', [file], { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`需要 zstd CLI（apt install zstd）: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`zstdcat 失败: ${r.stderr?.toString()?.slice(0, 200)}`);
  return r.stdout;
}

// ---------- decodeStorageRecord 解析 ----------
async function loadDecoder() {
  const candidates = [
    process.env.DSH_SESSION_PKG,
    path.join(DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js'),
    '@deepseek-ai/dsh-session',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const m = await import(/* @vite-ignore */ c);
      if (typeof m.decodeStorageRecord === 'function') return m.decodeStorageRecord;
    } catch {}
  }
  return null; // 调用方降级为 raw + 警告
}

// ---------- session 发现 ----------
function listSessions() {
  const out = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return out;
  for (const proj of fs.readdirSync(SESSIONS_ROOT)) {
    const projDir = path.join(SESSIONS_ROOT, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const id of fs.readdirSync(projDir)) {
      const dir = path.join(projDir, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      const f = ['session.jsonl.zstd', 'session.jsonl'].map((n) => path.join(dir, n)).find((x) => fs.existsSync(x));
      if (f) out.push({ id, proj, file: f });
    }
  }
  return out;
}

function resolveSelection(sel) {
  if (sel?.includes(path.sep) || sel?.endsWith('.jsonl') || sel?.endsWith('.zstd')) {
    let file = sel, id = path.basename(sel).replace(/^session\.(jsonl(\.zstd)?)$/, '');
    if (fs.statSync(sel).isDirectory()) {
      file = ['session.jsonl.zstd', 'session.jsonl'].map((n) => path.join(sel, n)).find((x) => fs.existsSync(x));
      id = path.basename(sel);
    }
    if (!file || !fs.existsSync(file)) throw new Error(`找不到 transcript: ${sel}`);
    return { id, file };
  }
  const all = listSessions();
  const hit = all.find((s) => s.id === sel) || all.find((s) => s.id.includes(sel));
  if (!hit) throw new Error(`没有匹配 "${sel}" 的 session（共 ${all.length} 个）`);
  return hit;
}

// ---------- 读取 + 解码 ----------
function readRecords(file) {
  const buf = file.endsWith('.zstd') ? decompress(file) : fs.readFileSync(file);
  const text = buf.toString('utf8');
  const records = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { bad++; } // 尾部残行按持久化契约忽略
  }
  return { records, bad };
}

function decodeAll(records, decode) {
  const events = [];
  const errors = [];
  for (const r of records) {
    if (r?.type === 'session') continue; // header
    if (!decode) { events.push(r); continue; }
    try {
      for (const e of decode(r)) events.push(e);
    } catch (e) {
      errors.push({ record: r, error: String(e?.message || e) });
    }
  }
  return { events, errors };
}

// ---------- 形状摘要 ----------
function shape(v, depth = 0, full = false) {
  if (full) return v;
  if (typeof v === 'string') return v.length > 100 ? v.slice(0, 100) + `…(+${v.length - 100})` : v;
  if (Array.isArray(v)) {
    if (v.length > 6) return [...v.slice(0, 6).map((x) => shape(x, depth + 1)), `…(+${v.length - 6})`];
    return v.map((x) => shape(x, depth + 1));
  }
  if (v && typeof v === 'object') {
    if (depth >= 5) return '{…}';
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shape(val, depth + 1);
    return o;
  }
  return v;
}

// ---------- 主流程 ----------
async function main() {
  const decode = flags.has('--raw') ? null : await loadDecoder();
  if (!decode && !flags.has('--raw')) console.error('[warn] decodeStorageRecord 不可用，按 --raw 处理（packed row 不会展开）');

  // 概览模式
  if (positional.length === 0) {
    const all = listSessions();
    if (all.length === 0) { console.error(`没有 session（${SESSIONS_ROOT}）`); process.exit(1); }
    console.log(`${SESSIONS_ROOT}  (${all.length} sessions)\n`);
    for (const s of all) {
      const { records } = readRecords(s.file);
      const header = records[0] ?? {};
      const types = records.filter((r) => r.type !== 'session').map((r) => r.type);
      const packed = types.filter((t) => /^(text|reasoning|tool-call)-chunks$/.test(t)).length;
      const size = fs.statSync(s.file).size;
      console.log(
        `${s.id.replace(/^session-/, '').slice(0, 8)}  ${new Date(header.createdAt ?? 0).toISOString().slice(0, 16)}  ${String(types.length - packed).padStart(5)}ev+${String(packed).padStart(4)}rows  ${(size / 1024).toFixed(0).padStart(5)}KB  ${header.cwd ?? '?'}  [${header.agentPreset ?? '-'}]`
      );
    }
    return;
  }

  const { id, file } = resolveSelection(positional[0]);
  const { records, bad } = readRecords(file);
  const header = records[0] ?? {};
  if (header.type !== 'session') console.error('[warn] 首行不是 SessionHeader');
  const { events, errors } = decodeAll(records, decode);

  // seq 连续性校验（README: events[i].seq === i；raw 模式下 packed row 占单槽，必然断，跳过）
  let seqBreak = 0;
  if (decode) for (let i = 0; i < events.length; i++) if (events[i]?.seq !== i) seqBreak++;

  // 机器可读输出：只输出 JSON，不混 preamble
  if (flags.has('--json')) {
    const out = typeFilters.length ? events.filter((e) => typeFilters.includes(e.type)) : events;
    process.stdout.write(JSON.stringify(out));
    return;
  }

  console.log(`# ${id}`);
  console.log(`file:   ${file}`);
  console.log(`header: ${JSON.stringify(shape(header, 0, flags.has('--full') || true))}`);
  console.log(`records:${records.length}  decoded events:${events.length}  残行:${bad}  解码错误:${errors.length}  seq断点:${decode ? seqBreak : 'n/a(raw)'}`);

  if (errors.length) {
    console.log('\n[decode errors]');
    for (const e of errors.slice(0, 3)) console.log(`  ${e.error}  <= ${JSON.stringify(shape(e.record))}`);
  }

  // 直方图
  const counts = new Map();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  console.log(`\n== 事件直方图（${decode ? '已解码' : 'raw'}） ==`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sorted) console.log(`${String(n).padStart(6)}  ${t}${typeFilters.includes(t) ? '   <-- filter' : ''}`);

  // 形状样本
  const wanted = typeFilters.length ? typeFilters : [...counts.keys()];
  const limit = limitOverride ?? (typeFilters.length ? 5 : 2);
  console.log(`\n== 形状样本 ==`);
  for (const t of wanted) {
    const hits = events.filter((e) => e.type === t);
    if (!hits.length) { console.log(`\n### ${t}  (0 条${counts.has(t) ? '' : '，本 session 无此类型'})`); continue; }
    const first = hits[0], last = hits[hits.length - 1];
    console.log(`\n### ${t}  (${hits.length} 条，示例 1 和 ${hits.length > 1 ? hits.length : 1})`);
    console.log(JSON.stringify(shape(first), null, 1));
    if (hits.length > 1) console.log(JSON.stringify(shape(last), null, 1));
    for (let i = 1; i < Math.min(limit, hits.length) - 1; i++) console.log(JSON.stringify(shape(hits[i])));
  }
}

main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
