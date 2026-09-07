/**
 * Bridge configuration.
 *
 * Layering (low → high):
 *   built-in defaults  <  $DSH_HOME/feishu/config.json  <  environment
 *
 * The plugin row config only points at the file (`configFile`), so the row
 * itself never changes while iterating on the bridge. Secrets (app_id /
 * app_secret) live in the environment, never in the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from './log.js';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

const DEFAULTS = {
  /** Feishu open-platform base URL (Lark uses https://open.larksuite.com). */
  apiBase: 'https://open.feishu.cn',
  /** WS long-connection endpoint discovery path. */
  endpointPath: '/open-apis/endpoint/v1',
  /** Transport: 'auto' | 'sdk' | 'vendored' | 'mock'. */
  transport: 'auto',
  /** Directory for bindings.json and runtime state. Default $DSH_HOME/feishu. */
  dataDir: '',
  /** HARD security gate: only these open_ids may talk to the bridge. */
  allowedOpenIds: [],
  /** Group chats: 'off' (p2p only, fail-closed) | 'mention' (@bot only,
   *  text messages) | 'all' (any message, sender still whitelisted). */
  groups: 'off',
  /** Default workspace cwd for new chats; must be inside allowedWorkspaces. */
  defaultCwd: '',
  /** cwd whitelist — chat bindings and /cwd may only use these. */
  allowedWorkspaces: [],
  /** Agent preset for new sessions ('minimal' | 'standard' | ...). */
  agentPreset: 'minimal',
  /** Model override; empty = use the harness default selection. */
  provider: '',
  model: '',
  /** Approval handling: 'cards' (answer via buttons) | 'never' (auto-reject). */
  approval: 'cards',
  /** Card patch throttle window (ms) — also our Feishu rate-limit protection. */
  throttleMs: 900,
  /** Burst window (ms) to coalesce consecutive image messages into ONE turn.
   *  0 disables batching. Text during the window flushes as the caption. */
  imageBatchMs: 1500,
  /** Max images per coalesced batch; reaching it flushes immediately. */
  imageBatchMax: 9,
  /** Max bytes for one received (non-image) file message. */
  fileMaxBytes: 10485760,
  /** Hard cap on visible markdown per card before truncation. */
  cardTextLimit: 6000,
  /** Base delay (ms) for card-patch failure backoff; retries double up to 15×. */
  cardRetryBaseMs: 1000,
  /** ask_user_question timeout (ms); 0 = wait forever. */
  askTimeoutMs: 0,
  /** TEST ONLY: drive a scripted fake agent instead of a real model loop. */
  mockAgent: false,
  /** TEST ONLY: force the image-capability gate in mock mode.
   *  '' (real fail-open) | 'text-only' (reject) | 'vision' (accept). */
  mockImageGate: '',
  /** TEST ONLY: pad mock agent answers to ~N chars (long-output path). */
  mockLongOutput: 0,
  /** Durable log file for the bridge itself (crash/audit trail). Empty =
   *  $DSH_HOME/feishu/bridge.log. Set to 'none' to disable file logging. */
  logFile: '',
  /** Restart launcher for /restart: a .ps1/.bat/.cmd absolute path. Empty =
   *  auto-detect the canonical launcher next to the installed dsh package. */
  restartLauncher: '',
  /** inspect_image vision tool (see src/vision-tool.js). `false` disables. */
  vision: null,
  /** 额度耗尽自动继续（see src/autocontinue.js）。`false` 关闭。 */
  autoContinue: true,
  /** 自动继续时补发的消息文本。 */
  autoContinueMessage: '继续',
  /** 额度错误未给出重置时间时的首次探测延迟（ms）。 */
  autoContinueFirstMs: 60_000,
  /** 之后的轮询间隔（ms）。 */
  autoContinuePollMs: 10 * 60_000,
  /** 自动等待总上限（ms），超过即放弃并通知。 */
  autoContinueMaxMs: 6 * 3_600_000,
  /** 瞬时限流（429/上游负载）的最大短退避重试次数。 */
  autoContinueShortMax: 6,
  /** 追加的额度错误匹配正则（字符串数组，不区分大小写）。 */
  autoContinuePatterns: [],
  /** 限额自动切换：主模型限额窗口打满时，把会话切到备用模型继续干活，
   *  同时探测主模型恢复，探通后切回。'' 或 null = 关闭（纯等待老行为）。 */
  fallbackPrimary: 'glm-coding/glm-5.3',
  /** 备用模型（须已在 dsh settings.yaml providers 里配好）。 */
  fallbackBackup: 'codex-gpt/gpt-5.6-luna',
  /** 探测主模型恢复用的最小请求（同 key 同窗口，1 token 消耗可忽略）。 */
  fallbackProbe: {
    url: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    apiKeyEnv: 'GLM_API_KEY',
    model: 'glm-5-turbo',
  },
};

