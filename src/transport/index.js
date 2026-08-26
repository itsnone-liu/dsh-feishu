/**
 * Transport selection:
 *   'mock'     → in-process MockTransport (tests / REPL dry-run)
 *   'sdk'      → official @larksuiteoapi/node-sdk adapter (production path)
 *   'vendored' → dependency-free REST+WS client (lark.js)
 *   'auto'     → sdk if importable, else vendored
 */
import path from 'path';
import os from 'node:os';
import fs from 'node:fs';
import { log } from '../log.js';
import { MockTransport } from './mock.js';
import { LarkTransport } from './lark.js';

/**
 * Deterministic candidate locations of the official SDK, which is installed
 * into the dsh PROFILE (`$DSH_HOME/profiles/feishu/node_modules`), not into
 * this repo. The old code fell back to `process.env.HOME/.dsh/...` — HOME is
 * rarely set on Windows scheduled-task contexts, so resolution flipped between
 * sdk and vendored depending on how the bridge was launched (2026-08-26:
 * 30+ min of vendored ws reconnect storms). USERPROFILE/DSH_HOME are always set.
 */
function sdkModuleCandidates() {
  const rel = ['profiles', 'feishu', 'node_modules', '@larksuiteoapi', 'node-sdk', 'lib', 'index.js'];
  const out = [];
  if (process.env.DSH_HOME) out.push(path.join(process.env.DSH_HOME, ...rel));
  const home = process.env.HOME || os.homedir(); // os.homedir() = USERPROFILE on Windows
  out.push(path.join(home, '.dsh', ...rel));
  return [...new Set(out)].filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

export async function createTransport(config) {
  const wanted = config.transport;
  if (wanted === 'mock') return new MockTransport(config);
  if (wanted === 'vendored') return new LarkTransport(config);
  if (wanted === 'sdk' || wanted === 'auto') {
    let loaded = null;
    let lastErr = null;
    try {
      loaded = await import('@larksuiteoapi/node-sdk');
    } catch (e) {
      lastErr = e;
      for (const p of sdkModuleCandidates()) {
        try {
          loaded = await import('file:///' + p.replace(/\\/g, '/'));
          log.info(`official lark SDK loaded from ${p}`);
          break;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
    if (loaded) {
      const { SdkTransport } = await import('./sdk.js');
      return new SdkTransport(config, loaded);
    }
    if (wanted === 'sdk') throw lastErr ?? new Error('official lark SDK not found');
    log.warn('official lark SDK not installed — falling back to vendored client');
    return new LarkTransport(config);
  }
  throw new Error(`unknown transport: ${wanted}`);
}
