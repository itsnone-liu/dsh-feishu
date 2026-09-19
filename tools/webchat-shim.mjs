#!/usr/bin/env node
/**
 * webchat-shim.mjs — dsh (openai-responses provider) → codex-chatgpt-web daemon
 * 的协议适配薄层（2026-09-20 网页额度相位改造）。
 *
 * 背景：daemon (127.0.0.1:17841) 的 /v1/responses 对 chatgpt-web/* 模型有
 * Codex CLI 特有的协议要求（dev-chat/driver.ts requestBody 的形态）：
 *   ① body.client_metadata["x-codex-turn-metadata"] = JSON 字符串
 *      {thread_id, turn_id, request_kind:"turn", sandbox:"none", workspaces:{…}}
 *   ② input 的 message item 带 internal_chat_message_metadata_passthrough.turn_id
 *   ③ turn_id 每回合唯一（浏览器回合重试预算）；thread_id 稳定（tab lease 亲和，
 *      daemon 最多 5 个并发 tab）
 * 缺任一 → "ChatGPT web requires native Codex turn_id metadata for …" 失败。
 * dsh 的 pi-ai 客户端发不出这些字段 → 本 shim 在中间补齐。
 *
 * 会话亲和：用请求首条非空 user/system 文本前 400 字符的指纹 → 稳定 thread_id
 * （同一对话连续请求命中同一浏览器 tab；新对话新 tab；>5 并发对话由 daemon 拒绝，
 *  plan/review 场景实际不会触顶）。每请求生成新 turn_id（uuid）。
 *
 * 其余一切（模型、SSE 流、鉴权头）原样透传。GET /v1/models 原样代理。
 *
 * 用法：node webchat-shim.mjs            （监听 127.0.0.1:17842 → 17841）
 *   环境变量：CHATGPT_WEB_UPSTREAM（默认 http://127.0.0.1:17841）
 *             WEBCHAT_SHIM_PORT（默认 17842）
 */
import http from 'node:http';
import crypto from 'node:crypto';

const UPSTREAM = process.env.CHATGPT_WEB_UPSTREAM || 'http://127.0.0.1:17841';
const PORT = Number(process.env.WEBCHAT_SHIM_PORT || 17842);
const u = new URL(UPSTREAM);

/** 请求体 → 对话指纹（首条非空消息文本前 400 字符）。 */
function conversationFingerprint(body) {
  const inputs = Array.isArray(body?.input) ? body.input : [];
  for (const item of inputs) {
    if (!item || typeof item !== 'object') continue;
    if (item.role !== 'user' && item.role !== 'system' && item.role !== 'developer') continue;
    const parts = Array.isArray(item.content) ? item.content : [item.content];
    for (const p of parts) {
      const text = typeof p === 'string' ? p : p?.type === 'input_text' || p?.type === 'text' ? p.text : '';
      if (typeof text === 'string' && text.trim()) {
        return crypto.createHash('sha256').update(text.trim().slice(0, 400)).digest('hex').slice(0, 24);
      }
    }
  }
  // input 是字符串的形态
  if (typeof body?.input === 'string' && body.input.trim()) {
    return crypto.createHash('sha256').update(body.input.trim().slice(0, 400)).digest('hex').slice(0, 24);
  }
  return 'default';
}

const threadIds = new Map();   // fingerprint → thread_id（稳定亲和）

function threadIdFor(fp) {
  let t = threadIds.get(fp);
  if (!t) {
    t = `thread_shim_${crypto.randomUUID().replaceAll('-', '')}`;
    threadIds.set(fp, t);
    if (threadIds.size > 32) {  // 简单防漏：太老的就淘汰（LRU 简化版）
      const first = threadIds.keys().next().value;
      threadIds.delete(first);
    }
  }
  return t;
}

/** 增强 POST /v1/responses 请求体。返回新 body（原对象不 mutate）。 */
function enhanceResponsesBody(rawBody) {
  const body = JSON.parse(rawBody);   // 解析失败由调用方返回 400
  const turnId = `turn_shim_${crypto.randomUUID().replaceAll('-', '')}`;
  const threadId = threadIdFor(conversationFingerprint(body));

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => {
      if (!item || typeof item !== 'object' || item.type === 'function_call' || item.type === 'function_call_output' || item.type === 'reasoning') return item;
      return { ...item, internal_chat_message_metadata_passthrough: { turn_id: turnId } };
    });
  }
  body.client_metadata = {
    ...(body.client_metadata ?? {}),
    'x-codex-turn-metadata': JSON.stringify({
      thread_id: threadId,
      turn_id: turnId,
      request_kind: 'turn',
      sandbox: 'none',
      workspaces: {},
    }),
  };
  return body;
}

const server = http.createServer((req, res) => {
  // 探针端点：daemon 进程活着（任何 HTTP 响应，含 401/404）= 网页通道在线。
  // 不发真实对话（省网页额度）；登录态损坏等深层故障由真实回合失败→桥降级兜底。
  if (req.method === 'GET' && req.url === '/__health') {
    const probe = http.request(
      { hostname: u.hostname, port: u.port, path: '/v1/models', method: 'GET', headers: { authorization: 'Bearer health-probe' } },
      (up) => { up.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, upstreamStatus: up.statusCode })); },
    );
    probe.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false })); });
    probe.setTimeout(4000, () => { probe.destroy(); res.writeHead(502); res.end('{"ok":false}'); });
    probe.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['transfer-encoding'];

    let payload = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url === '/v1/responses' && payload.length) {
      try {
        payload = Buffer.from(JSON.stringify(enhanceResponsesBody(payload.toString('utf8'))));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `webchat-shim: bad JSON body: ${e.message}`, type: 'invalid_request_error' } }));
        return;
      }
    }
    if (payload.length) headers['content-length'] = String(payload.length);

    const upstreamReq = http.request(
      { hostname: u.hostname, port: u.port, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstreamReq.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `webchat-shim: upstream ${e.message}`, type: 'server_error' } }));
    });
    if (payload.length) upstreamReq.write(payload);
    upstreamReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[webchat-shim] listening on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
