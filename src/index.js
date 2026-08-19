/**
 * dsh-feishu — the Feishu/Lark surface bundle plugin.
 *
 * Sibling of `dsh-web-app` / `dsh-headless` over the same `dsh-base`: this
 * process is the ONLY user-questions provider (that is the whole reason the
 * bridge is its own profile), renders durable session events as one streaming
 * card per turn, answers ask_user_question and approval seams from button
 * cards, and keeps zero conversation memory of its own — bindings only.
 */
import z from '@deepseek-ai/schemastery';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { BindingStore } from './store.js';
import { TurnRenderer } from './renderer.js';
import { SessionDriver } from './driver.js';
import { ChatRouter } from './router.js';
import { Commands } from './commands.js';
import { InteractionManager } from './ask.js';
import { createTransport } from './transport/index.js';

const name = 'feishu-bridge';

const inject = ['agents', 'sessions', 'agentDefaultModel', 'userQuestions', 'approval', 'permissionPresets'];

const Config = z.object({
  /** Path to the bridge JSON config; empty = $DSH_HOME/feishu/config.json */
  configFile: z.string().default(''),
});

function apply(ctx, config) {
  const { config: cfg, problems } = loadConfig(config.configFile || undefined);
  log.setLevel(process.env.DSH_FEISHU_LOG || 'info');

  log.info(`bridge starting (transport=${cfg.transport}, mockAgent=${cfg.mockAgent})`);
  if (problems.length) {
    log.warn(`config problems: ${problems.join('; ')}`);
  }

  const store = new BindingStore(cfg.dataDir);
  const driver = new SessionDriver({ ctx, config: cfg });

  // Transport first — renderer and interactions need it.
  createTransport(cfg)
    .then(async (transport) => {
      const renderer = new TurnRenderer({ transport, config: cfg });
      const interactions = new InteractionManager({
        transport,
        config: cfg,
        chatOfSession: (sessionId) => renderer.chatOf(sessionId),
      });
      const commands = new Commands({ config: cfg, store, driver, renderer, transport, permissionPresets: ctx.permissionPresets });
      const router = new ChatRouter({ config: cfg, store, driver, renderer, transport, interactions, commands });

      // ---- outbound seams ----
      ctx.userQuestions.registerProvider({
        ask: (request) => interactions.handleAsk(request),
      });
      ctx.on('approval/request', (req, next) => interactions.handleApproval(req, next));

      // ---- the durable event feed → streaming cards ----
      ctx.on('session/event', (session, event) => renderer.onEvent(session, event));

      // ---- inbound transport ----
      await transport.start({
        onMessage: (msg) => router.onMessage(msg),
        onCardAction: (action) => router.onCardAction(action),
      });
      log.info('bridge up');

      const cleanup = () => {
        transport.stop().catch(() => {});
        driver.disposeAll().catch((e) => log.warn(`driver dispose: ${e.message}`));
      };
      if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
      else ctx.on('dispose', cleanup);
    })
    .catch((e) => {
      log.error(`bridge failed to start: ${e.stack ?? e}`);
      throw e;
    });
}

export { name, inject, Config, apply };
