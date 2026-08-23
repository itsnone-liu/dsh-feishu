/**
 * inspect_image — external vision tool for the Feishu bridge, modeled on the
 * approach of https://github.com/Scorp1o117/dsh-tool-vision (MIT): the main
 * model stays a text/coding model (glm-5.3), and images are farmed out to an
 * OpenAI-compatible vision endpoint (glm-4.5v on the GLM coding endpoint,
 * verified working 2026-08-23) through ONE tool call. No model switching, no
 * capability lies (declaring `input: [text, image]` on a text model makes
 * every image-bearing request fail with API code 1210), no whole-session
 * downgrade to a 64k vision model.
 *
 * Registered on the global tools layer, so every agent in the bridge process
 * (any preset) can call it. Configuration lives in the bridge config.json:
 *
 *   "vision": {
 *     "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
 *     "apiKeyEnv": "GLM_API_KEY",
 *     "model": "glm-4.5v",
 *     "maxTokens": 1024,
 *     "timeoutMs": 60000
 *   }
 *
 * Images reach the agent as attachment references (the router already
 * persists Feishu images through the attachment service), so the tool takes a
 * local file path; http(s) URLs are also accepted for pasted links.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from './log.js';

const DEFAULTS = {
  baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
  apiKeyEnv: 'GLM_API_KEY',
  model: 'glm-4.5v',
  maxTokens: 1024,
  timeoutMs: 60000,
  maxImageBytes: 10 * 1024 * 1024,
};

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

const MEDIA_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Sniff a media type from magic bytes; null when unrecognized. */
export function sniffImageMediaType(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

/** Read a local image as a data URL (bounded). */
async function localImageDataUrl(file, maxBytes) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`不是文件：${file}`);
  if (stat.size > maxBytes) throw new Error(`图片过大（${stat.size} B > 上限 ${maxBytes} B）`);
  const buf = await fsp.readFile(file);
  const media = MEDIA_BY_EXT[path.extname(file).toLowerCase()] ?? sniffImageMediaType(new Uint8Array(buf));
  if (!media) throw new Error(`不支持的图片格式：${path.extname(file) || '(无扩展名)'}`);
  return `data:${media};base64,${Buffer.from(buf).toString('base64')}`;
}

/** One vision request against an OpenAI-compatible chat/completions endpoint. */
export async function callVisionEndpoint(cfg, imageUrl, question, signal) {
  const key = process.env[cfg.apiKeyEnv] ?? '';
  if (!key) throw new Error(`环境变量 ${cfg.apiKeyEnv} 未设置，识图端点无密钥`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: question || '请详细描述这张图片的内容。' },
          ],
        }],
      }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      let msg = body.slice(0, 500);
      try { msg = JSON.parse(body)?.error?.message ?? msg; } catch {}
      throw new Error(`识图端点 HTTP ${res.status}：${msg}`);
    }
    let json;
    try { json = JSON.parse(body); } catch { throw new Error('识图端点返回非 JSON'); }
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('识图端点返回空内容');
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Register `inspect_image` on the global tools layer.
 * `visionCfg` semantics: `null`/`undefined`/`{}` → enabled with defaults;
 * `false` or `{enabled:false}` → disabled (no tool registered).
 * @returns {Function|null} disposer, or null when disabled / service absent.
 */
export function installVisionTool(ctx, visionCfg) {
  if (visionCfg === false || visionCfg?.enabled === false) return null;
  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    log.warn('inspect_image not registered: tools service unavailable');
    return null;
  }
  const cfg = { ...DEFAULTS, ...(visionCfg ?? {}) };

  const def = {
    name: 'inspect_image',
    description:
      '用外部视觉模型分析一张图片（本地文件路径或 http(s) 链接），返回文字描述或回答。' +
      '当用户在飞书发送了图片、截图、照片并询问其内容时使用；不要为识图切换主模型。' +
      '若返回明确失败（鉴权/限流/超时），不要反复重试，向用户说明识图暂不可用。',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: '图片的本地绝对路径，或 http(s) URL（飞书发来的图片会先落盘为本地文件）',
        },
        question: {
          type: 'string',
          description: '想问视觉模型的问题（默认"详细描述图片内容"）',
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const file = String(args.file ?? '').trim();
      const question = String(args.question ?? '').trim();
      if (!file) throw new Error('inspect_image: 缺少 file 参数');
      let imageUrl = file;
      if (!/^https?:\/\//i.test(file)) {
        const abs = path.resolve(file);
        imageUrl = await localImageDataUrl(abs, cfg.maxImageBytes);
      }
      const answer = await callVisionEndpoint(cfg, imageUrl, question, exec?.signal);
      log.info(`inspect_image ok (${cfg.model}, ${file.slice(0, 80)})`);
      return `[inspect_image ${cfg.model}]\n${answer}`;
    },
  };
  const dispose = tools.register(def);
  log.info(`inspect_image tool registered (vision=${cfg.model} @ ${cfg.baseURL})`);
  return typeof dispose === 'function' ? dispose : null;
}
