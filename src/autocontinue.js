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
 *  - **限额自动换模型（fallback，双向·不回切）**：配置了 fallbackPrimary +
 *    fallbackBackup 时，判定窗口打满（首次 long）不再傻等 —— 方向由
 *    **实际报错的模型**决定（GPT 满 → 切 GLM；GLM 满 → 切 GPT）：
 *      ① 全部 live 会话切到另一侧，并设 driver.defaultOverride（fallback
 *         期间新建/resume 的会话也走接管模型，不再踩已限额的一侧）；
 *      ② 对被打断的会话立即补发「继续」—— 原任务无缝换脑续跑。注意
 *         turn/end 是在 session.append() 里同步分发的，此刻 agent 的 phase
 *         还停在 'running'（kick() 的 finally 稍后才置回 idle），所以这里
 *         绝不能按 status==='idle' 判断（2026-09-08 两次「切了模型却没
 *         自动继续」事故的根因）；driver.submit 对 running 走 steer（置
 *         wakeRequested，驱动循环收尾时自动重开，下一回合走已切换的模型），
 *         对 idle 走 followup，两条路都能接上。
 *      ③ **不自动切回**（2026-09-13 用户定调）：额度恢复不是切换条件——
 *         只要接管侧没满，就留在接管侧干活；想换回手动 /gpt /glm。
 *         恢复探针/快照还原整套已删除，不再有探针 watcher。
 *      ④ 接管侧也限额（两侧都满）：**不切来切去**，只提示一次；之后
 *         等用户在额度恢复后发消息接续（当前侧恢复即可干活）或手动切换。
 *  - **手动偏好模式**：/gpt /glm 快切。手动选择决定常态模型，但不关闭
 *    额度安全网；当前模型耗尽时仍自动切到另一侧保底。
 *  - 期间用户在本聊天发任何消息 → 取消该会话的纯等待 watcher；
 *  - 超过 maxMs 仍失败 → 放弃并通知（保留最后一次错误）。
 *  - 启动/新建会话默认模型 = settings 的 agent-default-model（GLM），
 *    fallback 只在额度耗尽那一刻临时改写 default。
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
  // codex-proxy（GPT 备用通道）额度耗尽时的实测表象不是 quota 文案，而是
  // AUTH:401 {"message":"Not authenticated. Please login first at /","code":"invalid_api_key"}
  // —— 2026-09-12 用户报告：该 401 被 classifyFailure 判为"非额度错误"直接放弃，
  // GPT 侧永远不触发 fallback，只剩一张 API 错误卡。凭据/登录类中断必须按
  // 窗口类处理：切到另一侧继续干活（想回 GPT 时手动切换）。
  /not authenticated/i,
  /please login first/i,
  /invalid_api_key/,
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
    /** 'auto' | 'manual'（手动选择常态模型；两者都保留额度安全网）。 */
    this.mode = 'auto';
    /** true = 已因额度耗尽切到另一侧（不自动切回，直到手动 /gpt /glm /auto）。 */
    this.fallbackActive = false;
    /** 接管侧出错/两侧都满只提示一次（接管侧成功回合后重置，可再次提示）。 */
    this.takeoverErrorNotified = false;
    /** fallback 期间接管侧是否成功跑通过回合（区分「两侧都满」与「又满了」文案）。 */
    this.takeoverSucceeded = false;
    /** 当前因限额离开的模型与接管模型。自动切换必须由实际报错模型决定
     *  方向，不能永远假设 primary(GLM) 报错。 */
    this.limitedModel = null;
    this.takeoverModel = null;
  }

  /** 主/备模型对（配置了才可用）。 */
  #primary() { return this.config.fallbackPrimary ? parsePair(this.config.fallbackPrimary) : null; }
  #backup() { return this.config.fallbackBackup ? parsePair(this.config.fallbackBackup) : null; }
  #same(a, b) { return !!a && !!b && a.provider === b.provider && a.model === b.model; }
  #current(sessionId) {
    try { return this.driver.currentModel(this.driver.live.get(sessionId)?.agent); } catch { return null; }
  }
  /** 由实际报错的模型决定切换方向（双向）：GLM 满→切 GPT；GPT 满→切 GLM。
   *  报错模型不在配置对内（第三方模型）→ null（维持纯等待老行为）。 */
  #routeFor(sessionId) {
    const primary = this.#primary(); const backup = this.#backup(); const current = this.#current(sessionId);
    if (!primary || !backup || !current) return null;
    if (this.#same(current, primary)) return { limited: primary, takeover: backup };
    if (this.#same(current, backup)) return { limited: backup, takeover: primary };
    return null;
  }

  /** 清空 fallback 状态（手动切换/用户主动回到受限侧时调用）。 */
  #clearFallbackState() {
    this.fallbackActive = false;
    this.limitedModel = null;
    this.takeoverModel = null;
    this.takeoverErrorNotified = false;
    this.takeoverSucceeded = false;
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
      if (reason?.kind === 'completed') {
        if (this.fallbackActive) {
          // 接管侧的成功不是恢复信号（本来就不回切），但证明该侧当前可用：
          // 重置一次性提示旗，若之后再限额可以再次告知用户。
          this.takeoverErrorNotified = false;
          this.takeoverSucceeded = true;
          return;
        }
        this.lastOkAt = Date.now();
        if (this.watchers.has(sessionId)) this.#finish(sessionId, chatId);
      }
      return;
    }

    const message = [reason.error?.code, reason.error?.message].filter(Boolean).join(': ');

    // fallback 进行中：错误出自接管侧（或用户手动切回的模型），交给
    // 接管侧错误处理（两侧都满 → 只提示，不切来切去）。
    if (this.fallbackActive) {
      this.#onTakeoverSideError(sessionId, chatId, message);
      return;
    }
    // 手动偏好模式只表示「把当前模型作为用户偏好」，不能关闭额度安全网
    // （2026-09-12 事故：/gpt 后 GPT 耗尽只剩 API 错误卡，手动 /glm 却可用）。
    const kind = classifyFailure(message, cfg.autoContinuePatterns ?? []);
    if (!kind) {
      // 与额度无关的失败：若此前在等待，就此打住（配置问题不该傻等 5 小时）
      if (this.watchers.has(sessionId)) this.#giveUp(sessionId, chatId, `等待期间出现非额度错误：${message}`);
      return;
    }
    this.#schedule(sessionId, chatId, kind, message);
  }

  /** fallback 中接管侧的回合错误。两侧都满 → 只提示一次，**不切来切去**
   *  （2026-09-13 用户定调）；非额度错误同样只提示一次。用户若已手动把
   *  会话切回受限侧（cur===limited），视为主动选择：清掉 fallback 状态，
   *  按全新错误重新分类处理。 */
  #onTakeoverSideError(sessionId, chatId, message) {
    const cur = this.#current(sessionId);
    if (cur && this.limitedModel && cur.provider === this.limitedModel.provider && cur.model === this.limitedModel.model) {
      // 用户手动回到了受限侧：fallback 状态作废，重新分类（等待/再切换由事件定）
      this.#clearFallbackState();
      const kind = classifyFailure(message, this.config.autoContinuePatterns ?? []);
      if (kind) this.#schedule(sessionId, chatId, kind, message);
      return;
    }
    if (this.takeoverErrorNotified) return;   // 只提示一次，避免错误风暴刷卡
    this.takeoverErrorNotified = true;
    const takeover = this.takeoverModel ?? this.#backup();
    const fromTakeover = !!takeover && cur?.provider === takeover.provider && cur?.model === takeover.model;
    const quotaHit = !!classifyFailure(message);
    const againAfterSuccess = fromTakeover && quotaHit && this.takeoverSucceeded;
    const text = String(message);
    const missingCredential = /MISSING_CREDENTIAL|no credential|API.?KEY.*not set|not configured/i.test(text);
    const proxyLoggedOut = /not authenticated|please login first|invalid_api_key/i.test(text);
    const title = missingCredential ? '❌ GPT备用通道未配置凭据'
      : proxyLoggedOut ? '⚠️ GPT备用通道未登录'
      : againAfterSuccess ? '⏹ 接管侧额度又耗尽'
      : (fromTakeover && quotaHit) ? '⏹ 两侧额度都在限额内，自动切换已暂停'
      : '⚠️ 接管模型侧出错';
    const limitedName = `${this.limitedModel?.provider ?? '?'}/${this.limitedModel?.model ?? '?'}`;
    const takeoverName = `${takeover?.provider ?? '?'}/${takeover?.model ?? '?'}`;
    const body = missingCredential
      ? `已切换到GPT备用通道，但该通道凭据缺失或未注入；这不是GPT额度耗尽。请检查 CODEX_PROXY_API_KEY。`
      : proxyLoggedOut
        ? `GPT备用通道的 codex-proxy 会话未登录（Not authenticated / 请先登录）——多为GPT额度窗口耗尽或代理登录过期，不是桥的配置问题。请在 codex-proxy 首页重新登录后再手动 \`/gpt\` 切换。`
        : againAfterSuccess
          ? `接管侧 **${takeoverName}** 窗口再次打满。桥不自动切回；另一侧 **${limitedName}** 若已恢复可手动 \`/glm\` \`/gpt\` 切换，否则等窗口重置后直接发消息接续。`
          : (fromTakeover && quotaHit)
            ? `**${limitedName}** 与 **${takeoverName}** 的额度窗口都在限额内。桥**不再来回切换**（避免空转）；等任一侧窗口重置后直接发消息即可接续（当前停在 ${takeoverName}），也可手动 \`/gpt\` \`/glm\` 切换。`
            : `fallback 期间接管模型回合出错；桥保持现状，不做自动动作。`;
    this.#send(chatId, buildInfoCard(title, [
      body, '', `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
    ].join('\n'), { template: 'grey' }));
    log.warn(`fallback takeover-side error for ${sessionId}: ${String(message).slice(0, 200)}`);
  }

  /** 用户在聊天里发了新消息 → 取消该会话的自动等待（用户接管优先）。 */
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
    //    切换成功后不再安排等待 watcher（任务已立即续跑；回切只能手动）。
    if (kind === 'long' && this.#maybeEnterFallback(sessionId, chatId, message)) return;

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

  /** 首次 long（窗口打满判定）→ 切到另一侧。幂等：只进一次。
   *  返回 true = 已切换（调用方不再安排等待 watcher）。 */
  #maybeEnterFallback(sessionId, chatId, message) {
    if (this.fallbackActive) return true;             // 已在 fallback，视作已处理
    const route = this.#routeFor(sessionId);
    if (!route) {
      log.warn(`fallback: quota source is not a configured primary/backup model — staying in wait mode`);
      return false;
    }
    const { limited, takeover } = route;

    this.fallbackActive = true;
    this.takeoverErrorNotified = false;
    this.limitedModel = { ...limited };
    this.takeoverModel = { ...takeover };

    // ① 全量切换 + 新会话默认也走接管模型
    const skipped = this.driver.applyModelToAll(takeover.provider, takeover.model);
    this.driver.defaultOverride = { ...takeover };

    // ② 原任务在接管模型上立即续跑。
    //    turn/end 在 session.append() 里同步分发，此刻 agent 的 phase 还停在
    //    'running'（kick() 的 finally 稍后才置回 idle）——按 status==='idle'
    //    判断永远不成立，导致「切了模型却没自动继续」（2026-09-08 事故①）。
    //    driver.submit：running→steer（置 wakeRequested，驱动循环收尾时自动
    //    重开，下一回合走已切换的模型）；idle→followup。两条路都能接上，
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
        if (!this.fallbackActive) return;   // 手动切换抢先了，别重复续跑
        try {
          this.driver.submit(entry.agent, resumeText);
        } catch (e) {
          if (left > 0) { setTimeout(() => tryResume(left - 1), 250); return; }
          log.warn(`fallback resume submit failed for ${sessionId}: ${e.message}`);
          this.#send(chatId, buildInfoCard('⚠️ 模型已切换，但自动续跑失败', [
            `模型已切到 **${takeover.provider}/${takeover.model}**，但给被打断的任务补发「继续」未成功。`,
            '', '请手动发一条「继续」接续任务。', '',
            `\`\`\`\n${String(e.message).slice(0, 200)}\n\`\`\``,
          ].join('\n'), { template: 'grey' }));
        }
      };
      setTimeout(() => tryResume(8), 0);
    }

    // ③ 橙卡告知（续跑结果是异步的，成败由后续行为/灰卡体现，不在此预支）
    this.#send(chatId, buildInfoCard('🔄 额度窗口打满，已切换可用模型', [
      `**${limited.provider}/${limited.model}** 额度窗口耗尽，已把会话切到 **${takeover.provider}/${takeover.model}** 接续干活，被打断的任务将自动继续。`,
      '',
      `额度恢复后**不会自动切回**（避免来回折腾）；需要换回时手动 \`/gpt\` \`/glm\`。若两侧都在限额内，桥会提示并停止切换。`,
      '',
      `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
    ].join('\n'), { template: 'orange' }));
    log.info(`fallback entered: limited=${limited.provider}/${limited.model}, all sessions -> ${takeover.provider}/${takeover.model}`
      + `${skipped.length ? ` (skipped: ${skipped.join(',')})` : ''}`);
    return true;
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
      // 停等待 watcher，退出 fallback 状态（手动接管是用户明确意志）
      this.#clearAllWatchers();
      this.#clearFallbackState();
      if (target === 'gpt') {
        this.mode = 'manual';
        this.driver.defaultOverride = { ...pair };
        this.driver.applyModelToAll(pair.provider, pair.model);
        return { ok: true, text: `已切到 ${pair.provider}/${pair.model}（手动偏好模式；额度耗尽时仍会自动切到另一侧保底）。\n下回合起生效。/glm 切回 · /auto 恢复默认自动策略` };
      }
      // /glm：切回主模型并恢复自动
      this.mode = 'auto';
      this.driver.defaultOverride = null;
      this.driver.applyModelToAll(pair.provider, pair.model);
      return { ok: true, text: `已切回 ${pair.provider}/${pair.model}，自动切换已恢复。` };
    }
    if (target === 'auto') {
      this.mode = 'auto';
      this.#clearAllWatchers();
      this.#clearFallbackState();
      return { ok: true, text: '已恢复自动切换（当前模型保持不变；下次额度耗尽会自动切到另一侧）。' };
    }
    return { ok: false, text: '用法：/gpt · /glm · /auto' };
  }

  /** 当前切换状态（/status 用）。 */
  statusLine() {
    const backup = this.#backup();
    const primary = this.#primary();
    if (!backup || !primary) return '模型切换：未配置（fallback 关闭）';
    if (this.fallbackActive) {
      const t = this.takeoverModel ?? backup;
      const l = this.limitedModel ?? primary;
      return `模型切换：**额度耗尽已切换**（${t.provider}/${t.model} 接管，${l.provider}/${l.model} 限额；不自动切回，手动 /gpt /glm）`;
    }
    if (this.mode === 'manual') return `模型切换：**手动偏好**（额度安全网仍启用；/auto 恢复默认自动策略）`;
    return `模型切换：自动双向（任一侧额度耗尽 → 切另一侧续跑，不自动切回；默认 ${primary.provider}/${primary.model}）`;
  }

  // ------------------------------------------------------------- timer ----

  /** 到点：补发继续消息（用户若已接管/会话已不在，安静退出）。 */
  async #fire(sessionId) {
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
