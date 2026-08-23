/**
 * SelfGuard — keep an agent that runs INSIDE the bridge process from killing
 * that process by accident.
 *
 * Incident 2026-08-23 14:43: the dev agent (hosted by the bridge itself) ran
 * `Stop-Process` on every `node.exe --profile feishu` as part of a "restart
 * the bridge" step. The kill succeeded, its own pwsh child died with the host
 * (job object), the follow-up start never ran, and the bridge stayed down for
 * ~56 minutes. The turn card froze mid-render, which looked like a card bug.
 *
 * This guard inspects shell-tool commands for host-killing patterns and denies
 * them with actionable guidance (use `/restart`, which restarts from OUTSIDE
 * the process via a scheduled task). It deliberately over-matches a little:
 * managing unrelated node processes through the bot chat is rare, and a false
 * denial only asks the user to run the command from a real terminal.
 */

import { log } from './log.js';

/** Patterns that mean "terminate processes" on Windows / Unix shells. */
const KILL_RE = /(stop-process|taskkill|kill-process|kill\s+-|-9\b|pkill|kill\s+node|Stop-Process)/i;
/** Patterns that identify the bridge host (this process or the profile flag). */
const HOST_RE = /(profile[ -]?feishu|node\.exe|nodejs\\node|process\.pid|\$pid\b)/i;

/**
 * Would this command, run by a child of THIS process, plausibly terminate the
 * bridge host? Exported for unit tests.
 */
export function threatensHost(command, ownPid = process.pid) {
  if (typeof command !== 'string' || !command) return false;
  if (!KILL_RE.test(command)) return false;
  // Mentioning our own PID digits directly, or node/profile-feishu targeting.
  const mentionsSelfPid = command.includes(String(ownPid));
  const mentionsHost = HOST_RE.test(command);
  return mentionsSelfPid || mentionsHost;
}

const DENIAL =
  '该命令会终止 dsh-feishu 桥进程（也就是运行本次对话的宿主），已拦截。' +
  '重启桥请在飞书里发送 `/restart`（经计划任务在进程外安全重启，会话保持可接续）；' +
  '如确实要杀其他无关进程，请在系统终端里执行，不要通过桥内会话。';

/**
 * Install the guard on the tools registry (cordis `tools` service).
 * @returns {Function|null} disposer, or null when the service is unavailable.
 */
export function installSelfGuard(ctx) {
  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools || typeof tools.guard !== 'function') {
    log.warn('self guard not installed: tools service unavailable');
    return null;
  }
  const dispose = tools.guard((exec) => {
    try {
      const name = exec?.name ?? '';
      if (name !== 'pwsh' && name !== 'bash') return undefined;
      const command = exec?.arguments?.command ?? '';
      if (!threatensHost(command)) return undefined;
      return DENIAL;
    } catch {
      return undefined; // a broken guard must never block tooling
    }
  });
  log.info(`self guard installed (host-kill command blocker, pid=${process.pid})`);
  return dispose;
}
