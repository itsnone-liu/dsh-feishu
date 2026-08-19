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
    } catch {
      /* ESM bare-specifier may fail if CWD ≠ profile dir;
         try the absolute path as fallback. */
      try {
        const sdkPath = '/root/.dsh/profiles/feishu/node_modules/@larksuiteoapi/node-sdk/lib/index.js';
        const mod = await import('file://' + sdkPath);
        const { SdkTransport } = await import('./sdk.js');
        return new SdkTransport(config, mod);
      } catch (e2) {
        if (wanted === 'sdk') throw e2;
        log.warn('official lark SDK not installed — falling back to vendored client');
        return new LarkTransport(config);
      }
    }
  }
  throw new Error(`unknown transport: ${wanted}`);
}
