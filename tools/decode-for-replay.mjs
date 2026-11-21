#!/usr/bin/env node
// Stream-decode a dsh session log (zstd, multi-frame) to plaintext jsonl.
// Node's one-shot zstdDecompressSync stops after the first frame, which is why
// a 2MB session decoded to a 187-byte header-only stub. Use a stream reader.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const inp = process.argv[2];
const out = process.argv[3] || 'C:/Users/pc/AppData/Local/Temp/sess_replay.jsonl';
if (!inp) { console.error('usage: decode-for-replay.mjs <session.jsonl.zstd> [out]'); process.exit(1); }

await pipeline(
  fs.createReadStream(inp),
  zlib.createZstdDecompress(),
  fs.createWriteStream(out)
);

const text = fs.readFileSync(out, 'utf8');
const lines = text.split('\n').filter(Boolean);
console.log('in :', inp, fs.statSync(inp).size, 'bytes');
console.log('out:', out, text.length, 'bytes');
console.log('lines:', lines.length);
const types = {};
let bad = 0;
for (const l of lines) { try { const o = JSON.parse(l); types[o.type] = (types[o.type] || 0) + 1; } catch { bad++; } }
console.log('unparsable lines:', bad);
console.log('top events:', Object.entries(types).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>`${k}:${v}`).join('  '));