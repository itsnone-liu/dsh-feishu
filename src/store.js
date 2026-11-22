/**
 * chat_id → session binding store. Plain JSON, atomic writes.
 * The Feishu side owns zero conversation memory — this table is pure routing:
 * which durable DSH session (and workspace cwd) a chat is attached to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export class BindingStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'bindings.json');
    this.data = new Map();
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [k, v] of Object.entries(parsed ?? {})) this.data.set(k, v);
      }
    } catch (e) {
      log.warn(`bindings unreadable (${e.message}) — starting empty; fix or remove ${this.file}`);
      this.data = new Map();
    }
  }

  get(chatId) {
    return this.data.get(chatId) ?? null;
  }

  /** 所有聊天当前绑定的 sessionId（去重；方案C清扫保护名单用）。 */
  sessionIds() {
    return [...new Set([...this.data.values()].map((b) => b.sessionId).filter(Boolean))];
  }

  /** 全部绑定条目 [chatId, binding]，供跨聊天解绑检查（2026-11-22 resume 防串台）。 */
  all() {
    return [...this.data.entries()];
  }

  /** Upsert fields on a chat binding. */
  update(chatId, patch) {
    const cur = this.data.get(chatId) ?? { sessionId: null, cwd: null, createdAt: Date.now() };
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.data.set(chatId, next);
    this.#flush();
    return next;
  }

  #flush() {
    const obj = Object.fromEntries(this.data);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** sessionId → 会话名（2026-11-21 P1/P2：/sessions 列表显示名）。
 *  显式 /name 优先；未命名的新会话由 router 捕获首条用户消息自动命名。
 *  sidecar 独立于 dsh 转录（zstd 多帧桥侧不可解），桥重启不丢。 */
export class TitleStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'session-titles.json');
    this.data = new Map();
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [k, v] of Object.entries(parsed ?? {})) this.data.set(k, v);
      }
    } catch (e) {
      log.warn(`session-titles unreadable (${e.message}) — starting empty`);
    }
  }

  get(sessionId) {
    return this.data.get(sessionId)?.title ?? null;
  }

  /** 按会话名找会话（2026-11-22 /resume 按名匹配）：精确 > 前缀 > 包含，大小写不敏感。返回 [{ id, title }]。 */
  findByTitle(q) {
    const query = String(q ?? '').trim().toLowerCase();
    if (!query) return [];
    const entries = [...this.data.entries()]
      .filter(([, v]) => v?.title)
      .map(([id, v]) => ({ id, title: String(v.title) }));
    const exact = entries.filter((e) => e.title.toLowerCase() === query);
    if (exact.length) return exact;
    const prefix = entries.filter((e) => e.title.toLowerCase().startsWith(query));
    if (prefix.length) return prefix;
    return entries.filter((e) => e.title.toLowerCase().includes(query));
  }

  /** 显式命名过的 sessionId 列表（方案C清扫保护名单用）。 */
  explicitIds() {
    return [...this.data.entries()].filter(([, v]) => v?.explicit).map(([k]) => k);
  }

  /** 显式命名（/name）：覆盖一切。 */
  set(sessionId, title) {
    this.data.set(sessionId, { title: String(title).slice(0, 40), explicit: true, at: Date.now() });
    this.#flush();
  }

  /** 自动命名：仅当该会话尚无任何名字（首条用户消息截断）。 */
  setAuto(sessionId, text) {
    if (this.data.has(sessionId)) return false;
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!t) return false;
    this.data.set(sessionId, { title: t, explicit: false, at: Date.now() });
    this.#flush();
    return true;
  }

  #flush() {
    const obj = Object.fromEntries(this.data);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
