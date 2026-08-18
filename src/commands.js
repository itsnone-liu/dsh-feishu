/**
 * Slash commands (private chats). Everything else goes to the agent.
 *
 *   /help              this card
 *   /new [cwd]         start a fresh session (old one stays on disk)
 *   /stop              cancel the active turn (queued work survives)
 *   /status            binding + live agent state
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
  '- `/sessions` 列出本工作区会话 · `/resume <id前缀>` 接续旧会话',
  '- `/cwd <路径>` 设定下次新会话的工作区',
  '',
  'agent 提问或请求审批时会弹出按钮卡片；直接回复文字等于自由输入。',
].join('\n');

export class Commands {
  constructor({ config, store, driver, renderer, transport }) {
    this.config = config;
    this.store = store;
    this.driver = driver;
    this.renderer = renderer;
    this.transport = transport;
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
    this.store.update(chatId, binding);
    const agent = await this.driver.ensure(binding);
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
