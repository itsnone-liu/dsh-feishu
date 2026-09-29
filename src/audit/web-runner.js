/**
 * audit/web-runner.js — A5 真实 Web 审核器（reviewer 侧外部 I/O 适配器）。
 *
 * 冻结边界（A4 FINAL FROZEN @ 711eb29）：本文件只做「网页模型输出 → 现有 reviewer
 * 接口」的格式转换与传输分类；不改 AuditRun 状态机、packet 协议、verdict 语义、
 * retry 规则、round dedupe、自动触发条件、per-run 串行化、stop/pause 并发、
 * stage 推进。identity fail-closed 仍由内核 auditorVerdict() 的 validateIdentity
 * 单点承担。
 *
 * 传输链（本机真实网页额度池，2026-09-27 勘察确认）：
 *   WebAuditRunner → headroom proxy (:8787, Responses API) → ChatGPT Web API
 *   （可选经 content-fix-proxy :18787 转发；对 string content 的 input 是纯透传。）
 * 鉴权：~/.codex/auth.json 的 ChatGPT OAuth access_token（codex 自行刷新）。
 *
 * 错误分类（决定 A4 冻结语义下的落点）：
 *   - 401/403 / 无 token        → AUDIT_WEB_LOGIN_EXPIRED   （infrastructure，round latch）
 *   - 429                        → AUDIT_WEB_QUOTA           （infrastructure，round latch）
 *   - 网络失败/超时（重试耗尽）   → AUDIT_WEB_UNREACHABLE     （infrastructure，round latch）
 *   - 5xx（重试耗尽）             → AUDIT_WEB_UPSTREAM_ERROR  （infrastructure，round latch）
 *   - 其余 4xx                   → AUDIT_WEB_REQUEST_REJECTED（infrastructure，round latch）
 *   - 模型无文本输出              → AUDIT_VERDICT_MISSING     （lifecycle verdictMissing 重试）
 *   - 文本不符合冻结协议          → AUDIT_VERDICT_MALFORMED   （lifecycle verdictMissing 重试）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runExecutorTests } from './exec-test.js';
import { parseAuditorVerdict, buildHandoff } from './protocol.js';
import { ProtocolParseError } from './errors.js';

const SYSTEM_PROMPT = [
  'You are the independent auditor in the DSH audit pipeline.',
  'You review the executor\'s committed work strictly against the frozen stage requirements,',
  'using only facts from the VERIFIED-GIT-EVIDENCE bundle appended to the task:',
  'it was machine-generated from git objects at BASE_COMMIT..TARGET_COMMIT after the bridge',
  'verified the remote branch tip equals TARGET_COMMIT.',
  'Never trust the executor\'s claims about its own work; any claim not grounded in the',
  'evidence bundle must be ignored or flagged.',
  '',
  'Output contract (MANDATORY):',
  '- End your reply with exactly ONE [DSH-AUDIT] verdict block as the very last thing in your message.',
  '- Your reply must contain exactly ONE line reading "[DSH-AUDIT]" — if you discuss or reference',
  '  the verdict format, describe it in words; never reproduce its marker line outside the final block.',
  '- Use the frozen line format below; section content may be written in Simplified Chinese.',
  '- STATE must be exactly one of APPROVE, REVISE, NEED_USER.',
  '- Echo RUN_ID / HOST_ID / STAGE / ITERATION exactly as given in the task, on their own header lines.',
  '- REVISE must include REASON and P0 (and P1 when present) sections.',
  '- NEED_USER must include a QUESTION section.',
  '- APPROVE must include SUMMARY and EVIDENCE sections.',
  '- Replace every placeholder; never leave template punctuation like "|" in STATE.',
].join('\n');

function verdictTemplate(p) {
  return [
    'VERDICT FORMAT — copy this structure with real values (omit sections you do not use):',
    '[DSH-AUDIT]',
    'STATE: APPROVE   (or REVISE / NEED_USER — exactly one)',
    `RUN_ID: ${p.runId}`,
    `HOST_ID: ${p.hostId}`,
    `STAGE: ${p.stage}`,
    `ITERATION: ${p.iteration}`,
    'SUMMARY:',
    '- one line per finding',
    'EVIDENCE:',
    '- file/commit-level facts you verified',
    'RESIDUAL_RISKS:',
    '- risks you accept / flag',
    'P0:',
    '- blocking problems (REVISE only)',
    'P1:',
    '- non-blocking problems (REVISE only)',
    'TESTS_REQUIRED:',
    '- tests the executor must add (REVISE only)',
    'REASON:',
    '- why you cannot approve (REVISE only)',
    'QUESTION:',
    '- what you need from the human (NEED_USER only)',
  ].join('\n');
}

/** 从 Responses / Chat-Completions 两种应答形状提取纯文本。 */
export function extractReviewerText(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text;
  if (Array.isArray(json.output)) {
    const parts = [];
    for (const item of json.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string') parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join('\n');
  }
  const ch = json.choices?.[0]?.message?.content;
  if (typeof ch === 'string' && ch.trim()) return ch;
  if (Array.isArray(ch)) {
    const t = ch.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
    if (t.trim()) return t;
  }
  if (Array.isArray(json.content)) {
    const t = json.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
    if (t.trim()) return t;
  }
  return null;
}

async function defaultTransport({ url, method, headers, body, timeoutMs }) {
  const res = await fetch(url, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // SSE consumer 不伪造 HTTP 状态：真实 res.status 原样上抛，
    // 429/5xx 走既有分类，200+response.failed 走 streamError 分类（A5.3）。
    const sse = await consumeSseStream(res.body);
    return { status: res.status, json: sse.json, outputText: sse.outputText, streamError: sse.streamError };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 应答按文本处理 */ }
  // 非流式应答：模型文本在 json 内，由 extractReviewerText 提取；outputText 留空。
  return { status: res.status, json, outputText: null };
}

/**
 * 消费 Responses SSE 流（headroom :8787 强制 stream=true，2026-09-27 live 实测）。
 * 注意：headroom 的 response.completed 事件里 output 数组为空，模型文本只存在于
 * output_text.delta 事件 —— 因此累积 delta 是唯一可靠的文本来源。
 * 兼容：response.output_text.delta / chat.completions delta 形状。
 * streamError：response.failed / error 事件的结构化提取 —— HTTP 200 下流内失败
 * 也必须归类为 infrastructure error，绝不降级成 verdictMissing 自动重试（A4 冻结）。
 */
export async function consumeSseStream(stream) {
  let finalJson = null;
  let streamError = null;
  const deltas = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; }
    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') deltas.push(evt.delta);
    else if (evt.type === 'response.completed' && evt.response) finalJson = evt.response;
    else if (evt.type === 'response.failed' || evt.type === 'error') {
      finalJson = evt;
      const err = evt.error ?? evt.response?.error ?? {};
      streamError = {
        type: evt.type,
        code: err.code ?? evt.code ?? null,
        status: err.status ?? evt.status ?? null,
        message: err.message ?? evt.message ?? evt.type,
      };
    }
    else if (typeof evt.choices?.[0]?.delta?.content === 'string') deltas.push(evt.choices[0].delta.content);
    else if (typeof evt.choices?.[0]?.message?.content === 'string') deltas.push(evt.choices[0].message.content);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  }
  if (buf) handleLine(buf.replace(/\r$/, ''));
  return { json: finalJson, outputText: deltas.join('') || null, streamError };
}

