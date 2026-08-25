/**
 * inspect_image — external vision tool for the Feishu bridge, modeled on the
 * approach of https://github.com/liustack/modlens (and Scorp1o117/dsh-tool-vision,
 * MIT): the main model stays a text/coding model (glm-5.3), and images are
 * farmed out to an OpenAI-compatible vision endpoint through ONE tool call.
 * No model switching, no capability lies (declaring `input: [text, image]` on
 * a text model makes every image-bearing request fail with API code 1210),
 * no whole-session downgrade to a small-context vision model.
 *
 * 2026-08-26: default engine switched to Alibaba Cloud Qwen-VL via the
 * DashScope OpenAI-compatible endpoint (verified working with qwen3-vl-plus).
 * Configuration lives in the bridge config.json:
 *
 *   "vision": {
 *     "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
 *     "apiKey": "sk-...",                      // inline key (file is 0600)
 *     "apiKeyEnv": "DASHSCOPE_API_KEY",        // used when apiKey absent
 *     "model": "qwen3-vl-plus",
 *     "maxTokens": 1024,
 *     "timeoutMs": 60000
 *   }
 *
 * Images reach the agent as durable attachment references (the router
 * persists Feishu images through the attachment service). Two ways to point
 * the tool at one:
 *   - `attachment`: the ImageAttachmentRef JSON (preferred — goes through the
 *     attachment service's verified readImage);
 *   - `file`: local absolute path or http(s) URL.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dshHome } from './config.js';
import { log } from './log.js';

const DEFAULTS = {
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  /** Inline key wins over apiKeyEnv. NEVER logged. */
  apiKey: '',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  model: 'qwen3-vl-plus',
  maxTokens: 1024,
  timeoutMs: 60000,
  maxImageBytes: 10 * 1024 * 1024,
};

/** Resolve the effective vision config (config.json `vision` over DEFAULTS). */
export function resolveVisionConfig(visionCfg) {
  return { ...DEFAULTS, ...(visionCfg ?? {}) };
}

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

/** Content-addressed object path for a sha256 attachment id (local layout). */
function attachmentObjectPath(attachmentId) {
  const hex = String(attachmentId).replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`非法附件标识：${attachmentId}`);
  return path.join(dshHome(), 'attachments', 'v1', 'objects', hex.slice(0, 2), hex);
}

/**
 * Resolve an attachment argument (ref JSON string / object / bare id) to a
 * data URL. Preferred path: the attachment service's verified readImage.
 * Fallback: direct object-path read + magic-byte sniff (bare ids carry no
 * metadata to verify against). Exported for unit tests.
 */
export async function attachmentDataUrl(attachments, raw, maxBytes) {
  let ref = raw;
  if (typeof raw === 'string') {
    try { ref = JSON.parse(raw); } catch { ref = { attachmentId: raw.trim() }; }
  }
  if (!ref || typeof ref !== 'object' || !ref.attachmentId) {
    throw new Error('attachment 参数需要附件引用 JSON（含 attachmentId）');
  }
  if (attachments?.readImage && ref.mediaType && ref.bytes) {
    try {
      const { data } = await attachments.readImage(ref);
      return `data:${ref.mediaType};base64,${Buffer.from(data).toString('base64')}`;
    } catch (e) {
      // fall through to the direct path unless it is a hard miss
      if (String(e?.code) === 'ATTACHMENT_NOT_FOUND') throw new Error(`附件不存在：${ref.attachmentId}`);
      log.debug(`readImage fell back to direct read: ${e.message}`);
    }
  }
  const file = attachmentObjectPath(ref.attachmentId);
  return localImageDataUrl(file, maxBytes);
}

/** One vision request against an OpenAI-compatible chat/completions endpoint. */
export async function callVisionEndpoint(cfg, imageUrl, question, signal) {
  const key = cfg.apiKey || process.env[cfg.apiKeyEnv] || '';
  if (!key) throw new Error(`识图密钥未配置（config.json vision.apiKey 或环境变量 ${cfg.apiKeyEnv}）`);
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
  const cfg = resolveVisionConfig(visionCfg);
  const attachments = ctx.get?.('attachments') ?? ctx.attachments ?? null;

  const def = {
    name: 'inspect_image',
    description:
      '用外部视觉模型分析一张图片，返回文字描述或回答。' +
      '当用户在飞书发送了图片、截图、照片并询问其内容时使用；不要为识图切换主模型。' +
      '优先用 attachment 参数传入消息里的附件引用 JSON；也接受本地文件路径或 http(s) 链接（file 参数）。' +
      '若返回明确失败（鉴权/限流/超时），不要反复重试，向用户说明识图暂不可用。',
    parameters: {
      type: 'object',
      properties: {
        attachment: {
          type: 'string',
          description: '附件引用的 JSON 字符串（飞书图片消息附带的 ImageAttachmentRef，含 attachmentId/mediaType/bytes/width/height 字段），原样传入',
        },
        file: {
          type: 'string',
          description: '图片的本地绝对路径，或 http(s) URL（与 attachment 二选一）',
        },
        question: {
          type: 'string',
          description: '想问视觉模型的问题（默认"详细描述图片内容"）',
        },
      },
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      const attachment = args.attachment ?? null;
      const file = String(args.file ?? '').trim();
      const question = String(args.question ?? '').trim();
      if (!attachment && !file) throw new Error('inspect_image: 缺少 attachment 或 file 参数');
      let imageUrl;
      let label;
      if (attachment) {
        imageUrl = await attachmentDataUrl(attachments, attachment, cfg.maxImageBytes);
        label = typeof attachment === 'string' ? attachment.slice(0, 60) : String(attachment?.attachmentId ?? 'attachment');
      } else {
        label = file.slice(0, 80);
        imageUrl = /^https?:\/\//i.test(file)
          ? file
          : await localImageDataUrl(path.resolve(file), cfg.maxImageBytes);
      }
      const answer = await callVisionEndpoint(cfg, imageUrl, question, exec?.signal);
      log.info(`inspect_image ok (${cfg.model}, ${label})`);
      return `[inspect_image ${cfg.model}]\n${answer}`;
    },
  };
  const dispose = tools.register(def);
  const keySource = cfg.apiKey ? 'config' : (process.env[cfg.apiKeyEnv] ? cfg.apiKeyEnv : '未配置');
  log.info(`inspect_image tool registered (vision=${cfg.model} @ ${cfg.baseURL}, key=${keySource})`);
  return typeof dispose === 'function' ? dispose : null;
}
