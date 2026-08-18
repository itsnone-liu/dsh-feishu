/**
 * SessionDriver: the only module that touches `ctx.agents`.
 *
 * V0.1 semantics:
 *  - one live agent handle per bound session, owned by this process
 *  - idle → followup() (new turn); running → steer() (next-step interruption)
 *  - /stop → cancel({kind:'user'}, {keepInbox:true})
 *  - mock mode swaps the real loop for a scripted FakeAgent that drives a REAL
 *    session through the REAL event pipeline (offline end-to-end tests).
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { newSessionId } from './util.js';
import { FakeAgent } from './fake-agent.js';
import { log } from './log.js';

export class SessionDriver {
  constructor({ ctx, config }) {
    this.ctx = ctx;
    this.config = config;
    /** sessionId → { handle?, agent, dispose? } (fake agents have no handle) */
    this.live = new Map();
  }

  #selection() {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }
    const sel = this.ctx.get('agentDefaultModel')?.currentSelection();
    return sel ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  }

  /**
   * Return a live agent for the binding, creating or resuming as needed.
   * Mutates `binding.sessionId` when a new session is created.
   */
  async ensure(binding, { allowCreate = true } = {}) {
    const existing = binding.sessionId ? this.live.get(binding.sessionId) : null;
    if (existing) return existing.agent;

    if (binding.sessionId) {
      const alreadyLive = this.ctx.agents.get(SessionId(binding.sessionId));
      if (alreadyLive) {
        this.live.set(binding.sessionId, { agent: alreadyLive });
        return alreadyLive;
      }
      try {
        return await this.#resume(binding);
      } catch (e) {
        log.warn(`resume ${binding.sessionId} failed: ${e.message}`);
        if (!allowCreate) throw e;
        // fall through: start a fresh session, keep the stale one on disk
      }
    }
    if (!allowCreate) throw new Error('no session bound');
    return await this.#create(binding);
  }

  async #create(binding) {
    const sessionId = SessionId(newSessionId());
    const selection = this.#selection();
    if (this.config.mockAgent) {
      const session = this.ctx.sessions.create(sessionId, {
        meta: { cwd: binding.cwd, agentPreset: this.config.agentPreset },
      });
      const agent = new FakeAgent(this.ctx, session, this.config);
      this.ctx.agents.register(agent);
      this.live.set(session.id, { agent });
      binding.sessionId = session.id;
      log.info(`mock agent created ${session.id} (cwd=${binding.cwd})`);
      return agent;
    }
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        cwd: binding.cwd,
        agentPreset: this.config.agentPreset,
      },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    this.live.set(handle.agent.id, { handle, agent: handle.agent });
    binding.sessionId = handle.agent.id;
    log.info(`agent created ${handle.agent.id} (cwd=${binding.cwd})`);
    return handle.agent;
  }

  async #resume(binding) {
    const selection = this.#selection();
    if (this.config.mockAgent) {
      // The mock keeps no cross-process state; reuse any live session object.
      const session = this.ctx.sessions.get(SessionId(binding.sessionId));
      if (!session) throw new Error('mock resume: session not live in this process');
      const agent = new FakeAgent(this.ctx, session, this.config);
      this.ctx.agents.register(agent);
      this.live.set(session.id, { agent });
      return agent;
    }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(binding.sessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    this.live.set(handle.agent.id, { handle, agent: handle.agent });
    log.info(`agent resumed ${handle.agent.id}`);
    return handle.agent;
  }

  /** Submit user text: steer when running, followup when idle. Returns which. */
  submit(agent, text) {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    const running = agent.status === 'running';
    if (running) agent.steer(message);
    else agent.followup(message);
    return running ? 'steer' : 'followup';
  }

  /** Hard-stop the active turn, keep queued work. */
  stop(agent) {
    agent.cancel({ kind: 'user' }, { keepInbox: true });
  }

  /** Drop our live handle (session stays durable on disk). */
  unload(sessionId) {
    const entry = this.live.get(sessionId);
    this.live.delete(sessionId);
    return entry?.handle?.dispose?.() ?? Promise.resolve();
  }

  async disposeAll() {
    await Promise.all([...this.live.keys()].map((id) => this.unload(id)));
  }

  isLive(sessionId) {
    return this.live.has(sessionId);
  }
}
