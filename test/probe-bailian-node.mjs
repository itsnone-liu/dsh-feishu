#!/usr/bin/env node
import fs from 'node:fs';
import { parse } from 'yaml';

const creds = parse(fs.readFileSync('C:/Users/pc/.dsh/.credentials.yaml', 'utf8'));
const key = creds?.refs?.BAILIAN_TOKEN_PLAN_API_KEY;
if (!key) throw new Error('credential missing');
const base = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

async function probe(name, url, init = {}) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text();
    console.log(JSON.stringify({ name, ok: r.ok, status: r.status, ms: Date.now() - started, type: r.headers.get('content-type'), preview: text.slice(0, 300) }));
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    const causes = [];
    let x = e;
    while (x) { causes.push({ name: x.name, message: x.message, code: x.code, errno: x.errno, syscall: x.syscall, address: x.address, port: x.port }); x = x.cause; }
    console.log(JSON.stringify({ name, ok: false, ms: Date.now() - started, causes }));
    process.exitCode = 2;
  }
}

await probe('models', `${base}/models`, { method: 'GET' });
const common = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Reply exactly OK' }], max_tokens: 1024 };
await probe('chat-nonstream', `${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ ...common, stream: false }) });
await probe('chat-stream', `${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ ...common, stream: true, stream_options: { include_usage: true } }) });
