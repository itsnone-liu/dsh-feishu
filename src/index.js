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
import { AuditController } from './audit/controller.js';
import { AuditLifecycle } from './audit/lifecycle.js';

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
      const commands = new Commands({ config: cfg, store, driver, renderer, transport, permissionPresets: ctx.permissionPresets, llm: ctx.llm, agentPresets: ctx.agentPresets, visionReady, autoContinue: null });
      const autoContinue = new AutoContinue({ config: cfg, driver, renderer, transport });
      commands.autoContinue = autoContinue; // 注入（构造顺序：Commands 先建，AutoContinue 需要 transport 就绪）
      // A2：/audit 命令面 —— AuditController 只包装 A1 冻结内核，不驱动执行端（A3/A5 接线）。
      // store 根目录 $DSH_HOME/feishu/audit，与 bindings/运行态同区。
      const { AuditController } = await import('./audit/controller.js');
      commands.auditController = new AuditController({
        hostId: process.env.HOST_ID,
      });
      commands.auditLifecycle = new AuditLifecycle({
        controller: commands.auditController,
        driver,
        bindings: store,
      });
      commands.auditController.lifecycle = commands.auditLifecycle;
      // A5：真实 Web 审核器接入 —— 只注入 reviewer 实例，不改 A4 冻结 orchestration。
      // 默认（audit.reviewer=''）关闭时，桥行为与 A4 完全一致。
      if (cfg.audit?.reviewer === 'web') {
        const { WebAuditRunner } = await import('./audit/web-runner.js');
        const { GitEvidenceProvider } = await import('./audit/git-evidence.js');
        commands.auditLifecycle.reviewer = new WebAuditRunner({
          ...cfg.audit.web,
          // A5.5（A′）：verified git evidence bundle —— fact source 仍是 GitHub
          // @TARGET_COMMIT，transport 改为桥生成的 object-db 证据包。
          evidence: {
            provider: new GitEvidenceProvider(),
            resolve: (runId) => commands.auditController.resolveRunContext(runId),
          },
        });
        log.info(`audit reviewer: web (${cfg.audit.web.baseUrl}, model=${cfg.audit.web.model}, evidence=verified-git)`);
      }
      // A3.1：桥启动时恢复所有非终态 audit run 的 executor 监听；不重复发送 stage prompt。
      commands.auditLifecycle.restoreActive().catch((e) => {
        log.error(`audit lifecycle restore failed: ${e?.stack ?? e}`);
      });
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
        // A3 executor observer: never throw through synchronous DSH append.
        Promise.resolve(commands.auditLifecycle?.onEvent(session, event)).catch((e) => {
          log.error(`audit executor event ${event?.type} failed (contained): ${e?.stack ?? e}`);
        });
      });

      // ---- inbound transport ----
      await transport.start({
        onMessage: (msg) => router.onMessage(msg),
        onCardAction: (action) => router.onCardAction(action),
      });
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
      log.error(`bridge failed to start: ${e.stack ?? e}`);
      throw e;
    });
}

export { name, inject, Config, apply };
