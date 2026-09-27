/**
 * audit/store.js — AuditRun 持久化（§18 / v0.2 §18.2 / v0.3）。
 *
 * 目录布局：
 *   <root>/runs.json                          — run 索引
 *   <root>/runs/<runId>/manifest.json         — 冻结授权边界
 *   <root>/runs/<runId>/state.json            — 运行态（状态机快照）
 *   <root>/runs/<runId>/events.jsonl          — 审计流水（append-only）
 *
 * 规则：
 *  - 全部 JSON 落盘走 tmp+rename 原子写（沿用仓库 BindingStore 风格）；
 *  - 损坏 fail loud（StoreCorruptionError）：不猜、不清空、不静默重建；
 *  - events.jsonl 是幂等去重的唯一事实源（dedupeKey），reload 时全量重建 seen 集合；
 *  - 末行不完整（写一半 crash）容忍并截断；中间坏行 = 损坏；
 *  - 不持久化任何 credentials / browser tokens（G10，字段层面根本不存在）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AuditError, StoreCorruptionError } from './errors.js';

const REQUIRED_EVENT_FIELDS = ['runId', 'stage', 'iteration', 'headCommit', 'event', 'timestamp', 'elapsedMs', 'dedupeKey'];

export class AuditStore {
  /** runId -> Set<dedupeKey>（events.jsonl 是唯一事实源，本集合是内存缓存）。 */
  #seenKeys = new Map();

  /**
   * @param {string} rootDir audit 数据根目录（生产：$DSH_HOME/feishu/audit）
   * @param {{now?: () => number}} [opts]
   */
  constructor(rootDir, { now = Date.now } = {}) {
    this.root = rootDir;
    this.now = now;
  }

  #runsFile() { return path.join(this.root, 'runs.json'); }
  #runDir(runId) { return path.join(this.root, 'runs', runId); }
  #manifestFile(runId) { return path.join(this.#runDir(runId), 'manifest.json'); }
  #stateFile(runId) { return path.join(this.#runDir(runId), 'state.json'); }
  #eventsFile(runId) { return path.join(this.#runDir(runId), 'events.jsonl'); }

  /** 沿用仓库原子写风格：tmp + rename。 */
  #atomicWrite(file, text) {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  /** 清理残留 .tmp（未完成的原子写，主文件为准）。 */
  #sweepTmp(dir) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  // ---------- 索引 ----------

  /** @returns {Array<object>} runs.json 内容。损坏时 fail loud。 */
  listRuns() {
    const file = this.#runsFile();
    if (!fs.existsSync(file)) return [];
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new StoreCorruptionError(file, e.message);
    }
    if (!parsed || !Array.isArray(parsed.runs)) {
      throw new StoreCorruptionError(file, 'expected { runs: [...] }');
    }
    return parsed.runs;
  }

  #writeIndex(runs) {
    this.#atomicWrite(this.#runsFile(), `${JSON.stringify({ runs }, null, 2)}\n`);
  }

  updateIndex(runId, patch) {
    const runs = this.listRuns();
    const i = runs.findIndex((r) => r.runId === runId);
    const entry = { ...(i >= 0 ? runs[i] : { runId, createdAt: this.now() }), ...patch, updatedAt: this.now() };
    if (i >= 0) runs[i] = entry; else runs.push(entry);
    this.#writeIndex(runs);
    return entry;
  }

  // ---------- run 生命周期 ----------

  /** 创建 run：manifest + 初始 state 落盘。runId 重复 → AUDIT_RUN_EXISTS。 */
  createRun(manifest, initialState) {
    const dir = this.#runDir(manifest.runId);
    if (fs.existsSync(dir)) {
      throw new AuditError('AUDIT_RUN_EXISTS', `run directory already exists: ${dir}`);
    }
    this.#atomicWrite(this.#manifestFile(manifest.runId), `${JSON.stringify(manifest, null, 2)}\n`);
    this.#atomicWrite(this.#stateFile(manifest.runId), `${JSON.stringify(initialState, null, 2)}\n`);
    this.#seenKeys.set(manifest.runId, new Set());
    this.updateIndex(manifest.runId, {
      state: initialState.state,
      currentStage: manifest.currentStage,
      stopAfter: manifest.stopAfter,
      repo: manifest.repo,
      branch: manifest.branch,
    });
    return { manifest, state: initialState };
  }

  saveManifest(manifest) {
    this.#atomicWrite(this.#manifestFile(manifest.runId), `${JSON.stringify(manifest, null, 2)}\n`);
    this.updateIndex(manifest.runId, {
      currentStage: manifest.currentStage,
      stopAfter: manifest.stopAfter,
    });
  }

  saveState(state) {
    this.#atomicWrite(this.#stateFile(state.runId), `${JSON.stringify(state, null, 2)}\n`);
    this.updateIndex(state.runId, { state: state.state, currentStage: state.currentStage, lastVerdict: state.lastVerdict?.state ?? null });
  }

  // ---------- 事件 ----------

  /** 校验事件必填字段（v0.2 §18.2）。tokens 允许显式 null。 */
  static normalizeEvent(evt) {
    for (const f of REQUIRED_EVENT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(evt, f)) {
        throw new AuditError('AUDIT_EVENT_INVALID', `event missing field: ${f}`);
      }
    }
    if (typeof evt.event !== 'string' || evt.event.trim() === '') {
      throw new AuditError('AUDIT_EVENT_INVALID', 'event name must be a non-empty string');
    }
    if (typeof evt.dedupeKey !== 'string' || evt.dedupeKey === '') {
      throw new AuditError('AUDIT_EVENT_INVALID', 'dedupeKey must be a non-empty string');
    }
    return { ...evt };
  }

  /**
   * 追加事件（幂等）：dedupeKey 已见过 → {appended:false}，不写盘不报错。
   * dedupeKey 语义（G9）：runId+stage+iteration+headCommit+eventType。
   * seen 集合懒加载：重启后未 loadRun 就 append 时从 events.jsonl 重建（幂等不依赖调用顺序）。
   */
  appendEvent(evt) {
    const e = AuditStore.normalizeEvent(evt);
    if (!this.#seenKeys.has(e.runId)) this.#rebuildSeen(e.runId);
    const seen = this.#seenKeys.get(e.runId);
    if (seen.has(e.dedupeKey)) return { appended: false };
    fs.appendFileSync(this.#eventsFile(e.runId), `${JSON.stringify(e)}\n`);
    seen.add(e.dedupeKey);
    this.updateIndex(e.runId, { lastEvent: e.event, updatedAt: this.now() });
    return { appended: true };
  }

  /** 从 events.jsonl 重建某 run 的 seen 集合（文件不存在则空集合）。 */
  #rebuildSeen(runId) {
    const { events } = this.#readEvents(runId);
    this.#seenKeys.set(runId, new Set(events.map((e) => e.dedupeKey)));
  }

  // ---------- 读取 / 恢复 ----------

  /**
   * 加载 run（§22 崩溃恢复路径）。
   * @returns {{manifest: object, state: object, events: object[], seenKeys: Set<string>,
   *            eventsTruncated: boolean}|null} 目录不存在 → null
   * @throws {StoreCorruptionError} manifest/state 损坏、events 中间行损坏
   */
  loadRun(runId) {
    const dir = this.#runDir(runId);
    if (!fs.existsSync(dir)) return null;
    this.#sweepTmp(dir);

    let manifest, state;
    try {
      manifest = JSON.parse(fs.readFileSync(this.#manifestFile(runId), 'utf8'));
    } catch (e) {
      throw new StoreCorruptionError(this.#manifestFile(runId), e.message);
    }
    if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new StoreCorruptionError(this.#manifestFile(runId), 'manifest is not an object');
    }
    try {
      state = JSON.parse(fs.readFileSync(this.#stateFile(runId), 'utf8'));
    } catch (e) {
      throw new StoreCorruptionError(this.#stateFile(runId), e.message);
    }
    if (state == null || typeof state !== 'object' || Array.isArray(state)) {
      throw new StoreCorruptionError(this.#stateFile(runId), 'state is not an object');
    }

    const { events, truncated } = this.#readEvents(runId);
    const seenKeys = new Set(events.map((e) => e.dedupeKey));
    this.#seenKeys.set(runId, seenKeys);
    return { manifest, state, events, seenKeys, eventsTruncated: truncated };
  }

  #readEvents(runId) {
    const file = this.#eventsFile(runId);
    if (!fs.existsSync(file)) return { events: [], truncated: false };
    const raw = fs.readFileSync(file, 'utf8');
    if (raw === '') return { events: [], truncated: false };
    const lines = raw.split('\n');
    // append 写入永远以 \n 结尾；文件不以 \n 结尾说明最后一行写了一半（crash 窗口）。
    const trailingPartial = !raw.endsWith('\n');
    if (trailingPartial) lines.pop();
    const events = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln === '') continue;
      let obj;
      try {
        obj = JSON.parse(ln);
      } catch {
        throw new StoreCorruptionError(file, `corrupt event line ${i + 1} (not the trailing partial line)`);
      }
      events.push(obj);
    }
    return { events, truncated: trailingPartial };
  }
}
