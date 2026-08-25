/**
 * AutoContinue — 订阅额度耗尽后的自动监测 + 自动继续。
 *
 * 背景：订阅制模型（GLM Coding Plan、Qwen 订阅等）按 5 小时窗口限额，
 * 额度打满后回合以 429/quota 错误结束，用户必须等窗口重置后手动发
 * 「继续」才能接上。本模块让桥代替人盯这件事：
 *
 *  - 监听每个绑定会话的 turn/end（reason.kind === 'error'）；
 *  - 错误文本分类：
 *      · quota 类（额度/配额/quota/exhausted/用完）→ 长等待：解析
 *        「重置于 HH:MM / reset at … / retry after Ns」提示，解析不到
 *        就按 pollMs 轮询；到点自动补发一条「继续」（可配置）；
 *      · 瞬时限流类（429 / rate limit / 上游负载 / try again in Ns）
 *        → 短退避：30s 起指数退避重试，shortMax 次后放弃并通知；
 *  - 期间用户在本聊天发任何消息 → 立即取消（用户优先）；
 *  - 重试成功（turn/end completed）→ 发绿色卡片确认已自动恢复；
 *  - 超过 maxMs 仍失败 → 放弃并通知（保留最后一次错误）。
 *
 * 刻意不做的事：跨进程持久化等待状态（桥重启后等待即失效，用户重发
 * 一条消息即可，与手动模式一致）；对非本桥绑定会话的 session 动作。
 */
import { buildInfoCard } from './cards.js';
import { log } from './log.js';

/** 额度窗口类错误（长等待 + 按重置时间/轮询恢复）。 */
const LONG_PATTERNS = [
  /quota/i,
  /额度|配额/,
  /exhausted/i,
  /用完|耗尽|用尽/,
  /insufficient\s+\w*balance/i,
];

/** 瞬时限流类错误（短退避重试）。 */
const SHORT_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /限流|频率限制/,
  /上游负载|资源不足|饱和/,
  /too many requests/i,
];

/** 从错误文本解析「什么时候该再试」。返回 { at: Date } 或 { inMs } 或 null。 */
export function parseRetryHint(message) {
  const text = String(message ?? '');
  // try again in 30s / retry after 2 min / 稍后重试（等待 5 分钟）
  const dur = /(?:try again in|retry after|等待?|稍后重试)[^\d]{0,6}(\d+)\s*(s|sec|second|m|min|minute|h|hour)/i.exec(text);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    const mult = unit.startsWith('s') ? 1000 : unit.startsWith('m') ? 60_000 : 3_600_000;
    return { inMs: n * mult };
  }
  // reset at 2026-08-25 20:00 / 将在 2026-08-25 20:00 重置
  const iso = /(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/.exec(text);
  if (iso) {
    const at = new Date(`${iso[1]}T${iso[2].padStart(5, '0')}:00`);
    if (!Number.isNaN(at.getTime())) return { at };
  }
  // 重置于 20:00 / 20:00 重置 / will reset at 08:30 —— 只有时刻：今天已过则明天
  const hm = /(?:(?:reset|恢复|重置)[^\d]{0,10}(\d{1,2}:\d{2}))|(?:([^\d]\d{1,2}:\d{2})[^\d]{0,4}(?:重置|恢复))/i.exec(text);
  if (hm) {
    const time = hm[1] ?? hm[2];
    const [h, m] = time.split(':').map(Number);
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    return { at };
  }
  return null;
}

/** 分类一个回合错误。'long' | 'short' | null（与额度/限流无关）。 */
export function classifyFailure(message, extraLongPatterns = []) {
  const text = String(message ?? '');
  if (!text) return null;
  for (const p of extraLongPatterns) {
    try { if (new RegExp(p, 'i').test(text)) return 'long'; } catch {}
  }
  if (LONG_PATTERNS.some((p) => p.test(text))) return 'long';
  if (SHORT_PATTERNS.some((p) => p.test(text))) return 'short';
  return null;
}

