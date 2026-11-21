/**
 * send_file — outbound file delivery tool for the Feishu bridge.
 *
 * Closes the "agent → user" file gap permanently (2026-10-28): the transport
 * only ever had sendCard/sendText, so every "发我文件" request meant ad-hoc
 * scripts (see D:\dsh-install\_send_files_feishu.py, now superseded). This
 * tool is registered once at bridge boot — every session gets it for free.
 *
 * Companion inbound change: transports now also accept audio/media messages
 * (voice & video) and persist them like files under <workspace>/.feishu-files.
 *
 * Flow per file (open platform REST, same app credentials as the bridge):
 *   1. tenant_access_token (cached until expiry − 120 s)
 *   2a. images → POST /open-apis/im/v1/images   (image_type=message) → image_key
 *       → im/v1/messages msg_type=image
 *   2b. else   → POST /open-apis/im/v1/files    (file_type by extension) → file_key
 *       → im/v1/messages msg_type=file
 * Limits: 30 MB per file (Feishu upload cap), 10 files per call.
 *
 * Chat routing: `state.lastChatId` is set by the router on every accepted
 * inbound message (single-user bridge, whitelist-gated). An explicit
 * `chat_id` argument overrides; without either the tool fails loudly.
 */
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { log } from './log.js';

const FILE_TYPES = new Set([
  'opus', 'mp4', 'mp3', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'stream',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const DEFAULTS = {
  /** `false` disables the tool. */
  enabled: true,
  /** Per-file upload cap (Feishu im/v1/files limit is 30 MB). */
  maxBytes: 30 * 1024 * 1024,
  /** Max files per single tool call. */
  maxFiles: 10,
};

export function resolveSendConfig(raw) {
  if (raw === false) return { ...DEFAULTS, enabled: false };
  return { ...DEFAULTS, ...(raw ?? {}) };
}

/** tenant_access_token with cache. Returns { token, expiresAt }. */
const tokenCache = { token: '', expiresAt: 0 };
async function tenantToken(apiBase, appId, appSecret) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`tenant_access_token ${body.code}: ${body.msg}`);
  tokenCache.token = body.tenant_access_token;
  tokenCache.expiresAt = now + (Number(body.expire) || 3600) * 1000 - 120_000;
  return tokenCache.token;
}

/** feishu file_type for an extension ('stream' is the universal fallback). */
function fileTypeOf(ext) {
  const t = ext.replace(/^\./, '').toLowerCase();
  return FILE_TYPES.has(t) ? t : 'stream';
}

/** Upload one file; returns {kind:'file', fileKey} | {kind:'image', imageKey}. */
async function uploadOne(apiBase, token, absPath, maxBytes) {
  const st = await fsp.stat(absPath);
  if (!st.isFile()) throw new Error(`不是文件：${absPath}`);
  if (st.size > maxBytes) {
    throw new Error(`文件过大：${path.basename(absPath)} ${(st.size / 1048576).toFixed(1)}MB > ${Math.round(maxBytes / 1048576)}MB`);
  }
  const buf = await fsp.readFile(absPath);
  const name = path.basename(absPath);
  const ext = path.extname(name).toLowerCase();
  const headers = { Authorization: `Bearer ${token}` };

  if (IMAGE_EXTS.has(ext)) {
    const fd = new FormData();
    fd.append('image_type', 'message');
    fd.append('image', new Blob([buf]), name);
    const res = await fetch(`${apiBase}/open-apis/im/v1/images`, { method: 'POST', headers, body: fd });
    const body = await res.json();
    if (body.code !== 0) throw new Error(`im/v1/images ${body.code}: ${body.msg}`);
    return { kind: 'image', imageKey: body.data?.image_key ?? '' };
  }

  const fd = new FormData();
  fd.append('file_type', fileTypeOf(ext));
  fd.append('file_name', name);
  fd.append('file', new Blob([buf]), name);
  const res = await fetch(`${apiBase}/open-apis/im/v1/files`, { method: 'POST', headers, body: fd });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`im/v1/files ${body.code}: ${body.msg}`);
  return { kind: 'file', fileKey: body.data?.file_key ?? '' };
}

/** Send the uploaded resource as a message to chatId. Returns message_id. */
async function sendMessage(apiBase, token, chatId, uploaded) {
  const content = uploaded.kind === 'image'
    ? JSON.stringify({ image_key: uploaded.imageKey })
    : JSON.stringify({ file_key: uploaded.fileKey });
  const res = await fetch(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: uploaded.kind, content }),
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`im/v1/messages ${body.code}: ${body.msg}`);
  return body.data?.message_id ?? '';
}

/**
 * Register `send_file`. `state` is the router-shared { lastChatId } ref.
 * @returns {Function|null} disposer (null when disabled / service absent).
 */