const webError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** HTTP 200 + SSE 流内失败（response.failed / error）→ infrastructure 分类。 */
function classifyStreamError(se) {
  const sig = `${se?.code ?? ''} ${se?.status ?? ''} ${se?.message ?? ''}`.toLowerCase();
  if (/\b(401|403)\b/.test(sig) || sig.includes('unauthorized') || sig.includes('forbidden') || sig.includes('login') || sig.includes('token_expired')) {
    return 'AUDIT_WEB_LOGIN_EXPIRED';
  }
  if (/\b429\b/.test(sig) || sig.includes('rate_limit') || sig.includes('rate limit') || sig.includes('quota')) {
    return 'AUDIT_WEB_QUOTA';
  }
  return 'AUDIT_WEB_UPSTREAM_ERROR'; // 识别不了也按 infrastructure 处理，绝不降级成协议错误
}

export class WebAuditRunner {
  constructor({
    baseUrl = process.env.DSH_AUDIT_WEB_BASE_URL ?? 'http://127.0.0.1:8787',
    model = process.env.DSH_AUDIT_WEB_MODEL ?? 'gpt-5.6-sol',
    reasoningEffort = process.env.DSH_AUDIT_WEB_REASONING_EFFORT ?? 'high',
    authJsonPath = process.env.DSH_AUDIT_WEB_AUTH ?? `${process.env.HOME ?? '/root'}/.codex/auth.json`,
    timeoutMs = 300_000,
    transientRetries = 2,
    retryDelayMs = 5_000,
    readAuth = null,   // 可注入：() => token（测试用）；默认读 auth.json
    transport = null,  // 可注入：({url,method,headers,body,timeoutMs}) => {status,json,text}
    evidence = null,   // A5.5（A′）：{ provider, resolve(runId)→{cwd} } verified git evidence
    rawDumpDirFor = null, // 可注入：(packet) => dir|null（测试用）；默认 audit store 的 run 目录
    execTest = null,      // v0.4.2：桥侧目标提交测试执行 { cmd, timeoutMs }（config.audit.execTest）
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.authJsonPath = authJsonPath;
    this.timeoutMs = timeoutMs;
    this.transientRetries = Math.max(0, transientRetries);
    this.retryDelayMs = retryDelayMs;
    this.readAuth = readAuth ?? (() => this.#readTokenFromFile());
    this.transport = transport ?? defaultTransport;
    this.sleep = sleep;
    // A5.5（A′）：verified git evidence bundle。{ provider, resolve(runId)→{cwd} }，
    // resolve 为只读 resolver（生产装配用 controller.resolveRunContext）。
    // 缺省 null = 无 evidence 通道（测试/降级路径，行为同 A5.3）。
    this.evidence = evidence ?? null;
    // v0.4.2：桥侧在精确 TARGET_COMMIT 上执行测试并把结构化记录注入评审包。
    this.execTest = execTest ?? null;
    // 观测性（不改任何冻结语义）：评审文本缺失/不可解析时把原始文本落盘，便于事后诊断。
    // DSH_AUDIT_RAW_DUMP=0 可整体关闭；注入 rawDumpDirFor 覆盖落盘位置（测试用）。
    // R1 修复（评审 addendum A2）：默认根目录不再硬编码 ~/.dsh/feishu —— 跟随桥的
    // 数据目录解析（DSH_FEISHU_DATA_DIR ?? $HOME/.dsh/feishu，与 config.js/dataDir
    // 同源），DSH_AUDIT_RAW_DUMP_DIR 可显式覆盖。此前硬编码令未隔离的测试运行把
    // reviewer-raw-*.txt 写进生产 store（run-x1 / audit_19700101* 污染事件）。
    this.rawDumpRoot = process.env.DSH_AUDIT_RAW_DUMP_DIR
      ?? join(process.env.DSH_FEISHU_DATA_DIR ?? join(process.env.HOME ?? '/root', '.dsh/feishu'), 'audit/runs');
    this.rawDumpDirFor = rawDumpDirFor ?? ((p) => (
      process.env.DSH_AUDIT_RAW_DUMP === '0' ? null
        : join(this.rawDumpRoot, p.runId)
    ));
    this.calls = []; // 可观测性：{ packet, attempts, outcome }
  }

  /** best-effort 原始文本落盘：任何失败静默（诊断通道绝不能影响主流程）。 */
  #dumpRaw(packet, text, why) {
    try {
      const dir = this.rawDumpDirFor(packet);
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `reviewer-raw-i${packet.iteration}-${Date.now()}.txt`);
      writeFileSync(file, `# ${why}\n# model=${this.model} effort=${this.reasoningEffort} bytes=${text.length}\n${text}`);
      console.warn(`[audit][web-runner] ${why} — raw reviewer text (${text.length} bytes) dumped to ${file}`);
    } catch { /* 诊断失败不影响主流程 */ }
  }

