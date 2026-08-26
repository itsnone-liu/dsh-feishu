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
import { BindingStore } from './store.js';
import { TurnRenderer } from './renderer.js';
import { SessionDriver } from './driver.js';
import { ChatRouter } from './router.js';
import { Commands } from './commands.js';
import { InteractionManager } from './ask.js';
import { AutoContinue } from './autocontinue.js';
import { createTransport } from './transport/index.js';
import { installSelfGuard } from './selfguard.js';
import { installVisionTool } from './vision-tool.js';

const name = 'feishu-bridge';

const inject = ['agents', 'sessions', 'agentDefaultModel', 'userQuestions', 'approval', 'permissionPresets', 'llm', 'agentPresets', 'tools'];

const Config = z.object({
  /** Path to the bridge JSON config; empty = $DSH_HOME/feishu/config.json */
  configFile: z.string().default(''),
});

function apply(ctx, config) {
  const { config: cfg, problems } = loadConfig(config.configFile || undefined);
  log.setLevel(process.env.DSH_FEISHU_LOG || 'info');
  if (cfg.logFile && cfg.logFile !== 'none') setLogFile(cfg.logFile);

  // ---- process-level safety net: never die without a trace ----------------
  process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${err?.stack ?? err}`);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandledRejection: ${reason?.stack ?? reason}`);
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

  const store = new BindingStore(cfg.dataDir);
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
      const commands = new Commands({ config: cfg, store, driver, renderer, transport, permissionPresets: ctx.permissionPresets, llm: ctx.llm, agentPresets: ctx.agentPresets, visionReady });
      const autoContinue = new AutoContinue({ config: cfg, driver, renderer, transport });
      const router = new ChatRouter({ config: cfg, store, driver, renderer, transport, interactions, commands, visionReady, autoContinue });

      // ---- outbound seams ----
      ctx.userQuestions.registerProvider({
        ask: (request) => interactions.handleAsk(request).catch((e) => {
          log.error(`ask provider failed: ${e?.stack ?? e}`);
          throw e;
        }),
      });
      ctx.on('approval/request', (req, next) => {
        Promise.resolve(interactions.handleApproval(req, next)).catch((e) => {
          log.error(`approval handler failed, delegating: ${e?.stack ?? e}`);
          try { next(); } catch {}
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

export { name, inject, Config, apply };