export function installSendFileTool(ctx, rawCfg, cfg, state) {
  const sc = resolveSendConfig(rawCfg);
  if (!sc.enabled) return null;
  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    log.warn('send_file not registered: tools service unavailable');
    return null;
  }
  if (!cfg.appId || !cfg.appSecret) {
    log.warn('send_file not registered: FEISHU_APP_ID/SECRET missing');
    return null;
  }

  const def = {
    name: 'send_file',
    description:
      '把本地文件发送到用户的飞书聊天（出站文件通道）。当用户要求"把文件/结果/视频/音频发给我"时使用，不要再用临时脚本。' +
      '支持任意类型：图片（png/jpg/webp/gif 以图片消息发送，其余一律以文件消息发送）、音频、视频、文档等。' +
      '单文件上限 30MB，单次最多 10 个文件。发送结果以文本返回每文件的飞书 message_id。',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '本地绝对路径数组（与 file 二选一，files 优先）',
        },
        file: {
          type: 'string',
          description: '单个本地绝对路径（与 files 二选一）',
        },
        chat_id: {
          type: 'string',
          description: '可选，目标 chat_id（oc_ 开头）。缺省 = 最近一条入站消息所在会话',
        },
        note: {
          type: 'string',
          description: '可选，随文件发送的一句说明文字（以文本消息先行发送）',
        },
      },
      additionalProperties: false,
    },
    async execute(args, exec) {
      const list = Array.isArray(args.files) && args.files.length
        ? args.files.map(String)
        : args.file ? [String(args.file)] : [];
      if (!list.length) throw new Error('send_file: 缺少 file/files 参数');
      if (list.length > sc.maxFiles) throw new Error(`send_file: 单次最多 ${sc.maxFiles} 个文件`);
      const chatId = String(args.chat_id ?? '') || state.lastChatId || '';
      if (!chatId) throw new Error('send_file: 无法确定目标会话（没有近期入站消息，且未传 chat_id）');

      const token = await tenantToken(cfg.apiBase, cfg.appId, cfg.appSecret);
      const results = [];
      if (args.note) {
        const res = await fetch(`${cfg.apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(args.note) }) }),
        });
        const body = await res.json();
        if (body.code !== 0) log.warn(`send_file note 发送失败 ${body.code}: ${body.msg}`);
      }
      for (const raw of list) {
        const abs = path.resolve(String(raw).trim());
        try {
          const uploaded = await uploadOne(cfg.apiBase, token, abs, sc.maxBytes);
          const messageId = await sendMessage(cfg.apiBase, token, chatId, uploaded);
          const kb = ((await fsp.stat(abs)).size / 1024).toFixed(0);
          results.push(`✅ ${path.basename(abs)}（${kb}KB，${uploaded.kind} 消息，msg=${messageId}）`);
          log.info(`send_file ok (${path.basename(abs)} → ${chatId.slice(0, 12)}… msg=${messageId})`);
        } catch (e) {
          results.push(`❌ ${path.basename(abs)}：${e.message}`);
          log.warn(`send_file fail (${abs}): ${e.message}`);
        }
      }
      return `[send_file → ${chatId.slice(0, 12)}…]\n` + results.join('\n');
    },
  };
  const dispose = tools.register(def);
  log.info(`send_file tool registered (max ${(sc.maxBytes / 1048576) | 0}MB×${sc.maxFiles}/call)`);
  return dispose;
}

/**
 * Programmatic entry (2026-10-28): the same three-step flow, callable outside
 * the tools layer (frozen-tool-list sessions, cron, other scripts) so NOBODY
 * ever hand-rolls this again.
 * @returns per-file result strings (same format as the tool output).
 */
export async function sendFiles({ apiBase, appId, appSecret, paths, chatId, note = '', maxBytes = DEFAULTS.maxBytes }) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length && !note) throw new Error('sendFiles: paths 为空且无 note');
  if (!appId || !appSecret) throw new Error('sendFiles: 缺少 appId/appSecret');
  if (!chatId) throw new Error('sendFiles: 缺少 chatId');
  const token = await tenantToken(apiBase, appId, appSecret);
  if (note) {
    const res = await fetch(`${apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: note }) }),
    });
    const body = await res.json();
    if (body.code !== 0) log.warn(`sendFiles note 失败 ${body.code}: ${body.msg}`);
  }
  const results = [];
  for (const raw of list) {
    const abs = path.resolve(String(raw).trim());
    try {
      const uploaded = await uploadOne(apiBase, token, abs, maxBytes);
      const messageId = await sendMessage(apiBase, token, chatId, uploaded);
      results.push(`✅ ${path.basename(abs)}（${((await fsp.stat(abs)).size / 1024).toFixed(0)}KB，${uploaded.kind}，msg=${messageId}）`);
      log.info(`sendFiles ok (${path.basename(abs)} → ${chatId.slice(0, 12)}… msg=${messageId})`);
    } catch (e) {
      results.push(`❌ ${path.basename(abs)}：${e.message}`);
      log.warn(`sendFiles fail (${abs}): ${e.message}`);
    }
  }
  return results;
}

// ---- CLI: node send-tool.js <file> [file...] [--chat oc_xxx] [--note 文本] ----
// Credentials: FEISHU_APP_ID / FEISHU_APP_SECRET env. Default chat = first key
// of $DSH_HOME/feishu/bindings.json (single-user bridge semantics).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  // 正确解析：flags 的值不落入 files（--note "文本" 之类）
  const files = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[++i] ?? ''; }
    else files.push(argv[i]);
  }
  const pick = (k) => flags[k] ?? '';
  const apiBase = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';
  let chatId = pick('chat');
  if (!chatId) {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const bindings = JSON.parse(fsSync.readFileSync(path.join(home, 'feishu', 'bindings.json'), 'utf8'));
      chatId = Object.keys(bindings)[0] || '';
    } catch {}
  }
  if ((!files.length && !pick('note')) || !appId || !appSecret || !chatId) {
    console.error('用法: node send-tool.js <file> [file...] [--chat oc_xxx] [--note 文本]\n需要 env FEISHU_APP_ID/FEISHU_APP_SECRET；--chat 缺省取 bindings.json 首个会话');
    process.exit(2);
  }
  sendFiles({ apiBase, appId, appSecret, paths: files, chatId, note: pick('note') })
    .then((r) => { if (r.length) console.log(r.join('\n')); else console.log('✅ 仅发送了 note 文本'); process.exit(r.some((x) => x.startsWith('❌')) ? 1 : 0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
