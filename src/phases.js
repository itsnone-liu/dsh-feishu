/**
 * PhaseManager — /plan /exec /review 相位工作流（2026-09-20 方案）。
 *
 * 命令驱动的阶段切换，把「网页额度」（ChatGPT Web，经 codex-chatgpt-web
 * daemon，provider=chatgpt-web）用于规划与审计，把「Codex 额度」（exec 侧，
 * 含 GLM fallback 安全网）用于写码：
 *
 *   /plan [档位]   → 切网页额度 + 注入规划提示（只出方案不写码）
 *   /exec          → 落盘上一相位产物 → 切回 exec 常态模型 + 记 startCommit
 *                    + 注入执行提示（读产物文件开工）
 *   /review [档位|commit] → 收集 git diff（startCommit→工作树）打包注入
 *                    → 切网页额度 + 注入审计提示（问题清单落盘）
 *
 * 同会话切模型不动历史（driver.setModel 只改 selection），相位间讨论上下文
 * 天然延续；产物另落盘 cwd/.dsh/phases/*.md 作跨会话证据（webcodex 思路）。
 *
 * 降级（用户定调 2026-09-20）：plan/review 相位中网页通道故障（daemon 挂/
 * 掉登录/网页超限）→ 自动切回 exec 常态模型**继续当前相位工作**（相位提示
 * 仍在会话历史里），并发卡告知 + 启动轻量探针（GET /v1/models）；探针恢复
 * 只提示不自动切回（与额度 fallback「不回切」定调一致，手动 /plan /review）。
 *
 * 与 AutoContinue 的分工：chatgpt-web 不在 fallbackPrimary/Backup 对里，
 * autocontinue 对其错误只会安排等待 watcher —— 因此网页侧错误必须由本模块
 * 先认领（autocontinue.onEvent 开头调 phases.onTurnError，返回 true 即跳过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildInfoCard } from './cards.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

/** 网页推理档位（与 codex-chatgpt-web 的模型 slug 一致）。 */
const WEB_EFFORTS = ['light', 'medium', 'high', 'extra-high', 'pro'];

/** 从会话事件提取 assistant 文本（plan/review 产物落盘用）。
 *  events: session.events 数组；fromIdx: 起始索引（相位进入时的快照长度）。 */
export function extractAssistantText(events, fromIdx = 0) {
  const out = [];
  for (let i = Math.max(0, fromIdx); i < events.length; i++) {
    const ev = events[i];
    if (ev?.type !== 'assistant/message') continue;
    const parts = ev.data?.parts ?? [];
    for (const p of parts) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        out.push(p.text.trim());
      }
    }
  }
  return out.join('\n\n');
}

/** 解析相位命令参数 → { effort } | { base } | {}。
 *  档位白名单命中 → effort（chatgpt-web/<档>）；否则视为 commit 起点（稍后 rev-parse 验证）。 */
export function parsePhaseArg(arg) {
  const raw = String(arg ?? '').trim();
  if (!raw) return {};
  if (WEB_EFFORTS.includes(raw)) return { effort: `chatgpt-web/${raw}` };
  if (raw.startsWith('chatgpt-web/')) return { effort: raw };  // 完整 slug 直接用
  return { base: raw };
}

const PLAN_NOTE = [
  '[相位切换·规划模式] 本回合起已切换到网页额度模型（不消耗 Codex 额度）。',
  '你现在是项目的方案规划者：与用户讨论需求、澄清边界、权衡取舍。',
  '规则：不要写代码、不要修改文件、不要执行变更类工具。',
  '讨论成熟后，输出一份结构化方案文档（目标 / 设计决策 / 实施步骤 / 风险 / 验收标准）。',
  '用户发 /exec 时桥会自动把你的方案存档为 .dsh/phases/plan-*.md 并切回执行模型开工。',
].join('\n');

function execNote(artifact, pair, sha) {
  return [
    `[相位切换·执行模式] 已切回 ${pair.provider}/${pair.model}。`,
    artifact
      ? `上一阶段产物已存档：${artifact.path}（${artifact.kind === 'plan' ? '规划方案' : '审计报告'}）。请先读取该文件，按其中的方案/修改建议执行。`
      : '（本阶段无存档产物——直接按会话中已达成的共识执行。）',
    sha ? `已记录执行起点 commit \`${sha}\`；完成后用户将 /review 审计自该点起的全部变更。` : '',
    '执行中如额度窗口耗尽，桥会自动切换到另一侧额度模型续跑（原有安全网，不受相位影响）。',
  ].filter(Boolean).join('\n');
}