export class AutoContinue {
  constructor({ config, driver, renderer, transport }) {
    this.config = config;
    this.driver = driver;
    this.renderer = renderer;
    this.transport = transport;
    /** sessionId → watcher state */
    this.watchers = new Map();
  }

  /** index.js 的 session/event 钩子转发进来（外层已有 try/catch）。 */
  onEvent(session, event) {
    if (event?.type !== 'turn/end') return;
    const cfg = this.config;
    if (cfg.autoContinue === false) return;
    const sessionId = session?.id;
    if (!sessionId) return;
    const chatId = this.renderer.chatOf(sessionId);
    if (!chatId) return; // 只管本桥绑定的会话
    const reason = event.data?.reason;
    if (reason?.kind !== 'error') {
      // 成功完成的回合：若有等待器，说明自动恢复成功
      if (reason?.kind === 'completed' && this.watchers.has(sessionId)) {
        this.#finish(sessionId, chatId);
      }
      return;
    }
    const message = [reason.error?.code, reason.error?.message].filter(Boolean).join(': ');
    const kind = classifyFailure(message, cfg.autoContinuePatterns ?? []);
    if (!kind) {
      // 与额度无关的失败：若此前在等待，就此打住（配置问题不该傻等 5 小时）
      if (this.watchers.has(sessionId)) this.#giveUp(sessionId, chatId, `等待期间出现非额度错误：${message}`);
      return;
    }
    this.#schedule(sessionId, chatId, kind, message);
  }

  /** 用户在聊天里发了新消息 → 取消该会话的自动等待。 */
  cancelForChat(chatId) {
    for (const [sessionId, w] of this.watchers) {
      if (w.chatId === chatId) {
        this.#clearTimer(sessionId);
        this.watchers.delete(sessionId);
        log.info(`auto-continue cancelled for ${sessionId} (user spoke in chat)`);
      }
    }
  }

  dispose() {
    for (const sessionId of [...this.watchers.keys()]) this.#clearTimer(sessionId);
    this.watchers.clear();
  }

