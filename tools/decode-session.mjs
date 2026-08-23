#!/usr/bin/env node
/**
 * decode-session.mjs — 纯 Node 解码 DSH 会话日志（session.jsonl.zstd → JSONL）
 *
 * 背景：dump-session-events.mjs 依赖 zstdcat CLI（Windows 常缺失）。本工具
 * 直接移植 dsh-session-persistence-jsonl 的 scanZstdFrames 帧扫描算法，
 * 用 Node ≥22 的 zlib.zstdDecompressSync 逐帧解码，无外部依赖。
 *
 * Usage:
 *   node tools/decode-session.mjs <session.jsonl.zstd | session目录> [输出.jsonl]
 *   不给输出路径时写到 <输入>.decoded.jsonl 并打印统计（帧数/行数/尾部事件类型）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;

/** 与 dsh-session-persistence-jsonl lib/types/zstd.js scanZstdFrames 一致。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function resolveInput(arg) {
  const st = fs.statSync(arg);
  if (st.isDirectory()) {
    const f = ['session.jsonl.zstd', 'session.jsonl']
      .map((n) => path.join(arg, n))
      .find((x) => fs.existsSync(x));
    if (!f) throw new Error(`目录下没有 session.jsonl(.zstd): ${arg}`);
    return f;
  }
  return arg;
}

const input = resolveInput(process.argv[2]);
const output = process.argv[3] || `${input}.decoded.jsonl`;

const buffer = fs.readFileSync(input);
let text;
if (input.endsWith('.zstd')) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = [];
  for (const { start, end } of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(start, end)));
  }
  text = Buffer.concat(parts).toString('utf8');
  if (tornStart !== undefined) {
    console.error(`[warn] 尾部存在不完整帧（torn @${tornStart}），已按持久化契约忽略`);
  }
  console.error(`[info] frames=${frames.length} bytes=${text.length} → ${output}`);
} else {
  text = buffer.toString('utf8');
  console.error(`[info] plaintext bytes=${text.length} → ${output}`);
}
fs.writeFileSync(output, text, 'utf8');

// 统计行数与事件类型直方图（含 packed row）
const counts = new Map();
let lines = 0;
for (const line of text.split('\n')) {
  const s = line.trim();
  if (!s) continue;
  lines++;
  try {
    const r = JSON.parse(s);
    const t = r.type ?? '?';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  } catch {
    counts.set('<残行>', (counts.get('<残行>') ?? 0) + 1);
  }
}
console.error(`[info] lines=${lines}`);
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, n] of sorted) console.error(`  ${String(n).padStart(6)}  ${t}`);