function reviewNote(scope, stats, truncated) {
  return [
    '[相位切换·审计模式] 本回合起已切换到网页额度模型（不消耗 Codex 额度）。',
    `你是代码审计者。审计范围：${scope}。变更统计：${stats}`,
    '逐项检查：与方案/需求的偏差、逻辑错误、边界条件、错误处理、安全隐患、明显坏味道。',
    '输出格式：编号问题清单（严重度 P0/P1/P2 · 文件:位置 · 问题 · 修改建议），最后给一行总结论（可合并 / 需修改）。',
    '用户发 /exec 时桥会自动把报告存档为 .dsh/phases/review-*.md 并切回执行模型修复。',
    truncated ? `\n注意：以下内容超出注入预算被截断${truncated}` : '',
    '',
    '===== 变更内容（git diff + 变更文件全文）=====',
  ].filter(Boolean).join('\n');
}

export class PhaseManager {
  constructor({ config, driver, transport, autoContinue = null }) {
    this.config = config;
    this.driver = driver;
    this.transport = transport;
    this.autoContinue = autoContinue;
    /** chatId → 相位状态 */
    this.phases = new Map();
  }

  /** 配置是否启用（phaseWeb !== false 且 provider 名已配）。 */
  get enabled() {
    return this.config.phaseWeb !== false && !!this.config.phaseWebProvider;
  }

