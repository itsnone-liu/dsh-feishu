/**
 * AutoContinue — 订阅额度耗尽后的自动监测 + 自动继续（+ 限额自动换模型）。
 *
 * 背景：订阅制模型（GLM Coding Plan、Qwen 订阅等）按 5 小时窗口限额，
 * 额度打满后回合以 429/quota 错误结束。本模块让桥代替人盯这件事：
 *
 *  - 监听每个绑定会话的 turn/end（reason.kind === 'error'）；
 *  - 错误文本分类：
 *      · quota 类（额度/配额/quota/exhausted/用完）→ 长等待：解析
 *        「重置于 HH:MM / reset at … / retry after Ns」提示，解析不到
 *        就按 pollMs 轮询；到点自动补发一条「继续」（可配置）；
 *      · 瞬时限流类（429 / rate limit / 上游负载 / try again in Ns）
 *        → 短退避：30s 起指数退避重试，shortMax 次后**升级为长等待**；
 *  - **限额自动换模型（fallback）**：配置了 fallbackBackup 且处于自动模式时，
 *    判定窗口打满（首次 long）不再傻等 ——
 *      ① 快照所有 live 会话当前模型；
 *      ② 全部切到备用模型（如 codex-gpt/gpt-5.6-luna）并设 driver.defaultOverride
 *         （fallback 期间新建/resume 的会话也走备用模型，不再踩已限额的主模型）；
 *      ③ 对被打断的会话立即补发「继续」—— 原任务无缝换脑续跑。注意
 *         turn/end 是在 session.append() 里同步分发的，此刻 agent 的 phase
 *         还停在 'running'（kick() 的 finally 稍后才置回 idle），所以这里
 *         绝不能按 status==='idle' 判断（2026-09-08 两次「切了模型却没
 *         自动继续」事故的根因）；driver.submit 对 running 走 steer（置
 *         wakeRequested，驱动循环收尾时自动重开，下一回合走已切换的模型），
 *         对 idle 走 followup，两条路都能接上。
 *      ④ watcher 保留，但到点的动作从「dsh 试跑」改为「curl 主模型探针」
 *         （会话在备用模型上干活，不能再靠它探主模型）；
 *      ⑤ 探针 200 → 还原快照/回主模型，并且把额度中断过、还没在备用模型
 *         上跑完的会话自动补发「继续」（切回 GLM 同样免人工）；
 *         备用模型上已完成的任务不硬塞继续。
 *    备用模型自己出错/限额：只发一次诊断卡（两边都受限，等主模型恢复），
 *    出错的会话记入中断清单，探针探通切回时一并自动续跑。
 *  - **手动模式**：/gpt /glm 快切（调试用）。手动切换 = 抑制一切自动切换
 *    与探针，直到 /glm 或 /auto 恢复自动。
 *  - 期间用户在本聊天发任何消息 → 取消该会话的纯等待 watcher（fallback
 *    探针不取消：它只打探针，不向会话注入消息，与新消息互不干扰）；
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
  /使用上限|usage\s*limit/,   // 百炼 1308「已达到5小时的使用上限」
  /insufficient\s+\w*balance/i,
  // GLM Coding Plan 5h 窗口：HTTP 429 body {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 … 重置。"}
  // 2026-08-26 事故：该文案不含「额度/配额/quota」却被 \b429\b 抢先判成瞬时限流，
  // 30/60/120/240s 连发 4 轮空卡。窗口类错误必须先于 429 判定。
  /\b1308\b/,
  /使用上限/,
  /已达.{0,12}上限/,
  /使用窗口/,
  /限额.{0,12}重置/,
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

/** 从错误文本解析「额度窗口长度」（小时）。百炼1308: 已达到5小时的使用上限 → 5。
 *  滚动窗口下, 恢复点 ≈ 最后一次成功调用 + 窗口长度(那时窗口内旧用量全部滑出)。 */