  #readTokenFromFile() {
    let raw;
    try { raw = JSON.parse(readFileSync(this.authJsonPath, 'utf8')); }
    catch (e) { throw webError('AUDIT_WEB_LOGIN_EXPIRED', `auth file unreadable: ${this.authJsonPath}: ${e.message}`); }
    const token = raw?.tokens?.access_token ?? raw?.OPENAI_API_KEY ?? null;
    if (typeof token !== 'string' || !token) {
      throw webError('AUDIT_WEB_LOGIN_EXPIRED', `no usable token in ${this.authJsonPath} (ChatGPT login required)`);
    }
    return token;
  }

  async review(packet) {
    if (!packet?.runId || !packet?.stage || !packet?.iteration || !packet?.targetCommit) {
      throw webError('AUDIT_PACKET_INVALID', 'audit packet is incomplete');
    }
    const token = this.readAuth();
    // A5.5（A′）：调用模型前动态生成 verified evidence bundle。
    // remote tip ≠ TARGET_COMMIT → AUDIT_EVIDENCE_UNVERIFIED fail-closed（不重试）。
    let evidenceBlock = '';
    let evidenceContext = null;
    if (this.evidence) {
      const ctx = await this.evidence.resolve(packet.runId);
      evidenceContext = ctx;
      if (!ctx?.cwd) {
        throw webError('AUDIT_EVIDENCE_UNVERIFIED', `evidence resolver returned no cwd for run ${packet.runId}`);
      }
      evidenceBlock = `\n\n${await this.evidence.provider.build({
        cwd: ctx.cwd, repo: packet.repo, branch: packet.branch,
        baseCommit: packet.baseCommit, targetCommit: packet.targetCommit,
      })}`;
    }
    // v0.4.2：桥侧测试执行记录 —— 评审要求"精确 TARGET_COMMIT 上的可信测试执行"。
    // 在 targetCommit 的隔离 worktree 上真实执行；任何错误记录进 record.error，绝不阻塞评审。
    let execTestBlock = '';
    if (this.execTest && evidenceContext?.cwd) {
      const record = await runExecutorTests({
        cwd: evidenceContext.cwd, repo: packet.repo, targetCommit: packet.targetCommit,
        cfg: this.execTest,
        dumpDir: this.rawDumpDirFor(packet),
        iteration: packet.iteration,
      });
      execTestBlock = `\n\n## BRIDGE-EXECUTED TEST RECORD\n(executed by the audit bridge at the exact TARGET_COMMIT \`${packet.targetCommit}\` in an isolated detached worktree; NOT authored by the executor. This is the machine-verified post-commit test evidence.)\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
    }
    const handoff = buildHandoff({
      runId: packet.runId,
      hostId: packet.hostId,
      stage: packet.stage,
      iteration: packet.iteration,
      repo: packet.repo,
      branch: packet.branch,
      targetCommit: packet.targetCommit,
      baseCommit: packet.baseCommit,
      goal: packet.goal,
      stageRequirement: packet.stageRequirement,
      completed: packet.completed,
    });
    const userText = `${handoff}${evidenceBlock}${execTestBlock}\n\n${verdictTemplate(packet)}`;
    const body = {
      model: this.model,
      reasoning: { effort: this.reasoningEffort },
      input: [
        { type: 'message', role: 'developer', content: SYSTEM_PROMPT },
        { type: 'message', role: 'user', content: userText },
      ],
      store: false,
      stream: true, // headroom :8787 强制流式（live 实测 HTTP 400 "Stream must be set to true"）
    };
    const record = { packet, attempts: 0, outcome: null };
    this.calls.push(record);
    const res = await this.#postWithRetries(body, token, record);
    // SSE 应答：模型文本在 outputText（delta 累积）；JSON 应答：从 json 提取。
    const text = res.outputText ?? extractReviewerText(res.json);
    if (!text) {
      this.#dumpRaw(packet, '', 'AUDIT_VERDICT_MISSING: reviewer returned no output text');
      throw webError('AUDIT_VERDICT_MISSING', 'web reviewer returned no output text');
    }
    let verdict;
    try { verdict = parseAuditorVerdict(text); }
    catch (e) {
      if (e instanceof ProtocolParseError) {
        this.#dumpRaw(packet, text, `AUDIT_VERDICT_MALFORMED: ${e.message}`);
        throw webError('AUDIT_VERDICT_MALFORMED', 'web reviewer returned malformed verdict', { cause: e });
      }
      this.#dumpRaw(packet, text, `parse error: ${e?.message ?? e}`);
      throw e;
    }
    record.outcome = verdict.state;
    return verdict;
  }

  async #postWithRetries(body, token, record) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.transientRetries; attempt++) {
      record.attempts += 1;
      if (attempt > 0) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      let res;
      try {
        res = await this.transport({
          url: `${this.baseUrl}/v1/responses`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body,
          timeoutMs: this.timeoutMs,
        });
      } catch (e) {
        // 网络层失败（连接拒绝 / DNS / 超时中断）→ 瞬态，可重试。
        lastError = webError('AUDIT_WEB_UNREACHABLE', `web reviewer transport failed: ${e?.message ?? e}`, { cause: e });
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        // HTTP 200 但流内 response.failed / error：infrastructure error，round latch，
        // 绝不降级成 verdictMissing（A4 冻结语义，A5.3 收口）。
        if (res.streamError) {
          const code = classifyStreamError(res.streamError);
          throw webError(code, `web reviewer stream failed (${res.streamError.type}${res.streamError.code ? ` ${res.streamError.code}` : ''}): ${String(res.streamError.message).slice(0, 300)}`);
        }
        record.outcome = record.outcome ?? `http_${res.status}`;
        return res;
      }
      const snippet = (res.json?.error?.message ?? res.outputText ?? '').toString().slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw webError('AUDIT_WEB_LOGIN_EXPIRED', `web reviewer auth rejected (HTTP ${res.status}): ${snippet}`);
      }
      if (res.status === 429) {
        throw webError('AUDIT_WEB_QUOTA', `web reviewer quota exhausted (HTTP 429): ${snippet}`);
      }
      if (res.status >= 500) {
        lastError = webError('AUDIT_WEB_UPSTREAM_ERROR', `web reviewer upstream error (HTTP ${res.status}): ${snippet}`);
        continue; // 瞬态
      }
      throw webError('AUDIT_WEB_REQUEST_REJECTED', `web reviewer request rejected (HTTP ${res.status}): ${snippet}`);
    }
    throw lastError;
  }
}
