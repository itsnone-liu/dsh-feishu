/**
 * Transport selection:
 *   'mock'     → in-process MockTransport (tests / REPL dry-run)
 *   'sdk'      → official @larksuiteoapi/node-sdk adapter (production path)
 *   'vendored' → dependency-free REST+WS client (lark.js)
 *   'auto'     → sdk if importable, else vendored
 */
import { log } from '../log.js';
import { MockTransport } from './mock.js';
import { LarkTransport } from './lark.js';

export async function createTransport(config) {
  const wanted = config.transport;
  if (wanted === 'mock') return new MockTransport(config);
  if (wanted === 'vendored') return new LarkTransport(config);
  if (wanted === 'sdk' || wanted === 'auto') {
    try {
      const mod = await import('@larksuiteoapi/node-sdk');
      const { SdkTransport } = await import('./sdk.js');
      return new SdkTransport(config, mod);
    } catch (e) {
      if (wanted === 'sdk') throw e;
      log.warn('official lark SDK not installed — falling back to vendored client');
      return new LarkTransport(config);
    }
  }
  throw new Error(`unknown transport: ${wanted}`);
}