  #state(chatId) {
    let st = this.phases.get(chatId);
    if (!st) {
      st = { phase: 'exec', execPair: null, startCommit: null, markIdx: 0, degraded: false, probeTimer: null, lastWebPair: null };
      this.phases.set(chatId, st);
    }
    return st;
  }

  statusLine(chatId) {
    if (!this.enabled) return null;
    const st = this.phases.get(chatId);
    if (!st || st.phase === 'exec') {
      return st?.startCommit ? `相位：**执行**（起点 \`${st.startCommit.slice(0, 8)}\`，/review 审计自该点变更）` : null;
    }
    const label = st.phase === 'plan' ? '规划' : '审计';
    const deg = st.degraded ? '（⚠️ 网页通道降级中，当前跑在 Codex 额度侧）' : '（网页额度）';
    return `相位：**${label}**${deg}${st.startCommit ? ` · 起点 \`${st.startCommit.slice(0, 8)}\`` : ''}`;
  }

  // ------------------------------------------------------------- commands --

  /** 命令入口（Commands.cmdPhase 调用；agent/cwd 已解析）。返回 { ok, text }。 */
  async handle(chatId, agent, cwd, phase, arg) {
    if (!this.enabled) return { ok: false, text: '网页额度相位未启用（config phaseWeb）或 provider 未配置。' };
    if (phase === 'plan') return await this.#enterPlan(chatId, agent, cwd, arg);
    if (phase === 'exec') return await this.#enterExec(chatId, agent, cwd);
    if (phase === 'review') return await this.#enterReview(chatId, agent, cwd, arg);
    return { ok: false, text: `未知相位 ${phase}` };
  }

  async #enterPlan(chatId, agent, cwd, arg) {
    const st = this.#state(chatId);
    const { effort } = parsePhaseArg(arg);
    // 从 review 直接回 plan：先把审计报告落盘（不丢产物）
    await this.#archiveIfNeeded(chatId, agent, cwd);

    const webModel = effort || this.config.phaseWebModel;
    const cur = this.driver.currentModel(agent);
    st.execPair = cur ? { ...cur } : null;   // 快照：/exec 的恢复目标
    st.phase = 'plan';
    st.degraded = false;
    this.#stopProbe(chatId);
    st.markIdx = agent.session?.events?.length ?? 0;

    this.driver.setModel(agent, this.config.phaseWebProvider, webModel);
    this.driver.submit(agent, PLAN_NOTE + await this.#projectContext(cwd));
    log.info(`phase plan: chat=${chatId} -> ${this.config.phaseWebProvider}/${webModel} (from ${st.execPair ? `${st.execPair.provider}/${st.execPair.model}` : '?'})`);
    return { ok: true, text: `已进入**规划模式**：模型 → \`${this.config.phaseWebProvider}/${webModel}\`（网页额度），规划提示已注入。\n讨论方案（不会写码）；成熟后发 \`/exec\` 开工 —— 方案会自动存档并切回 ${st.execPair ? `${st.execPair.provider}/${st.execPair.model}` : '执行模型'}。` };
  }

  async #enterExec(chatId, agent, cwd) {
    const st = this.#state(chatId);
    const wasActive = st.phase === 'plan' || st.phase === 'review';
    const kind = wasActive ? st.phase : null;

    // ① 落盘上一相位产物（plan 方案 / review 报告）
    const artifact = wasActive ? await this.#archive(chatId, agent, cwd, kind) : null;

    // ② 记录执行起点
    let sha = null;
    try {
      const r = await git(cwd, ['rev-parse', 'HEAD']);
      sha = r.trim();
    } catch (e) {
      log.warn(`phase exec: rev-parse failed in ${cwd}: ${e.message}`);
    }
    st.startCommit = sha;
    st.phase = 'exec';
    st.degraded = false;
    this.#stopProbe(chatId);

    // ③ 切回 exec 常态模型（进入 plan 前的快照；降级场景 #degrade 已切过，
    //    再 set 同一模型幂等无副作用，统一处理）
    const target = st.execPair;
    if (target) this.driver.setModel(agent, target.provider, target.model);
    this.driver.submit(agent, execNote(artifact, target ?? { provider: '(当前)', model: '(模型)' }, sha));
    log.info(`phase exec: chat=${chatId} -> ${target ? `${target.provider}/${target.model}` : 'unchanged'} start=${sha ? sha.slice(0, 8) : 'n/a'} artifact=${artifact ? path.basename(artifact.path) : 'none'}`);
    return {
      ok: true,
      text: [
        '已进入**执行模式**。',
        artifact ? `📄 ${kind === 'plan' ? '方案' : '审计报告'}已存档：\`${artifact.path}\`` : '（无存档产物）',
        sha ? `📍 执行起点 \`${sha.slice(0, 8)}\`` : '⚠️ 工作区不是 git 仓库，/review 将不可用',
        target ? `模型 → \`${target.provider}/${target.model}\`（额度安全网照常）` : '',
        '完成后发 `/review` 审计本轮变更。',
      ].filter(Boolean).join('\n'),
    };
  }

  async #enterReview(chatId, agent, cwd, arg) {
    const st = this.#state(chatId);
    const parsed = parsePhaseArg(arg);
    const webModel = parsed.effort || this.config.phaseWebModel;

    const base = parsed.base || st.startCommit;
    if (!base) {
      return { ok: false, text: '还没有审计起点：先 `/exec` 记录起点 commit，或用 `/review <commit>` 指定（如 `/review v1.2` / `/review HEAD~3` / `/review main`）。' };
    }
    // 验证 commit 可解析（防误输，也拿到规范 sha）
    let baseSha;
    try {
      baseSha = (await git(cwd, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
    } catch (e) {
      return { ok: false, text: `审计起点 \`${base}\` 无法解析：${String(e.message).split('\n')[0]}\n可用 /exec 重记起点，或检查 commit/分支/标签名。` };
    }

    // 若在 plan 相位，先把方案落盘
    if (st.phase === 'plan') await this.#archive(chatId, agent, cwd, 'plan');

    // 收集 diff（预算打包）
    const pack = await collectReviewPack(cwd, baseSha, {
      budgetChars: this.config.phaseReviewBudgetChars ?? 150_000,
      fileMaxChars: this.config.phaseReviewFileMaxChars ?? 60_000,
    });
    if (pack.error) return { ok: false, text: `收集变更失败：${pack.error}` };
    if (pack.empty) return { ok: false, text: `自 \`${baseSha.slice(0, 8)}\` 以来没有任何变更（diff 为空）。先干活再 /review，或用 /review <commit> 换起点。` };

    const cur = this.driver.currentModel(agent);
    st.execPair = st.execPair ?? (cur ? { ...cur } : null);
    st.phase = 'review';
    st.degraded = false;
    this.#stopProbe(chatId);
    st.markIdx = agent.session?.events?.length ?? 0;

    this.driver.setModel(agent, this.config.phaseWebProvider, webModel);
    this.driver.submit(agent, reviewNote(`\`${baseSha.slice(0, 8)}\` → 当前工作树${parsed.base ? '（手动指定起点）' : '（本阶段 /exec 起点）'}`, pack.stats, pack.truncatedList) + '\n' + pack.body);
    log.info(`phase review: chat=${chatId} -> ${this.config.phaseWebProvider}/${webModel} base=${baseSha.slice(0, 8)} ${pack.stats}`);
    return {
      ok: true,
      text: [
        `已进入**审计模式**：模型 → \`${this.config.phaseWebProvider}/${webModel}\`（网页额度）。`,
        `📊 ${pack.stats}${pack.truncatedCount ? `\n⚠️ ${pack.truncatedCount} 项超预算被截断（审计提示里已注明，可讨论中点名补发）` : ''}`,
        '审计完成后发 `/exec` 存档报告并切回执行模型修复。',
      ].join('\n'),
    };
  }

  // ------------------------------------------------------------ artifacts --

  /** 规划阶段的轻量项目上下文：目录树（git ls-files）+ README 头部。
   *  网页额度模型没有本地工具，不看目录就是盲人摸象；这个注入很便宜
   *  （默认 ≤8k 字符）却显著提升规划质量。失败安静降级为空。 */
  async #projectContext(cwd) {
    try {
      const budget = this.config.phasePlanContextChars ?? 8_000;
      const chunks = ['\n\n===== 项目上下文（供规划参考）====='];
      let tracked = '';
      try {
        tracked = (await git(cwd, ['ls-files'])).split('\n').filter(Boolean);
      } catch { /* 非 git 仓库 */ }
      if (tracked.length) {
        const tree = tracked.slice(0, 200).join('\n') + (tracked.length > 200 ? `\n…（共 ${tracked.length} 个文件，截断）` : '');
        chunks.push(`目录（git 跟踪文件）：\n${tree}`);
      } else {
        try {
          const { readdirSync } = fs;
          const top = readdirSync(cwd).filter((n) => !n.startsWith('.')).slice(0, 60);
          chunks.push(`顶层目录：\n${top.join('\n')}`);
        } catch {}
      }
      for (const name of ['README.md', 'README.zh-CN.md', 'README.txt', 'PLAN.md', 'STATUS.md']) {
        const p = path.join(cwd, name);
        if (!fs.existsSync(p)) continue;
        const head = fs.readFileSync(p, 'utf8').slice(0, 3_000);
        chunks.push(`\n${name}（头部）：\n${head}`);
        break;   // 只带一份最匹配的
      }
      const text = chunks.join('\n');
      return text.length > budget ? text.slice(0, budget) + '\n…（截断）' : text;
    } catch {
      return '';
    }
  }

  /** 若当前在 plan/review 相位且有产出 → 落盘（enterPlan 转场用）。 */
  async #archiveIfNeeded(chatId, agent, cwd) {
    const st = this.phases.get(chatId);
    if (!st || (st.phase !== 'plan' && st.phase !== 'review')) return null;
    return await this.#archive(chatId, agent, cwd, st.phase);
  }

  /** 提取相位期间的 assistant 文本并写入 cwd/.dsh/phases/<kind>-<ts>.md。 */
  async #archive(chatId, agent, cwd, kind) {
    const st = this.#state(chatId);
    try {
      const events = agent.session?.events ?? [];
      const text = extractAssistantText(events, st.markIdx);
      if (!text) return null;
      const dir = path.join(cwd, '.dsh', 'phases');
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const file = path.join(dir, `${kind}-${ts}.md`);
      const header = [
        `<!-- dsh-feishu phase artifact -->`,
        `- kind: ${kind}`,
        `- chat: ${chatId}`,
        `- archivedAt: ${new Date().toISOString()}`,
        `- startCommit: ${st.startCommit ?? ''}`,
        '',
        '',
      ].join('\n');
      fs.writeFileSync(file, header + text + '\n', 'utf8');
      st.markIdx = events.length;   // 已存档的部分不再重复存
      log.info(`phase artifact archived: ${file} (${text.length} chars)`);
      return { path: file, kind };
    } catch (e) {
      log.error(`phase archive failed for ${chatId}: ${e.stack ?? e}`);
      return null;
    }
  }

  // -------------------------------------------------------------- degrade --

  /** autocontinue.onEvent 开头调用：认领网页侧错误并降级。返回 true = 已处理。
   *  触发条件：turn/end error + 本聊天在 plan/review 相位 + 当前模型在网页
   *  provider 上 + 错误像通道故障（连接类/鉴权类/限流额度类一律降级——
   *  网页侧任何持续故障都不该卡死讨论与审计，用户定调 2026-09-20）。 */
  onTurnError(session, event) {
    if (!this.enabled) return false;
    if (event?.type !== 'turn/end') return false;
    if (event.data?.reason?.kind !== 'error') return false;
    const sessionId = session?.id;
    if (!sessionId) return false;
    const chatId = this.autoContinue?.renderer?.chatOf(sessionId);
    if (!chatId) return false;
    const st = this.phases.get(chatId);
    if (!st || (st.phase !== 'plan' && st.phase !== 'review')) return false;
    // 已降级：模型已被切回 exec 侧（cur.provider 不再是 web），把后续同类
    // 错误吞掉（探针在跑）；enterPlan/enterReview 会重置 degraded 重新认领。
    if (st.degraded) return true;
    const entry = this.driver.live.get(sessionId);
    const cur = this.driver.currentModel(entry?.agent);
    if (!cur || cur.provider !== this.config.phaseWebProvider) return false;
    this.#degrade(chatId, sessionId, st, [event.data.reason.error?.code, event.data.reason.error?.message].filter(Boolean).join(': '));
    return true;
  }

  #degrade(chatId, sessionId, st, message) {
    st.degraded = true;
    const target = st.execPair;
    const entry = this.driver.live.get(sessionId);
    const label = st.phase === 'plan' ? '规划' : '审计';
    if (target && entry?.agent) {
      this.driver.setModel(entry.agent, target.provider, target.model);
      // 被打断的回合换模型续跑（与 fallback 相同的推迟提交模式，防重入锁）
      const tryResume = (left) => {
        if (!st.degraded) return;
        try {
          this.driver.submit(entry.agent, `[通道切换] 网页额度通道故障，已切回 ${target.provider}/${target.model} 继续${label}。请基于会话中已有的讨论继续当前任务。`);
        } catch {
          if (left > 0) setTimeout(() => tryResume(left - 1), 250);
        }
      };
      setTimeout(() => tryResume(8), 0);
    }
    this.#send(chatId, buildInfoCard('⚠️ 网页通道故障，已降级继续', [
      `网页额度通道（${this.config.phaseWebProvider}）回合出错，**${label}工作不中断**：已切回 \`${target ? `${target.provider}/${target.model}` : '原模型'}\`（Codex 额度侧）继续。`,
      '',
      '桥会每分钟探测网页通道，恢复后提示你（不自动切回）；届时 `/plan` 或 `/review` 即可重新使用网页额度。',
      '',
      `\`\`\`\n${String(message).slice(0, 300)}\n\`\`\``,
    ].join('\n'), { template: 'orange' }));
    log.warn(`phase degraded: chat=${chatId} phase=${st.phase} -> ${target ? `${target.provider}/${target.model}` : '?'} (${String(message).slice(0, 120)})`);
    this.#startProbe(chatId);
  }

  // ---------------------------------------------------------------- probe --

  #startProbe(chatId) {
    const st = this.#state(chatId);
    this.#stopProbe(chatId);
    if (!this.config.phaseWebProbeUrl) return;
    const period = Math.max(15_000, this.config.phaseWebProbeMs ?? 60_000);
    st.probeTimer = setInterval(async () => {
      const s = this.phases.get(chatId);
      if (!s?.degraded) { this.#stopProbe(chatId); return; }
      const ok = await this.#probeOnce();
      if (ok) {
        s.degraded = false;
        this.#stopProbe(chatId);
        this.#send(chatId, buildInfoCard('✅ 网页通道已恢复', [
          `网页额度通道（${this.config.phaseWebProvider}）探测恢复正常。`,
          '', `需要回到网页额度时发 \`/plan\`（规划）或 \`/review\`（审计）；当前继续留在 Codex 额度侧（不自动切回）。`,
        ].join('\n'), { template: 'green' }));
        log.info(`phase probe: chat=${chatId} web channel recovered`);
      }
    }, period);
    if (st.probeTimer.unref) st.probeTimer.unref();
  }

  #stopProbe(chatId) {
    const st = this.phases.get(chatId);
    if (st?.probeTimer) { clearInterval(st.probeTimer); st.probeTimer = null; }
  }

  /** GET probeUrl + Bearer；2xx 即恢复。失败安静返回 false。 */
  #probeOnce() {
    const url = this.config.phaseWebProbeUrl;
    const token = process.env[this.config.phaseWebProbeAuthEnv ?? ''] ?? '';
    return new Promise((resolve) => {
      try {
        const req = http.get(url, { timeout: 5000, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
          res.resume();
          resolve(!!res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
  }

  dispose() {
    for (const chatId of [...this.phases.keys()]) this.#stopProbe(chatId);
  }

  #send(chatId, card) {
    this.transport.sendCard(chatId, card).catch((e) => log.warn(`phase card: ${e.message}`));
  }
}

// ----------------------------------------------------------------- helpers --

/** git execFile 封装（数组参数，无 shell 注入面）。 */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  return stdout;
}

/** 收集审计注入包：status + diff + 变更文件全文，预算内截断。
 *  返回 { body, stats, truncatedList, truncatedCount } | { error } | { empty } */
export async function collectReviewPack(cwd, baseSha, { budgetChars = 150_000, fileMaxChars = 60_000 } = {}) {
  try {
    const status = (await git(cwd, ['status', '--porcelain'])).trim() || '(工作树干净)';
    let diff;
    try {
      diff = await git(cwd, ['diff', '--no-color', baseSha]);
    } catch (e) {
      return { error: String(e.message).split('\n')[0] };
    }
    if (!diff.trim() && status === '(工作树干净)') return { empty: true };

    const parts = [`## git status\n\`\`\`\n${status}\n\`\`\`\n`, `## git diff ${baseSha.slice(0, 8)} → 工作树\n\`\`\`diff\n${diff}\n\`\`\`\n`];

    // 变更文件 = tracked 差异 ∪ 未跟踪新文件（git diff 不含 untracked，
    // 而新文件恰是审计重点——全文块覆盖内容，diff 段标注为新增）
    const tracked = (await git(cwd, ['diff', '--name-only', baseSha])).split('\n').map((s) => s.trim()).filter(Boolean);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').map((s) => s.trim()).filter(Boolean);
    const names = [...tracked, ...untracked.filter((n) => !tracked.includes(n))];
    if (untracked.length) {
      parts.push(`## 新增文件（未跟踪，不在上方 diff 中）\n${untracked.map((n) => `- ${n}`).join('\n')}\n`);
    }
    let used = parts.join('').length;
    const skipped = [];

    // 变更文件全文（有剩余预算才装）
    for (const name of names.slice(0, 60)) {
      const abs = path.resolve(cwd, name);
      if (!abs.startsWith(path.resolve(cwd) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      if (fs.statSync(abs).size > fileMaxChars * 4) { skipped.push(`${name}（过大）`); continue; }
      let content;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (content.length > fileMaxChars) { content = content.slice(0, fileMaxChars) + `\n…（截断，全文 ${content.length} 字符）`; }
      const block = `## 文件 ${name}\n\`\`\`\n${content}\n\`\`\`\n`;
      if (used + block.length > budgetChars) { skipped.push(name); continue; }
      parts.push(block);
      used += block.length;
    }
    // diff 本身超预算 → 截头保留（尾部统计信息最有用）
    const stats = `${names.length} 个文件变更（自 ${baseSha.slice(0, 8)}）`;
    return {
      body: parts.join(''),
      stats,
      truncatedList: skipped.length ? `：${skipped.join('、')}` : '',
      truncatedCount: skipped.length,
    };
  } catch (e) {
    return { error: String(e.message).split('\n')[0] };
  }
}
