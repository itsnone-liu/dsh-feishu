/**
 * dsh-feishu — the Feishu/Lark surface bundle plugin.
 *
 * Sibling of `dsh-web-app` / `dsh-headless` over the same `dsh-base`: this
 * process is the ONLY user-questions provider (that is the whole reason the
 * bridge is its own profile), renders durable session events as one streaming
 * card per turn, answers ask_user_question and approval seams from button
 * cards, and keeps zero conversation memory of its own — bindings only.
 *
 * Hardening (2026-08-23 incidents):
 *  - every `session/event` listener throw is contained HERE: dsh's
 *    session.append() invokes listeners synchronously, so a renderer bug
 *    would otherwise kill the whole bridge process;
 *  - process-level uncaught/rejected handlers log to the durable file sink
 *    before default semantics take over;
 *  - a tools guard denies shell commands that would kill this very process
 *    (the 14:43 self-restart that took the bridge down for ~56 min);
 *  - an `inspect_image` vision tool is registered so image questions do not
 *    require switching the whole session to a vision model.
 */
import z from '@deepseek-ai/schemastery';
import { loadConfig } from './config.js';
import { log, setLogFile } from './log.js';
import { BindingStore, TitleStore } from './store.js';
import { TurnRenderer } from './renderer.js';
import { SessionDriver } from './driver.js';
import { ChatRouter } from './router.js';
import { Commands } from './commands.js';
import { InteractionManager } from './ask.js';
import { AutoContinue } from './autocontinue.js';
import { PhaseManager } from './phases.js';
import { createTransport } from './transport/index.js';
import { installSelfGuard } from './selfguard.js';
import { installVisionTool } from './vision-tool.js';
import { installSendFileTool } from './send-tool.js';
import { sweepShelve } from './shelve.js';

const name = 'feishu-bridge';

const inject = ['agents', 'sessions', 'agentDefaultModel', 'userQuestions', 'approval', 'permissionPresets', 'llm', 'agentPresets', 'tools'];

const Config = z.object({
  /** Path to the bridge JSON config; empty = $DSH_HOME/feishu/config.json */
  configFile: z.string().default(''),
});

/**
 * Boot-fatal detection (2026-10-31 incident). When the profile's plugin tree
 * fails to load — e.g. a malformed ~/.dsh/.credentials.yaml makes
 * dsh-credentials-local throw "unknown top-level key" — dsh-app-boot tears the
 * cordis tree down, but the process used to live on as a zombie: the Lark ws
 * pump kept delivering messages into the disposed context and EVERY message
 * failed with `cannot get required service "agents" in inactive context` for
 * 16 h (7 user-visible failures). Matching errors exit 78 (EX_CONFIG) so the
 * host sees a clean down state instead of a misleading half-alive bridge.
 * @param {unknown} err - thrown value (Error or rejection reason)
 * @returns {boolean}
 */
function isBootFatalError(err) {
  const text = `${err?.message ?? ''}\n${err?.stack ?? String(err ?? '')}`;
  return /plugin tree failed to load/i.test(text);
}