  #clearTimer(sessionId) {
    const w = this.watchers.get(sessionId);
    if (w?.timer) clearTimeout(w.timer);
  }

  #schedule(sessionId, chatId, kind, message) {
    const cfg = this.config;
    const prev = this.watchers.get(sessionId);
    const firstAt = prev?.firstAt ?? Date.now();
    const attempts = (prev?.attempts ?? 0) + 1;
    this.#clearTimer(sessionId);

    // —— 放弃判定
    if (Date.now() - firstAt > (cfg.autoContinueMaxMs ?? 6 * 3_600_000)) {
      this.watchers.delete(sessionId);
      this.#send(chatId, buildInfoCard('⏹ 自动继续已放弃', [
        `等待超过上限（${Math.round((cfg.autoContinueMaxMs ?? 6 * 3_600_000) / 3_600_000)} 小时）仍未恢复。`,
        '', '窗口可能已重置但探测仍失败，请手动发一条消息接续。',
        '', `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
      ].join('\n'), { template: 'grey' }));
      log.warn(`auto-continue gave up for ${sessionId} after max wait`);
      return;
    }
    if (kind === 'short' && attempts > (cfg.autoContinueShortMax ?? 6)) {
      this.watchers.delete(sessionId);
      this.#send(chatId, buildInfoCard('⏹ 自动重试已放弃', [
        `瞬时限流连续重试 ${attempts - 1} 次仍失败。`,
        '', '可能是服务端持续过载，请稍后手动发一条消息接续。',
        '', `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
      ].join('\n'), { template: 'grey' }));
      log.warn(`auto-continue gave up for ${sessionId}: transient limit persisted`);
      return;
    }

    // —— 计算下一次尝试时间
    let delayMs;
    let note;
    const hint = kind === 'long' ? parseRetryHint(message) : null;
    if (kind === 'short') {
      delayMs = Math.min(10 * 60_000, 30_000 * 2 ** (attempts - 1));
      note = `瞬时限流，${Math.round(delayMs / 1000)}s 后第 ${attempts} 次自动重试`;
    } else if (hint?.inMs !== undefined) {
      delayMs = Math.max(5_000, Math.min(hint.inMs + 5_000, cfg.autoContinueMaxMs ?? 6 * 3_600_000));
      note = `服务端提示等待 ${Math.round(hint.inMs / 1000)}s，到点自动继续`;
    } else if (hint?.at) {
      delayMs = Math.max(5_000, hint.at.getTime() - Date.now() + 30_000);
      note = `按提示的窗口重置时间 ${hint.at.toLocaleString('zh-CN', { hour12: false })} 自动继续`;
    } else {
      const first = !prev;
      delayMs = first
        ? (cfg.autoContinueFirstMs ?? 60_000)
        : (cfg.autoContinuePollMs ?? 10 * 60_000);
      note = `未给出重置时间，每 ${Math.round(delayMs / 60_000)} 分钟探测一次`;
    }

    const nextAt = new Date(Date.now() + delayMs);
    const w = { chatId, kind, attempts, firstAt, nextAt, lastError: String(message).slice(0, 300), timer: null };
    this.watchers.set(sessionId, w);
    w.timer = setTimeout(() => this.#fire(sessionId), delayMs);

    // 首次进入等待才发卡（轮询续期不打扰）
    if (!prev) {
      this.#send(chatId, buildInfoCard('⏳ 额度受限，自动等待恢复', [
        `回合因**${kind === 'long' ? '额度窗口耗尽' : '瞬时限流'}**中断，桥会自动监测并在恢复后继续，无需手动发「继续」。`,
        '',
        `- 计划：${note}（约 ${nextAt.toLocaleTimeString('zh-CN', { hour12: false })}）`,
        `- 期间你随时发消息即可接管（自动等待立即取消）`,
        '',
        `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
      ].join('\n'), { template: 'orange' }));
    }
    log.info(`auto-continue scheduled for ${sessionId}: ${note}`);
  }

  /** 到点：补发继续消息（用户若已接管/会话已不在，安静退出）。 */
  #fire(sessionId) {
    const w = this.watchers.get(sessionId);
    if (!w) return;
    w.timer = null;
    const entry = this.driver.live.get(sessionId);
    const agent = entry?.agent;
    if (!agent) {
      this.watchers.delete(sessionId);
      log.info(`auto-continue: ${sessionId} no longer live — dropped`);
      return;
    }
    if (agent.status !== 'idle') {
      // 会话在忙（大概率用户接管了）→ 取消等待
      this.watchers.delete(sessionId);
      log.info(`auto-continue: ${sessionId} busy — assumed user takeover`);
      return;
    }
    const text = this.config.autoContinueMessage ?? '继续';
    try {
      this.driver.submit(agent, text);
      log.info(`auto-continue fired for ${sessionId} (attempt ${w.attempts})`);
    } catch (e) {
      this.watchers.delete(sessionId);
      log.error(`auto-continue submit failed: ${e.message}`);
    }
  }

  /** 等待中的会话成功完成了一个回合 → 自动恢复成功。 */
  #finish(sessionId, chatId) {
    const w = this.watchers.get(sessionId);
    this.#clearTimer(sessionId);
    this.watchers.delete(sessionId);
    this.#send(chatId, buildInfoCard('✅ 已自动恢复', [
      '额度/限流已恢复，上一任务已自动继续并完成，无需人工干预。',
      '',
      `共自动探测 ${w?.attempts ?? '?'} 次。`,
    ].join('\n'), { template: 'green' }));
    log.info(`auto-continue recovered for ${sessionId}`);
  }

  #giveUp(sessionId, chatId, why) {
    this.#clearTimer(sessionId);
    this.watchers.delete(sessionId);
    this.#send(chatId, buildInfoCard('⏹ 自动继续已停止', `${why}`, { template: 'grey' }));
    log.warn(`auto-continue stopped for ${sessionId}: ${why}`);
  }

  #send(chatId, card) {
    this.transport.sendCard(chatId, card).catch((e) => log.warn(`auto-continue card: ${e.message}`));
  }
}
