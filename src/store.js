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
