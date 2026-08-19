/**
 * Slash commands (private chats). Everything else goes to the agent.
 *
 *   /help              this card
 *   /new [cwd]         start a fresh session (old one stays on disk)
 *   /stop              cancel the active turn (queued work survives)
 *   /status            binding + live agent state
 *   /mode [name]       show / switch permission mode (read-only · workspace-write · danger-full-access)
 *   /model [p/m]       show / switch model (/model glm-5.3, /model glm-coding/glm-5.3)
 *   /preset [id]       show / switch agent preset (blank session switches live;
 *                      a session with history starts a fresh one on the preset)
 *   /sessions          list persisted sessions for this workspace (headers only)
 *   /resume <prefix>   rebind this chat to a persisted session
 *   /cwd <path>        set the workspace for the NEXT /new (whitelisted)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildInfoCard, buildErrorCard } from './cards.js';
import { isWorkspaceAllowed, dshHome } from './config.js';
import { log } from './log.js';

const HELP = [
  '**dsh-feishu 桥**',
  '',
  '- 直接发文字 = 和 agent 说话（运行中发送会作为下一步转向输入）',
  '- `/new [cwd]` 新会话 · `/stop` 停止本轮 · `/status` 状态',
  '- `/mode` 查看/切换权限模式（`/mode ro` 只读 · `/mode rw` 工作区可写 · `/mode full` 全权）',
  '- `/model` 查看/切换模型（如 `/model glm-5.3`；跨厂商用 `厂商/模型` 全称）',
  '- `/preset` 查看/切换预设（极简 minimal · 标准 standard · code · cordis；有历史的会话自动开新会话）',
  '- `/sessions` 列出本工作区会话 · `/resume <id前缀>` 接续旧会话',
  '- `/cwd <路径>` 设定下次新会话的工作区',
  '',
  'agent 提问或请求审批时会弹出按钮卡片；直接回复文字等于自由输入。',
].join('\n');

/** Friendly aliases → preset table keys (applied only when the key exists). */
const MODE_ALIASES = {
  ro: 'read-only',
  readonly: 'read-only',
  read: 'read-only',
  rw: 'workspace-write',
  write: 'workspace-write',
  ww: 'workspace-write',
  ws: 'workspace-write',
  full: 'danger-full-access',
  danger: 'danger-full-access',
  god: 'danger-full-access',
};

export class Commands {
  constructor({ config, store, driver, renderer, transport, permissionPresets, llm, agentPresets }) {
    this.config = config;
    this.store = store;
    this.driver = driver;
    this.renderer = renderer;
    this.transport = transport;
    this.permissionPresets = permissionPresets;
    this.llm = llm;
    this.agentPresets = agentPresets;
  }


  /** Returns true when the text was a command (and has been answered). */
  async handle(chatId, text) {
    if (!text.startsWith('/')) return false;
    const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ');
    try {
      switch (cmd) {
        case 'help':
        case 'start':
          await this.transport.sendCard(chatId, buildInfoCard('dsh-feishu 帮助', HELP));
          return true;
        case 'new':
          return await this.cmdNew(chatId, arg);
        case 'stop':
          return await this.cmdStop(chatId);
        case 'status':
          return await this.cmdStatus(chatId);
        case 'mode':
        case 'permission':
          return await this.cmdMode(chatId, arg);
        case 'model':
        case 'models':
          return await this.cmdModel(chatId, arg);
        case 'preset':
        case 'presets':
          return await this.cmdPreset(chatId, arg);
        case 'sessions':
        case 'ls':
          return await this.cmdSessions(chatId);
        case 'resume':
        case 'switch':
          return await this.cmdResume(chatId, arg);
        case 'cwd':
          return await this.cmdCwd(chatId, arg);
        default:
          await this.transport.sendCard(chatId, buildInfoCard('未知命令', `没有 \`${cmd}\`，试试 /help`, { template: 'grey' }));
          return true;
      }
    } catch (e) {
      log.error(`command ${cmd}: ${e.stack ?? e}`);
      await this.transport.sendCard(chatId, buildErrorCard(`/${cmd} 失败`, e.message));
      return true;
    }
  }