function coerce(raw) {
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (raw?.[k] !== undefined && raw?.[k] !== null && raw?.[k] !== '') cfg[k] = raw[k];
  }
  // env overrides
  if (process.env.FEISHU_API_BASE) cfg.apiBase = process.env.FEISHU_API_BASE;
  if (process.env.FEISHU_TRANSPORT) cfg.transport = process.env.FEISHU_TRANSPORT;
  if (process.env.DSH_FEISHU_TRANSPORT) cfg.transport = process.env.DSH_FEISHU_TRANSPORT;
  if (process.env.DSH_FEISHU_DATA_DIR) cfg.dataDir = process.env.DSH_FEISHU_DATA_DIR;
  if (process.env.DSH_FEISHU_MOCK_AGENT === '1') cfg.mockAgent = true;
  // legacy boolean → groups enum
  if (raw?.allowGroupChats === true) cfg.groups = 'mention';
  // 限额自动切换：嵌套探针配置按字段合并；false 显式关闭
  cfg.fallbackProbe = { ...DEFAULTS.fallbackProbe, ...(raw?.fallbackProbe ?? {}) };
  if (raw?.fallbackPrimary === false) cfg.fallbackPrimary = '';
  if (raw?.fallbackBackup === false) cfg.fallbackBackup = '';
  if (!['off', 'mention', 'all'].includes(cfg.groups)) cfg.groups = 'off';
  if (!cfg.dataDir) cfg.dataDir = path.join(dshHome(), 'feishu');
  if (!cfg.logFile) cfg.logFile = path.join(cfg.dataDir, 'bridge.log');
  cfg.appId = process.env.FEISHU_APP_ID || process.env.DSH_FEISHU_APP_ID || '';
  cfg.appSecret = process.env.FEISHU_APP_SECRET || process.env.DSH_FEISHU_APP_SECRET || '';
  return cfg;
}

/** Load and validate. Returns { config, problems[] } — problems are fatal-ish. */
export function loadConfig(configFile) {
  const file = configFile || path.join(dshHome(), 'feishu', 'config.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      // tolerate a UTF-8 BOM (Windows editors / PowerShell often add one)
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new Error(`config file unparsable: ${file}: ${e.message}`);
    }
  } else if (configFile) {
    throw new Error(`config file not found: ${configFile}`);
  }
  const config = coerce(raw);
  const problems = [];
  if (config.transport !== 'mock') {
    if (!config.appId || !config.appSecret) {
      problems.push('FEISHU_APP_ID / FEISHU_APP_SECRET are not set (required unless transport=mock)');
    }
  }
  if (!config.defaultCwd) problems.push('defaultCwd is not set — new chats have no workspace');
  if (config.allowedOpenIds.length === 0) {
    problems.push('allowedOpenIds is empty — the bridge will drop every message (fail closed)');
  }
  if (config.allowedWorkspaces.length === 0) {
    // Default the whitelist to the defaultCwd itself — one-workspace setups need no list.
    config.allowedWorkspaces = [config.defaultCwd].filter(Boolean);
  }
  if (problems.length) for (const p of problems) log.warn(`config: ${p}`);
  config.configFile = file;
  return { config, problems };
}

/** Is `cwd` allowed as a workspace? (exact match or nested under an entry) */
export function isWorkspaceAllowed(config, cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return false;
  const norm = path.normalize(cwd);
  return config.allowedWorkspaces.some((w) => {
    const b = path.normalize(w);
    return norm === b || norm.startsWith(b + path.sep);
  });
}