export function parseWindowLength(message) {
  const m = /(\d+)\s*(?:个)?\s*(?:小?时|hour)/i.exec(String(message ?? ''));
  return m ? Number(m[1]) : null;
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

/** 'provider/model' → {provider, model}；非法 → null。 */
export function parsePair(s) {
  const i = String(s ?? '').indexOf('/');
  if (i <= 0) return null;
  const provider = String(s).slice(0, i).trim();
  const model = String(s).slice(i + 1).trim();
  return provider && model ? { provider, model } : null;
}

export class AutoContinue {
  constructor({ config, driver, renderer, transport }) {
    this.config = config;
    this.driver = driver;
    this.renderer = renderer;
    this.transport = transport;
    /** sessionId → watcher state */
    this.watchers = new Map();

    // ---- 限额自动换模型状态 ----
    /** 'auto'（自动切换可介入）| 'manual'（/gpt 手动接管，一切自动动作抑制）。 */
    this.mode = 'auto';
    /** true = 已切到备用模型，watcher 到点跑主模型探针。 */
    this.fallbackActive = false;
    /** 切换前各会话模型快照 sessionId → {provider,model}（恢复时还原）。 */
    this.snapshots = new Map();
    /** 额度中断现场 sessionId → { chatId, doneOnBackup }：切回主模型时对
     *  未完成的自动补发「继续」（doneOnBackup=true 的除外，别硬塞）。 */
    this.interrupted = new Map();
    /** 备用模型侧出错只提示一次。 */
    this.backupErrorNotified = false;
    /** 探针注入点（离线测试用）：async () => boolean。 */
    this.probeFn = null;
  }

  /** 主/备模型对（配置了才可用）。 */
  #primary() { return this.config.fallbackPrimary ? parsePair(this.config.fallbackPrimary) : null; }
  #backup() { return this.config.fallbackBackup ? parsePair(this.config.fallbackBackup) : null; }

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
      if (reason?.kind === 'completed') {
        // fallback 期间的成功来自备用模型：不是主模型恢复信号，不 finish、
        // 也不刷新 lastOkAt（它是主模型窗口恢复点推算的锚，被备用模型
        // 的成功污染会让推算失真）。
        if (!this.fallbackActive) {
          this.lastOkAt = Date.now();
          if (this.watchers.has(sessionId)) this.#finish(sessionId, chatId);
        } else if (this.interrupted.has(sessionId)) {
          // 备用模型把被打断的任务跑完了：切回主模型时不再补发「继续」。
          this.interrupted.get(sessionId).doneOnBackup = true;
        }
      }
      return;
    }

    const message = [reason.error?.code, reason.error?.message].filter(Boolean).join(': ');

    // fallback 进行中：会话在备用模型上跑，这里的错误是备用侧的。
    // 不重新调度等待（主模型探针已在跑），只提示一次。
    if (this.fallbackActive) {
      this.#onBackupSideError(sessionId, chatId, message);
      return;
    }
    // 手动模式：用户接管（/gpt），自动机制完全静默。
    if (this.mode === 'manual') return;

    const kind = classifyFailure(message, cfg.autoContinuePatterns ?? []);
    if (!kind) {
      // 与额度无关的失败：若此前在等待，就此打住（配置问题不该傻等 5 小时）
      if (this.watchers.has(sessionId)) this.#giveUp(sessionId, chatId, `等待期间出现非额度错误：${message}`);
      return;
    }
    this.#schedule(sessionId, chatId, kind, message);
  }

  /** fallback 中备用模型侧的回合错误：诊断卡一次，不重调度。 */
  #onBackupSideError(sessionId, chatId, message) {
    const backup = this.#backup();
    const cur = (() => {
      try { return this.driver.currentModel(this.driver.live.get(sessionId)?.agent); } catch { return null; }
    })();
    // 只有错误确实出自备用模型上的会话才算「两边都受限」——fallback 刚切入
    // 时主模型上在途请求的尾巴错误不算。
    const fromBackup = backup && cur?.provider === backup.provider && cur?.model === backup.model;
    // 备用模型上被限/出错的会话记入中断清单：探针探通、切回主模型时
    // 一并自动补发「继续」（两边都受限期间任务挂起，不能就此丢下）。
    if (fromBackup && classifyFailure(message) && !this.interrupted.has(sessionId)) {
      this.interrupted.set(sessionId, { chatId, doneOnBackup: false });
    }
    if (!this.backupErrorNotified) {
      this.backupErrorNotified = true;
      const backupText = String(message);
      const missingCredential = /MISSING_CREDENTIAL|no credential|API.?KEY.*not set|not configured/i.test(backupText);
      const backupTitle = missingCredential ? '❌ GPT备用通道未配置凭据' : (fromBackup ? '⚠️ 备用模型也受限' : '⚠️ 备用模型侧出错');
      this.#send(chatId, buildInfoCard(backupTitle, [
        missingCredential
          ? '主模型已切换到GPT备用通道，但备用通道凭据缺失或未注入；这不是GPT额度耗尽。已保留主模型恢复探测。'
          : fromBackup
            ? '主模型额度窗口耗尽且备用模型也报错——两边订阅可能都在限额内，桥继续探测主模型恢复，探通即自动切回并继续。'
            : 'fallback 期间备用模型回合出错，桥继续探测主模型恢复。',
        '', '可用 /glm 手动切回主模型，或稍后再试。', '',
        `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
      ].join('\n'), { template: 'grey' }));
      log.warn(`fallback backup-side error for ${sessionId}: ${String(message).slice(0, 200)}`);
    }
  }

  /** 用户在聊天里发了新消息 → 取消该会话的自动等待（fallback 探针除外：
   *  它只打主模型探针、不向会话注入消息，与新消息互不干扰）。 */
  cancelForChat(chatId) {
    for (const [sessionId, w] of this.watchers) {
      if (w.chatId === chatId && !this.fallbackActive) {
        this.#clearTimer(sessionId);
        this.watchers.delete(sessionId);
        log.info(`auto-continue cancelled for ${sessionId} (user spoke in chat)`);
      }
    }
  }

  dispose() {
    for (const sessionId of [...this.watchers.keys()]) this.#clearTimer(sessionId);
    this.watchers.clear();
    this.interrupted.clear();
  }

  #clearTimer(sessionId) {
    const w = this.watchers.get(sessionId);
    if (w?.timer) clearTimeout(w.timer);
  }

  #clearAllWatchers() {
    for (const sessionId of [...this.watchers.keys()]) this.#clearTimer(sessionId);
    this.watchers.clear();
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
      // 短退避用尽 → 升级为长等待而非放弃。
      // 5 小时订阅窗口打满时，上游常只报 429/rate limit（无额度字样），
      // 短退避约 26 分钟远够不到窗口重置，旧逻辑在此放弃 → 无法自动恢复
      // （2026-09-04 07:27 实测事故）。升级后按 pollMs 节奏探测，maxMs 封顶。
      kind = 'long';
      if (prev?.kind !== 'long') {
        const wlenH = parseWindowLength(message);
        const recoverAt = wlenH && this.lastOkAt ? this.lastOkAt + wlenH * 3_600_000 + 30_000 : null;
        this.#send(chatId, buildInfoCard('⏳ 疑似窗口打满，转入长等待', [
          `瞬时限流连续重试 ${attempts - 1} 次未恢复，可能是订阅额度窗口用满。`,
          '', recoverAt
            ? `按${wlenH}小时滚动窗口推算，${new Date(recoverAt).toLocaleString('zh-CN', { hour12: false })} 定点自动继续；届时仍受限则每 ${Math.round((cfg.autoContinuePollMs ?? 10 * 60_000) / 60_000)} 分钟再探。`
            : `未给出重置时间，每 ${Math.round((cfg.autoContinuePollMs ?? 10 * 60_000) / 60_000)} 分钟探测一次，最长等 ${Math.round((cfg.autoContinueMaxMs ?? 6 * 3_600_000) / 3_600_000)} 小时。`,
          '期间你发消息即取消。', '',
          `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
        ].join('\n'), { template: 'grey' }));
        log.warn(`auto-continue escalated to long-watch for ${sessionId}: transient limit persisted`);
      }
    }

    // —— 限额自动换模型：首次判定窗口打满（long）即切入，原任务换脑续跑。
    //    时间调度照常走（#fire 在 fallback 态改跑主模型探针）。
    if (kind === 'long') this.#maybeEnterFallback(sessionId, chatId, message);

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
    } else if (hint?.at && hint.at.getTime() > Date.now() + 60_000) {
      // 只信「还来得及」的重置时刻。窗口已过/1 分钟内的 stale 提示按无提示处理
      // （否则 hint.at 在过去 → delay 被钳到 5s → 每隔几秒补发一轮，2026-08-26 教训）。
      const cap = cfg.autoContinueMaxMs ?? 6 * 3_600_000;
      delayMs = Math.min(hint.at.getTime() - Date.now() + 30_000, cap);
      note = `按提示的窗口重置时间 ${hint.at.toLocaleString('zh-CN', { hour12: false })} 自动继续`;
    } else {
          // 窗口长度推断：滚动窗口恢复点 = 最后一次成功调用 + 窗口长度
          // （百炼1308「已达到5小时的使用上限」→ 到 lastOk+5h 旧用量全部滑出，
          //  一次定点探测即可，无需按 pollMs 傻轮询；届时仍受限再转轮询）
          const wlenH = parseWindowLength(message);
          const recoverAt = wlenH && this.lastOkAt
            ? this.lastOkAt + wlenH * 3_600_000 + 30_000
            : null;
          if (recoverAt) {
            delayMs = Math.max(5_000, Math.min(
              recoverAt - Date.now(), cfg.autoContinueMaxMs ?? 6 * 3_600_000));
            note = `按${wlenH}小时滚动窗口推算恢复点 ${new Date(recoverAt).toLocaleString('zh-CN', { hour12: false })} 定点继续`;
          } else {
            const first = !prev;
            delayMs = first
              ? (cfg.autoContinueFirstMs ?? 60_000)
              : (cfg.autoContinuePollMs ?? 10 * 60_000);
            note = `未给出重置时间，每 ${Math.round(delayMs / 60_000)} 分钟探测一次`;
          }
        }

        const nextAt = new Date(Date.now() + delayMs);
    const w = { chatId, kind, attempts, firstAt, nextAt, lastError: String(message).slice(0, 300), timer: null };
    this.watchers.set(sessionId, w);
    w.timer = setTimeout(() => this.#fire(sessionId), delayMs);

    // 首次进入等待才发卡（轮询续期不打扰；fallback 有自己的橙卡）
    if (!prev && !this.fallbackActive) {
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

  // ---------------------------------------------------------- fallback ----

  /** 首次 long（窗口打满判定）→ 切备用模型。幂等：只进一次。 */
  #maybeEnterFallback(sessionId, chatId, message) {
    if (this.fallbackActive) return;                 // 已在 fallback
    const backup = this.#backup();
    if (!backup) return;                             // 未配置备用模型 → 纯等待老行为
    const probe = this.config.fallbackProbe;
    if (!probe?.url || !probe?.apiKeyEnv || !process.env[probe.apiKeyEnv]) {
      log.warn(`fallback: probe misconfigured or ${probe?.apiKeyEnv} missing — staying in wait mode`);
      return;                                        // 探针不可用 → 不切（否则切过去探不回）
    }

    this.fallbackActive = true;
    this.backupErrorNotified = false;

    // ① 快照当前所有 live 会话的模型（恢复时还原；已有快照不覆盖——手动
    //    /gpt 先行的情况保留最原始快照）
    if (this.snapshots.size === 0) {
      for (const [id, entry] of this.driver.live) {
        try {
          const cur = this.driver.currentModel(entry.agent);
          if (cur) this.snapshots.set(id, { ...cur });
        } catch {}
      }
    }
    // ② 全量切换 + 新会话默认也走备用模型
    const skipped = this.driver.applyModelToAll(backup.provider, backup.model);
    this.driver.defaultOverride = { ...backup };

    // ③ 原任务在备用模型上立即续跑。
    //    turn/end 在 session.append() 里同步分发，此刻 agent 的 phase 还停在
    //    'running'（kick() 的 finally 稍后才置回 idle）——按 status==='idle'
    //    判断永远不成立，导致「切了模型却没自动继续」（2026-09-08 事故①）。
    //    driver.submit：running→steer（置 wakeRequested，驱动循环收尾时自动
    //    重开，下一回合走已切换的备用模型）；idle→followup。两条路都能接上，
    //    故不再看 status。
    //    但 steer/followup → inbox.splice 自身要 session.append('agent/inbox/
    //    spliced')——外层 turn/end 的 append 尚未返回，dsh-session 的重入锁
    //    直接抛 "cannot reenter"（2026-09-09 09:41 事故②：模型切了、resume
    //    却失败，任务死等 3.5 分钟直到用户手工「继续」）。该锁随 append()
    //    同步返回即释放 → 推迟一个宏任务提交即安全；再留几次短重试兜底，
    //    全部失败则发灰卡明确告知手工接续（不再静默 warn）。
    const entry = this.driver.live.get(sessionId);
    if (entry?.agent) {
      const resumeText = this.config.autoContinueMessage ?? '继续';
      const tryResume = (left) => {
        if (!this.fallbackActive) return;   // 探针已切回/手动退出，别重复续跑
        try {
          this.driver.submit(entry.agent, resumeText);
        } catch (e) {
          if (left > 0) { setTimeout(() => tryResume(left - 1), 250); return; }
          log.warn(`fallback resume submit failed for ${sessionId}: ${e.message}`);
          this.#send(chatId, buildInfoCard('⚠️ 备用模型已切换，但自动续跑失败', [
            `模型已切到 **${backup.provider}/${backup.model}**，但给被打断的任务补发「继续」未成功。`,
            '', '请手动发一条「继续」接续任务。', '',
            `\`\`\`\n${String(e.message).slice(0, 200)}\n\`\`\``,
          ].join('\n'), { template: 'grey' }));
        }
      };
      setTimeout(() => tryResume(8), 0);
    }
    this.interrupted.set(sessionId, { chatId, doneOnBackup: false });

    // ④ 橙卡告知（续跑结果是异步的，成败由后续行为/灰卡体现，不在此预支）
    this.#send(chatId, buildInfoCard('🔄 额度窗口打满，已切换备用模型', [
      `主模型额度窗口耗尽，已把会话切到 **${backup.provider}/${backup.model}** 接续干活，被打断的任务将自动继续。`,
      '',
      '桥同时开始探测主模型恢复，探通即自动切回（无需手动）。手动调试：`/gpt` `/glm` `/auto`。',
      '',
      `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
    ].join('\n'), { template: 'orange' }));
    log.info(`fallback entered: all sessions -> ${backup.provider}/${backup.model}`
      + `${skipped.length ? ` (skipped: ${skipped.join(',')})` : ''}`);
  }

  /** 主模型恢复探针：1-token 最小请求（同 key 同窗口，消耗可忽略）。
   *  this.probeFn 可注入覆盖（离线测试用，不打真网络）。 */
  async #probePrimary() {
    if (typeof this.probeFn === 'function') return await this.probeFn();
    const p = this.config.fallbackProbe;
    const key = process.env[p.apiKeyEnv];
    if (!key) return false;
    try {
      const resp = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      return resp.ok; // 200 = 窗口恢复；429/5xx = 仍受限
    } catch {
      return false;  // 网络错误/超时 → 当作未恢复，下轮再探
    }
  }

  /** fallback 退出：还原快照（无快照的 live 会话回主模型）+ 自动续跑中断
   *  过且未在备用模型上跑完的任务 + 绿卡。 */
  #exitFallback(chatId) {
    const primary = this.#primary() ?? parsePair('glm-coding/glm-5.3');
    this.fallbackActive = false;
    this.driver.defaultOverride = null;
    let restored = 0;
    for (const [id, entry] of this.driver.live) {
      const target = this.snapshots.get(id) ?? primary;
      try {
        this.driver.setModel(entry.agent, target.provider, target.model);
        restored++;
      } catch {}
    }
    this.snapshots.clear();
    // 额度中断过、备用模型上没跑完的会话：模型已还原，自动补发「继续」。
    // 三种结局分开播报——running 的会话跳过续跑（下个请求自然走主模型），
    // 但必须如实告知「仍在进行中」，不能谎报「已在备用模型上跑完」
    // （2026-09-09 12:07 事故③：绿卡说跑完了，任务其实在 job_output 轮询
    //  里，用户两条「继续」又等不到回音，被迫重启桥）。
    let recontinued = 0;
    let inFlight = 0;            // 仍在跑的回合：下个请求自动走已还原的主模型
    let finishedOnBackup = 0;
    const failed = [];
    for (const [id, info] of this.interrupted) {
      const entry = this.driver.live.get(id);
      if (!entry?.agent) { failed.push(id); continue; }
      if (info.doneOnBackup) { finishedOnBackup++; continue; } // 备用上已完成，不硬塞继续
      try {
        if (entry.agent.status === 'running') { inFlight++; continue; }
        this.driver.submit(entry.agent, this.config.autoContinueMessage ?? '继续');
        recontinued++;
      } catch { failed.push(id); }
    }
    this.interrupted.clear();
    this.#clearAllWatchers();
    this.#send(chatId, buildInfoCard('✅ 主模型已恢复，已自动切回', [
      `主模型额度窗口已重置：${restored} 个会话已切回原模型（快照还原）。`,
      ...[
        recontinued > 0 ? `被打断的任务已自动继续（${recontinued} 个），无需人工发「继续」。` : '',
        inFlight > 0 ? `${inFlight} 个会话的任务仍在进行中，其下一个请求自动走主模型（正在等的长工具调用可能还需 1-2 分钟）。` : '',
        finishedOnBackup > 0 ? `${finishedOnBackup} 个任务已在备用模型上跑完。` : '',
      ].filter(Boolean),
      ...(failed.length ? ['', `以下会话自动续跑失败，可手动发「继续」：${failed.join('、')}`] : []),
    ].join('\n'), { template: 'green' }));
    log.info(`fallback exited: primary recovered, sessions restored=${restored}, recontinued=${recontinued}`
      + (inFlight ? `, inFlight=${inFlight}` : '')
      + (finishedOnBackup ? `, finishedOnBackup=${finishedOnBackup}` : '')
      + (failed.length ? `, failed=${failed.length}` : ''));
  }

  // ------------------------------------------------------------ manual ----

  /** /gpt /glm /auto 手动切换（commands.js 调用）。返回 { ok, text }。 */
  manualSwitch(target) {
    const backup = this.#backup();
    const primary = this.#primary();
    if (target === 'gpt' || target === 'glm') {
      const pair = target === 'gpt' ? backup : primary;
      if (!pair) {
        return { ok: false, text: `fallback${target === 'gpt' ? 'Backup' : 'Primary'} 未配置（config.json）` };
      }
      // 停探针/等待，进手动模式（用户接管：中断清单一并清空，切回时不再自动续跑）
      this.#clearAllWatchers();
      this.interrupted.clear();
      if (this.snapshots.size === 0) {
        for (const [id, entry] of this.driver.live) {
          try {
            const cur = this.driver.currentModel(entry.agent);
            if (cur) this.snapshots.set(id, { ...cur });
          } catch {}
        }
      }
      if (target === 'gpt') {
        this.mode = 'manual';
        this.fallbackActive = false;
        this.driver.defaultOverride = { ...pair };
        this.driver.applyModelToAll(pair.provider, pair.model);
        return { ok: true, text: `已切到 ${pair.provider}/${pair.model}（手动模式：自动切换与探针已暂停）。\n下回合起生效。/glm 切回 · /auto 恢复自动` };
      }
      // /glm：切回主模型并恢复自动
      this.mode = 'auto';
      this.fallbackActive = false;
      this.snapshots.clear();
      this.driver.defaultOverride = null;
      this.driver.applyModelToAll(pair.provider, pair.model);
      return { ok: true, text: `已切回 ${pair.provider}/${pair.model}，自动切换已恢复。` };
    }
    if (target === 'auto') {
      this.mode = 'auto';
      this.#clearAllWatchers();
      this.interrupted.clear();
      return { ok: true, text: '已恢复自动切换（当前模型保持不变；下次限额事件会自动 fallback）。' };
    }
    return { ok: false, text: '用法：/gpt · /glm · /auto' };
  }

  /** 当前切换状态（/status 用）。 */
  statusLine() {
    const backup = this.#backup();
    const primary = this.#primary();
    if (!backup || !primary) return '模型切换：未配置（fallback 关闭）';
    if (this.mode === 'manual') return `模型切换：**手动**（当前策略停用；/auto 恢复）`;
    if (this.fallbackActive) return `模型切换：**限额 fallback 中**（备用 ${backup.provider}/${backup.model}，探针探测 ${primary.provider}/${primary.model} 恢复中）`;
    return `模型切换：自动（主 ${primary.provider}/${primary.model} ↔ 备 ${backup.provider}/${backup.model}）`;
  }

  // ------------------------------------------------------------- timer ----

  /** 到点：fallback 态打主模型探针；否则补发继续消息（用户若已接管/会话
   *  已不在，安静退出）。 */
  async #fire(sessionId) {
    const w = this.watchers.get(sessionId);
    if (!w) return;
    w.timer = null;

    if (this.fallbackActive) {
      // —— 探针模式：主模型 1-token 探测，200 即切回 ——
      const ok = await this.#probePrimary();
      if (!this.fallbackActive) return;   // 探针期间被手动退出了
      if (ok) {
        this.#exitFallback(w.chatId);
        return;
      }
      w.attempts++;
      const cfg = this.config;
      // maxMs 放弃：不再探，停 fallback 但保持备用模型（别把用户从能用的
      // 模型上切回仍受限的），通知手动处理。
      if (Date.now() - w.firstAt > (cfg.autoContinueMaxMs ?? 6 * 3_600_000)) {
        this.#clearAllWatchers();
        this.#send(w.chatId, buildInfoCard('⏹ 恢复探测已放弃', [
          `超过 ${Math.round((cfg.autoContinueMaxMs ?? 6 * 3_600_000) / 3_600_000)} 小时主模型仍未恢复，探测停止（会话保持在备用模型上可用）。`,
          '', '主模型恢复后手动 /glm 切回，或 /auto 恢复自动。',
        ].join('\n'), { template: 'grey' }));
        log.warn('fallback probe gave up after max wait');
        return;
      }
      w.timer = setTimeout(() => this.#fire(sessionId), cfg.autoContinuePollMs ?? 10 * 60_000);
      log.info(`fallback probe #${w.attempts} still limited`);
      return;
    }

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