function apply(ctx, config) {
  const { config: cfg, problems } = loadConfig(config.configFile || undefined);
  log.setLevel(process.env.DSH_FEISHU_LOG || 'info');
  if (cfg.logFile && cfg.logFile !== 'none') setLogFile(cfg.logFile);

  // ---- process-level safety net: never die without a trace ----------------
  // Exception: BOOT-FATAL errors must die (see isBootFatalError). Swallowing
  // "plugin tree failed to load" left a 16 h zombie whose disposed cordis
  // context failed every inbound message (2026-10-31). Same exit pattern as
  // the transport/boot failures below: log durably, then exit non-zero.
  process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${err?.stack ?? err}`);
    if (isBootFatalError(err)) {
      log.error('boot-fatal: plugin tree failed to load — exiting 78 (EX_CONFIG) instead of serving from a disposed context');
      setTimeout(() => process.exit(78), 300).unref?.();
    }
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandledRejection: ${reason?.stack ?? reason}`);
    if (isBootFatalError(reason)) {
      log.error('boot-fatal: plugin tree failed to load — exiting 78 (EX_CONFIG) instead of serving from a disposed context');
      setTimeout(() => process.exit(78), 300).unref?.();
    }
  });

  log.info(`bridge starting (pid=${process.pid}, transport=${cfg.transport}, mockAgent=${cfg.mockAgent})`);
  if (problems.length) {
    log.warn(`config problems: ${problems.join('; ')}`);
  }

  // ---- global tools: host-kill guard + vision ------------------------------
  const disposers = [];
  let visionReady = false;
  try {
    const d1 = installSelfGuard(ctx);
    if (d1) disposers.push(d1);
  } catch (e) {
    log.warn(`self guard not installed: ${e.message}`);
  }
  try {
    const d2 = installVisionTool(ctx, cfg.vision);
    if (d2) disposers.push(d2);
    visionReady = true;
  } catch (e) {
    log.warn(`vision tool not installed: ${e.message}`);
  }
  // send_file 出站文件工具（2026-10-28）：sendState 与 router 共享，记录最近
  // 一次通过白名单的 chat，作为发送默认目标。
  const sendState = { lastChatId: '' };
  try {
    const d3 = installSendFileTool(ctx, cfg.sendFile, cfg, sendState);
    if (d3) disposers.push(d3);
  } catch (e) {
    log.warn(`send_file tool not installed: ${e.message}`);
  }

  const store = new BindingStore(cfg.dataDir);
  const titles = new TitleStore(cfg.dataDir); // 2026-11-21 P1/P2：会话命名（/name + /sessions 显示）
  const driver = new SessionDriver({ ctx, config: cfg });

  // Transport first — renderer and interactions need it.
  createTransport(cfg)
    .then(async (transport) => {
      const renderer = new TurnRenderer({ transport, config: cfg, store });
      const interactions = new InteractionManager({
        transport,
        config: cfg,
        chatOfSession: (sessionId) => renderer.chatOf(sessionId),
      });
      const commands = new Commands({ config: cfg, store, titles, driver, renderer, transport, permissionPresets: ctx.permissionPresets, llm: ctx.llm, agentPresets: ctx.agentPresets, visionReady, autoContinue: null });
      const autoContinue = new AutoContinue({ config: cfg, driver, renderer, transport });
      commands.autoContinue = autoContinue; // 注入（构造顺序：Commands 先建，AutoContinue 需要 transport 就绪）
      const phases = new PhaseManager({ config: cfg, driver, transport, autoContinue });
      commands.phases = phases;
      autoContinue.phases = phases;   // 网页侧错误认领（onTurnError）
      const router = new ChatRouter({ config: cfg, store, titles, driver, renderer, transport, interactions, commands, visionReady, autoContinue, sendState });

      // 方案C（2026-11-21）：启动 5 秒后自动归档老旧会话（>30天未动且未命名且非绑定）。
      // 延迟避开启动高峰；任何失败只记日志，绝不影响桥。
      if (cfg.sessionSweep) {
        setTimeout(() => {
          try { sweepShelve({ config: cfg, store, titles }); }
          catch (e) { log.warn(`session sweep failed: ${e.message}`); }
        }, 5_000);
      }

      // ---- outbound seams ----
      // dsh 0.2.1 把 userQuestions 改成 typert 远程服务（answer/attachWait），
      // registerProvider 已移除。按能力探测降级：0.2.1 下 ask 卡片暂不可用
      // （问题走默认答案），approval 卡片不受影响；后续按新协议移植。
      // [2026-11-13 升级补丁：自中心机同款插件移植 0.2.1 兼容守卫]
      if (typeof ctx.userQuestions?.registerProvider === 'function') {
        ctx.userQuestions.registerProvider({
          ask: (request) => interactions.handleAsk(request).catch((e) => {
            log.error(`ask provider failed: ${e?.stack ?? e}`);
            throw e;
          }),
        });
      } else if (typeof ctx.on === 'function') {
        // dsh 0.2.1: user-questions is a waterfall seam ("user-questions/request").
        // Pass through with next() whenever the question is not ours.
        log.info('userQuestions.registerProvider unavailable: registering waterfall answerer');
        ctx.on('user-questions/request', (request, next) => {
          const chatId = request?.agent ? renderer.chatOf(request.agent.id) : null;
          if (!chatId) return next();
          return Promise.resolve(interactions.handleAsk(request)).catch((e) => {
            log.error(`ask waterfall failed, delegating: ${e?.stack ?? e}`);
            return next();
          });
        });
      }
      ctx.on('approval/request', (req, next) => {
        // 必须 return waterfall answerer 的 Promise；旧代码未 return，导致
        // DSH user-approval 收到默认 unavailable，自动放行永远无法生效。
        return Promise.resolve(interactions.handleApproval(req, next)).catch((e) => {
          log.error(`approval handler failed, delegating: ${e?.stack ?? e}`);
          return next();
        });
      });

      // ---- the durable event feed → streaming cards ----
      // dsh calls session/event listeners SYNCHRONOUSLY inside
      // session.append(); a throw here would kill the process, so contain it.
      ctx.on('session/event', (session, event) => {
        try {
          renderer.onEvent(session, event);
        } catch (e) {
          log.error(`render event ${event?.type} failed (contained): ${e?.stack ?? e}`);
        }
        try {
          autoContinue.onEvent(session, event);
        } catch (e) {
          log.error(`auto-continue event ${event?.type} failed (contained): ${e?.stack ?? e}`);
        }
      });

      // ---- inbound transport ----
      try {
        await transport.start({
          onMessage: (msg) => router.onMessage(msg),
          onCardAction: (action) => router.onCardAction(action),
        });
      } catch (e) {
        // A bridge that cannot reach Feishu is useless but would otherwise
        // keep running as a zombie (2026-08-26 03:00: boot failed, process
        // lived on reconnecting to a 404 endpoint for an hour). Exit with a
        // failure code so the host (task scheduler / Hermes) can restart us.
        log.error(`transport start failed: ${e.stack ?? e}`);
        setTimeout(() => process.exit(1), 300).unref?.();
        throw e;
      }
      log.info(`bridge up (pid=${process.pid})`);

      const cleanup = () => {
        for (const d of disposers) { try { d(); } catch {} }
        autoContinue.dispose();
        phases.dispose();
        transport.stop().catch(() => {});
        driver.disposeAll().catch((e) => log.warn(`driver dispose: ${e.message}`));
      };
      if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
      else ctx.on('dispose', cleanup);
    })
    .catch((e) => {
      // Boot failure: log durably, then DIE with a non-zero exit code. The
      // old "log and throw" left a zombie process (ws reconnect loops with
      // no working transport) that nothing ever restarted.
      log.error(`bridge failed to start: ${e.stack ?? e}`);
      setTimeout(() => process.exit(1), 300).unref?.();
      throw e;
    });
}

export { name, inject, Config, apply, isBootFatalError };