  async cmdNew(chatId, cwdArg) {
    const binding = this.store.get(chatId) ?? { sessionId: null, cwd: this.config.defaultCwd };
    let cwd = cwdArg || binding.cwd || this.config.defaultCwd;
    cwd = path.resolve(cwd);
    if (!isWorkspaceAllowed(this.config, cwd)) {
      await this.transport.sendCard(chatId, buildErrorCard('工作区不在白名单', `${cwd}\n允许：${this.config.allowedWorkspaces.join(', ')}`));
      return true;
    }
    if (binding.sessionId) await this.driver.unload(binding.sessionId).catch(() => {});
    binding.sessionId = null;
    binding.cwd = cwd;
    const agent = await this.driver.ensure(binding);
    // persist AFTER ensure() minted the session id (ensure mutates binding)
    this.store.update(chatId, { sessionId: binding.sessionId, cwd: binding.cwd });
    this.renderer.attach(agent.id, chatId);
    await this.transport.sendCard(chatId, buildInfoCard('新会话已就绪', [
      `session：\`${agent.id}\``,
      `工作区：\`${cwd}\``,
      `预设：\`${this.config.agentPreset}\``,
      '',
      '直接发消息开始。',
    ].join('\n'), { template: 'green' }));
    return true;
  }

  async cmdStop(chatId) {
    const binding = this.store.get(chatId);
    const agent = binding?.sessionId ? this.driver.live.get(binding.sessionId)?.agent : null;
    if (!agent) {
      await this.transport.sendCard(chatId, buildInfoCard('没有运行中的会话', '当前聊天没有绑定活动 agent。', { template: 'grey' }));
      return true;
    }
    this.driver.stop(agent);
    await this.transport.sendCard(chatId, buildInfoCard('已请求停止', '当前回合将被取消；排队中的输入保留。', { template: 'orange' }));
    return true;
  }

  async cmdStatus(chatId) {
    const binding = this.store.get(chatId);
    const lines = [`chat：\`${chatId}\``];
    if (!binding) {
      lines.push('未绑定会话（首条消息会创建）');
    } else {
      lines.push(`session：\`${binding.sessionId ?? '—'}\``, `工作区：\`${binding.cwd ?? '—'}\``);
      const entry = binding.sessionId ? this.driver.live.get(binding.sessionId) : null;
      if (entry) {
        lines.push(`agent 状态：**${entry.agent.status}**`, `模型：\`${entry.agent.options?.provider ?? ''}/${entry.agent.options?.model ?? ''}\``);
      } else {
        lines.push('agent：未在本进程运行（重启后首条消息会 resume）');
      }
    }
    lines.push(`审批模式：\`${this.config.approval}\``);
    await this.transport.sendCard(chatId, buildInfoCard('桥状态', lines.join('\n')));
    return true;
  }

