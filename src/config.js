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
  /** Also allow group chats (V0.2 semantics: requires @mention). */
  allowGroupChats: false,
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
  /** Hard cap on visible markdown per card before truncation. */
  cardTextLimit: 6000,
  /** ask_user_question timeout (ms); 0 = wait forever. */
  askTimeoutMs: 0,
  /** TEST ONLY: drive a scripted fake agent instead of a real model loop. */
  mockAgent: false,
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
  if (!cfg.dataDir) cfg.dataDir = path.join(dshHome(), 'feishu');
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
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
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