  /** Resolve the live session behind a chat for mode switching (ensure if needed). */
  async #sessionForMode(chatId) {
    const binding = this.store.get(chatId);
    if (!binding?.sessionId && !binding?.cwd) {
      return { error: '当前聊天还没有会话；先发条消息或 /new 创建，模式随会话生效。' };
    }
    try {
      const agent = await this.driver.ensure(binding);
      this.store.update(chatId, { sessionId: binding.sessionId, cwd: binding.cwd });
      if (this.renderer.chatOf(agent.id) !== chatId) this.renderer.attach(agent.id, chatId);
      return { agent };
    } catch (e) {
      return { error: `无法恢复会话：${e.message}` };
    }
  }

  #modeLine(service, name, current) {
    let spec;
    try {
      spec = service.resolve(name);
    } catch {
      return `- \`${name}\``;
    }
    const label = service.optionOf(name)?.label ?? name;
    const desc = spec.description ? ` — ${spec.description}` : '';
    const mark = name === current ? ' ← 当前' : '';
    return `- \`${name}\`（${label}）：sandbox \`${spec.sandbox}\` · 审批 \`${spec.approval}\`${desc}${mark}`;
  }

  async cmdMode(chatId, arg) {
    const service = this.permissionPresets;
    if (!service) {
      await this.transport.sendCard(chatId, buildErrorCard('模式服务不可用', '本 composition 未加载 dsh-permission-presets。'));
      return true;
    }

    const res = await this.#sessionForMode(chatId);
    if (res.error) {
      await this.transport.sendCard(chatId, buildInfoCard('模式', res.error, { template: 'grey' }));
      return true;
    }
    const { agent } = res;

    if (!arg) {
      // bare /mode — current + table
      const current = service.current(agent.session.events);
      const names = [...service.names];
      if (!names.includes(current)) names.push(current); // e.g. 'custom'
      const lines = [
        `当前会话：\`${agent.id.replace(/^session-/, '').slice(0, 8)}\``,
        `当前模式：**${current}**`,
        '',
        '可切换：',
        ...names.map((n) => this.#modeLine(service, n, current)),
        '',
        '用法：`/mode <名称或别名>`（ro / rw / full）',
      ];
      await this.transport.sendCard(chatId, buildInfoCard('权限模式', lines.join('\n')));
      return true;
    }

    // resolve alias → table key
    const key = arg.toLowerCase();
    const target = service.names.includes(key) ? key : MODE_ALIASES[key];
    if (!target || !service.names.includes(target)) {
      await this.transport.sendCard(chatId, buildErrorCard('未知模式', `\`${arg}\`\n可用：${service.names.join('、')}\n别名：ro / rw / full`));
      return true;
    }
    const before = service.current(agent.session.events);
    service.set(agent.session, target);
    const after = service.current(agent.session.events);
    const spec = service.resolve(target);
    const lines = [
      `${before} → **${after}**`,
      `sandbox：\`${spec.sandbox}\` · 审批：\`${spec.approval}\``,
      '',
      after === 'danger-full-access'
        ? '⚠️ 全权模式：沙箱不限制文件写入，审批自动拒绝改为直通。'
        : '下一回合起生效（模型会收到模式切换通知）。',
    ];
    await this.transport.sendCard(chatId, buildInfoCard('模式已切换', lines.join('\n'), { template: 'orange' }));
    return true;
  }

  // ------------------------------------------------------------------ /model

  /** All advertised (provider, model) pairs, tolerating slow/unavailable discovery. */
  async #modelCatalog() {
    const providers = this.llm?.listProviders?.() ?? [];
    const rows = [];
    await Promise.all(
      providers.map(async (p) => {
        const id = p.id ?? p.name ?? p.provider ?? String(p);
        let models = [];
        try {
          models = await Promise.race([
            this.llm.listModels(id),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
          ]);
        } catch {}
        rows.push({ provider: id, models: (models ?? []).map((m) => m.id ?? m.name ?? String(m)) });
      })
    );
    return rows;
  }

  async cmdModel(chatId, arg) {
    if (!this.llm) {
      await this.transport.sendCard(chatId, buildErrorCard('模型服务不可用', '本 composition 未加载 dsh-llm。'));
      return true;
    }
    const res = await this.#sessionForMode(chatId);
    if (res.error) {
      await this.transport.sendCard(chatId, buildInfoCard('模型', res.error, { template: 'grey' }));
      return true;
    }
    const { agent } = res;
    const current = this.driver.currentModel(agent);

    if (!arg) {
      const catalog = await this.#modelCatalog();
      const lines = [`当前模型：**${current ? `${current.provider}/${current.model}` : '—'}**`, ''];
      for (const row of catalog) {
        const mark = current?.provider === row.provider ? ' ←' : '';
        if (row.models.length === 0) {
          lines.push(`- \`${row.provider}\`${mark}（未列举出模型）`);
        } else {
          lines.push(`- \`${row.provider}\`${mark}：${row.models.map((m) => `\`${m}\``).join(' · ')}`);
        }
      }
      lines.push('', '用法：`/model <模型>`（唯一时）或 `/model <厂商>/<模型>`');
      await this.transport.sendCard(chatId, buildInfoCard('模型', lines.join('\n')));
      return true;
    }

    // resolve the target
    let provider;
    let model;
    if (arg.includes('/')) {
      [provider, model] = arg.split('/').map((x) => x.trim());
    } else {
      const catalog = await this.#modelCatalog();
      const hits = catalog.filter((r) => r.models.includes(arg));
      if (hits.length === 1) {
        provider = hits[0].provider;
        model = arg;
      } else if (hits.length > 1) {
        await this.transport.sendCard(chatId, buildErrorCard('模型名不唯一', `多个厂商都有 \`${arg}\`：\n${hits.map((h) => `- ${h.provider}/${arg}`).join('\n')}\n请用全称。`));
        return true;
      } else {
        await this.transport.sendCard(chatId, buildErrorCard('未找到模型', `\`${arg}\` 不在已列举模型中。用 \`/model\` 查看列表，或 \`/model <厂商>/<模型>\` 直接指定。`));
        return true;
      }
    }
    if (!provider || !model) {
      await this.transport.sendCard(chatId, buildErrorCard('用法', '/model <模型> 或 /model <厂商>/<模型>'));
      return true;
    }
    if (!this.llm.listProviders().some((p) => (p.id ?? p.name ?? p.provider) === provider)) {
      await this.transport.sendCard(chatId, buildErrorCard('无法切换', `厂商 \`${provider}\` 未注册（/model 查看可用厂商）`));
      return true;
    }
    this.driver.setModel(agent, provider, model);
    await this.transport.sendCard(chatId, buildInfoCard('模型已切换', [
      `${current ? `${current.provider}/${current.model}` : '—'} → **${provider}/${model}**`,
      '',
      '下一回合起生效（prompt 变量与请求路由同步切换）。',
    ].join('\n'), { template: 'green' }));
    return true;
  }

  // ---------------------------------------------------------------- /preset

  #sessionIsBlank(session) {
    return !(session.events ?? []).some((e) => e.type === 'turn/start' || e.type === 'user/message');
  }

  #currentPreset(agent) {
    if (this.agentPresets?.composedPreset && agent.ctx) {
      const live = this.agentPresets.composedPreset(agent.ctx);
      if (live) return live;
    }
    const events = agent.session?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'agent-preset/selected') return events[i].data.agentPreset;
    }
    return agent.session?.header?.agentPreset ?? null;
  }

  async cmdPreset(chatId, arg) {
    if (!this.agentPresets) {
      await this.transport.sendCard(chatId, buildErrorCard('预设服务不可用', '本 composition 未加载 dsh-agent-presets。'));
      return true;
    }
    let presets = [];
    try {
      presets = await this.agentPresets.list();
    } catch (e) {
      await this.transport.sendCard(chatId, buildErrorCard('预设列表读取失败', e.message));
      return true;
    }

    if (!arg) {
      const binding = this.store.get(chatId);
      const entry = binding?.sessionId ? this.driver.live.get(binding.sessionId) : null;
      const current = entry ? this.#currentPreset(entry.agent) : null;
      const lines = [
        `当前预设：**${current ?? '—'}**（新会话默认 \`${this.config.agentPreset}\`）`,
        '',
        ...presets.map((p) => {
          const mark = p.id === current ? ' ← 当前' : '';
          const broken = p.broken ? ` ⚠️ ${p.broken}` : '';
          return `- \`${p.id}\`[${p.trust}]${broken}${mark}`;
        }),
        '',
        '空白会话直接切换；有历史的会话将自动以该预设**开新会话**（旧会话保留在盘上）。',
      ];
      await this.transport.sendCard(chatId, buildInfoCard('Agent 预设', lines.join('\n')));
      return true;
    }

    // resolve + validate the target preset
    let preset;
    try {
      preset = await this.agentPresets.resolve(arg);
      if (preset.broken) throw new Error(`预设损坏：${preset.broken}`);
    } catch (e) {
      await this.transport.sendCard(chatId, buildErrorCard('未知预设', `\`${arg}\`：${e.message}\n可用：${presets.filter((p) => !p.broken).map((p) => p.id).join('、')}`));
      return true;
    }

    const binding = this.store.get(chatId) ?? { sessionId: null, cwd: this.config.defaultCwd };
    const entry = binding.sessionId ? this.driver.live.get(binding.sessionId) : null;

    // Blank live session → real in-place recompose (official supported path).
    if (entry && this.#sessionIsBlank(entry.agent.session) && entry.agent.ctx && !this.config.mockAgent) {
      try {
        await this.agentPresets.recompose(entry.agent.ctx, preset.id);
      } catch (e) {
        await this.transport.sendCard(chatId, buildErrorCard('切换失败', e.message));
        return true;
      }
      await this.transport.sendCard(chatId, buildInfoCard('预设已切换', [
        `${this.#currentPreset(entry.agent)} → **${preset.id}**`,
        '',
        '会话仍为空白，已原地重组（工具与提示词即刻更换）。',
      ].join('\n'), { template: 'green' }));
      return true;
    }

    // Mock approximation of the blank switch: record the selection event only.
    if (entry && this.#sessionIsBlank(entry.agent.session) && this.config.mockAgent) {
      try {
        entry.agent.session.append('agent-preset/selected', { agentPreset: preset.id });
      } catch {}
      await this.transport.sendCard(chatId, buildInfoCard('预设已切换（mock）', `${preset.id}（事件已记录）`));
      return true;
    }

    // Session with history (or no live agent): start a fresh session on the preset.
    if (binding.sessionId) await this.driver.unload(binding.sessionId).catch(() => {});
    binding.sessionId = null;
    binding.cwd = binding.cwd ?? this.config.defaultCwd;
    this.store.update(chatId, binding);
    try {
      const agent = await this.driver.ensure(binding, { preset: preset.id });
      this.renderer.attach(agent.id, chatId);
      this.store.update(chatId, { sessionId: binding.sessionId, cwd: binding.cwd });
      await this.transport.sendCard(chatId, buildInfoCard('已用新预设开会话', [
        `预设：\`${preset.id}\` · session：\`${agent.id.replace(/^session-/, '').slice(0, 8)}\``,
        `工作区：\`${binding.cwd}\``,
        '',
        '原会话有历史，预设不能原地切换（会破坏工具/提示词与历史的对应）；旧会话保留，`/sessions` 可回。',
      ].join('\n'), { template: 'green' }));
    } catch (e) {
      await this.transport.sendCard(chatId, buildErrorCard('新会话创建失败', e.message));
    }
    return true;
  }

  /** List persisted sessions by reading only their header frames. */
  #listPersistedSessions() {
    const root = path.join(dshHome(), 'sessions');
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const proj of fs.readdirSync(root)) {
      const projDir = path.join(root, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const id of fs.readdirSync(projDir)) {
        const dir = path.join(projDir, id);
        try {
          const f = path.join(dir, 'session.jsonl.zstd');
          const existsZ = fs.existsSync(f);
          const existsRaw = !existsZ && fs.existsSync(path.join(dir, 'session.jsonl'));
          if (!existsZ && !existsRaw) continue;
          let header;
          if (existsZ) {
            // the header is its own leading zstd frame — single-frame decode is enough
            const first = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8').split('\n')[0];
            header = JSON.parse(first);
          } else {
            const first = fs.readFileSync(path.join(dir, 'session.jsonl'), 'utf8').split('\n')[0];
            header = JSON.parse(first);
          }
          out.push({ id, cwd: header.cwd, createdAt: header.createdAt, preset: header.agentPreset });
        } catch (e) {
          out.push({ id, cwd: null, createdAt: 0, preset: null, error: e.message });
        }
      }
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async cmdSessions(chatId) {
    const binding = this.store.get(chatId);
    const cwd = binding?.cwd ?? this.config.defaultCwd;
    const all = this.#listPersistedSessions();
    const mine = all.filter((s) => s.cwd && (s.cwd === cwd || s.cwd.startsWith(cwd + path.sep)));
    const lines = mine.length === 0
      ? [`工作区 \`${cwd}\` 下没有持久会话。`]
      : mine.slice(0, 15).map((s) => {
          const when = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
          const mark = binding?.sessionId === s.id ? ' ← 当前' : '';
          return `- \`${s.id.replace(/^session-/, '').slice(0, 8)}\` ${when} [${s.preset ?? '-'}]${mark}`;
        });
    if (mine.length > 15) lines.push(`… 共 ${mine.length} 个`);
    await this.transport.sendCard(chatId, buildInfoCard(`会话（${mine.length}）· ${cwd}`, lines.join('\n')));
    return true;
  }

  async cmdResume(chatId, prefix) {
    if (!prefix) {
      await this.transport.sendCard(chatId, buildErrorCard('用法', '/resume <session-id 前 8 位>（先 /sessions 查看列表）'));
      return true;
    }
    const all = this.#listPersistedSessions();
    const hits = all.filter((s) => s.id.includes(prefix));
    if (hits.length === 0) {
      await this.transport.sendCard(chatId, buildErrorCard('没找到', `没有匹配 ${prefix} 的持久会话`));
      return true;
    }
    if (hits.length > 1) {
      await this.transport.sendCard(chatId, buildErrorCard('歧义', `前缀匹配多个会话，再加几位：\n${hits.map((h) => h.id.slice(0, 18)).join('\n')}`));
      return true;
    }
    const target = hits[0];
    if (target.cwd && !isWorkspaceAllowed(this.config, target.cwd)) {
      await this.transport.sendCard(chatId, buildErrorCard('会话工作区不在白名单', `${target.cwd}`));
      return true;
    }
    const binding = this.store.get(chatId) ?? { sessionId: null, cwd: target.cwd };
    if (binding.sessionId) await this.driver.unload(binding.sessionId).catch(() => {});
    binding.sessionId = target.id;
    binding.cwd = target.cwd ?? binding.cwd;
    this.store.update(chatId, binding);
    // verify it can actually come alive (fake mode needs a live session object)
    try {
      const agent = await this.driver.ensure(binding, { allowCreate: false });
      this.renderer.attach(agent.id, chatId);
      const when = target.createdAt ? new Date(target.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
      await this.transport.sendCard(chatId, buildInfoCard('已接续会话', `\`${target.id}\`\n创建于 ${when}\n工作区 \`${target.cwd}\``, { template: 'green' }));
    } catch (e) {
      await this.transport.sendCard(chatId, buildErrorCard('接续失败', e.message));
    }
    return true;
  }

  async cmdCwd(chatId, arg) {
    if (!arg) {
      const binding = this.store.get(chatId);
      await this.transport.sendCard(chatId, buildInfoCard('工作区', `当前：\`${binding?.cwd ?? this.config.defaultCwd}\`\n白名单：${this.config.allowedWorkspaces.map((w) => `\`${w}\``).join(', ')}`));
      return true;
    }
    const cwd = path.resolve(arg);
    if (!isWorkspaceAllowed(this.config, cwd)) {
      await this.transport.sendCard(chatId, buildErrorCard('工作区不在白名单', `${cwd}`));
      return true;
    }
    const binding = this.store.update(chatId, { cwd });
    await this.transport.sendCard(chatId, buildInfoCard('工作区已设定（对下一个 /new 生效）', `\`${cwd}\``, { template: 'green' }));
    return true;
  }
}
