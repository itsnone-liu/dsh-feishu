/**
 * audit/fake-runner.js — A1 离线测试编排器：FakeExecutor / FakeAuditor + 场景驱动。
 *
 * 全部确定性：无真实 sleep、无网络、无 git、无模型。push/ls-remote、quota、crash
 * 都由脚本注入；时间通过 store 的 now 注入。它只做编排，语义决策全部在
 * state-machine —— fake 不得绕过 AuditRun 直接改状态。
 *
 * 脚本元素见各类头注释；耗尽脚本元素 → 抛错（测试必须显式写完期望的行为序列）。
 */
import { AuditRun } from './state-machine.js';
import {
  parseExecutorMarker, parseAuditorVerdict,
  buildExecutorMarkerText, buildVerdictText,
} from './protocol.js';
import { ProtocolParseError, AuditError } from './errors.js';

/** crash 模拟：由 runAuditScenario 在指定事件后抛出；测试捕获后用 AuditRun.open 恢复。 */
export class SimulatedCrash extends Error {
  constructor(atEvent, runId) {
    super(`simulated crash after ${atEvent} (run ${runId})`);
    this.atEvent = atEvent;
    this.runId = runId;
  }
}

/**
 * FakeExecutor 脚本元素（每个元素 = 一次 executor turn）：
 *  - {type:'READY', head?, ancestryOk?, push?, pushAll?, badRunId?, badStage?, badIteration?}
 *      push 默认 {ok:true, tipMatches:true}；
 *      pushAll: REMOTE_SYNC 重试链（WAIT_GIT_PUSH 态依次消费，如
 *               [{ok:false,kind:'transient'}, {ok:true,tipMatches:true}]）；
 *      head 缺省自动生成递增伪 SHA；
 *  - {type:'MISSING_MARKER', text?}          —— 无 [DSH-AUDIT] 块；
 *  - {type:'MALFORMED', text}                —— 有块但协议非法（走 markerMissing 路径）；
 *  - {type:'DSH_QUOTA'}                       —— 执行侧额度耗尽（下一拍自动恢复）。
 */
export class FakeExecutor {
  constructor(script = []) { this.script = [...script]; this.#i = 0; this.#commitSeq = 0; }
  #i; #commitSeq;
  #nextEl() {
    if (this.#i >= this.script.length) {
      throw new AuditError('FAKE_SCRIPT_EXHAUSTED', `executor script exhausted at step ${this.#i}`);
    }
    return this.script[this.#i++];
  }
  nextHead() { this.#commitSeq += 1; return `fke${String(this.#commitSeq).padStart(4, '0')}`; }

  /** @returns {{kind:'READY'|'MISSING'|'MALFORMED'|'DSH_QUOTA', ...}} */
  nextTurn(ctx) {
    const el = this.#nextEl();
    if (el.type === 'READY') {
      const head = el.head ?? this.nextHead();
      const text = buildExecutorMarkerText({
        runId: el.badRunId ?? ctx.runId,
        stage: el.badStage ?? ctx.stage,
        iteration: el.badIteration ?? ctx.iteration,
        head,
        hostId: el.hostId ?? ctx.hostId, // A1.1 P0-1：正式 marker 必带 HOST_ID（ctx 来自 manifest）
        summary: el.summary, tests: el.tests,
      });
      const pushAll = el.pushAll ?? [el.push ?? { ok: true, tipMatches: true }];
      return { kind: 'READY', text, head, ancestryOk: el.ancestryOk ?? true, pushAll, el };
    }
    if (el.type === 'MISSING_MARKER') return { kind: 'MISSING', text: el.text ?? 'stage done, trust me' };
    if (el.type === 'MALFORMED') return { kind: 'MALFORMED', text: el.text };
    if (el.type === 'DSH_QUOTA') return { kind: 'DSH_QUOTA' };
    throw new AuditError('FAKE_SCRIPT_INVALID', `unknown executor element type ${el.type}`);
  }
}

/**
 * FakeAuditor 脚本元素：
 *  - {type:'APPROVE'|'REVISE'|'NEED_USER', ..., badRunId?, badStage?, badIteration?, duplicate?}
 *      duplicate:true → harness 会把同一 verdict 连投两次（验证 G7 幂等）；
 *  - {type:'WEB_QUOTA'}                       —— 网页额度耗尽（下一拍自动恢复，同轮重审）；
 *  - {type:'MALFORMED_OUTPUT', text?}         —— 无合法控制块（走 verdictMissing 路径）。
 */
export class FakeAuditor {
  constructor(script = []) { this.script = [...script]; this.#i = 0; }
  #i;
  next(ctx) {
    if (this.#i >= this.script.length) {
      throw new AuditError('FAKE_SCRIPT_EXHAUSTED', `auditor script exhausted at step ${this.#i}`);
    }
    const el = this.script[this.#i++];
    if (['APPROVE', 'REVISE', 'NEED_USER'].includes(el.type)) {
      const text = buildVerdictText({
        state: el.type,
        runId: el.badRunId ?? ctx.runId,
        stage: el.badStage ?? ctx.stage,
        iteration: el.badIteration ?? ctx.iteration,
        hostId: el.hostId ?? ctx.hostId, // A1.1 P0-1：正式 verdict 必带 HOST_ID
        summary: el.summary, evidence: el.evidence,
        p0: el.p0, p1: el.p1, testsRequired: el.testsRequired,
        reason: el.reason, question: el.question,
      });
      return { kind: 'VERDICT', text, el };
    }
    if (el.type === 'WEB_QUOTA') return { kind: 'WEB_QUOTA' };
    if (el.type === 'MALFORMED_OUTPUT') return { kind: 'MALFORMED', text: el.text ?? 'looks fine to me, ship it' };
    throw new AuditError('FAKE_SCRIPT_INVALID', `unknown auditor element type ${el.type}`);
  }
}

/**
 * 离线 E2E 编排器：驱动 AuditRun 走完脚本。
 * @param {object} p
 * @param {import('./store.js').AuditStore} p.store
 * @param {object} p.manifestInput
 * @param {Array} p.executorScript
 * @param {Array} p.auditorScript
 * @param {number} [p.maxReviewIterations]
 * @param {{event: string, after?: number}} [p.crashOnEvent] 在第 after 次（默认第 1 次）出现该事件后抛 SimulatedCrash
 * @param {number} [p.maxSteps=300]
 * @returns {{run: AuditRun, aborted?: string, mismatch?: {side: string, field: string}}}
 */
export function runAuditScenario(p) {
  const {
    store, manifestInput, executorScript, auditorScript,
    maxReviewIterations = 0, crashOnEvent = null, maxSteps = 300,
  } = p;

  const eventCounts = new Map();
  // 组合委托（不用 Object.create：AuditStore 有私有字段，brand check 会拒绝代理原型链）。
  const proxied = {
    createRun: (...a) => store.createRun(...a),
    saveManifest: (...a) => store.saveManifest(...a),
    saveState: (...a) => store.saveState(...a),
    updateIndex: (...a) => store.updateIndex(...a),
    loadRun: (...a) => store.loadRun(...a),
    listRuns: (...a) => store.listRuns(...a),
    appendVerdict: (...a) => store.appendVerdict(...a),
    appendEvent: (evt) => {
      const r = store.appendEvent(evt);
      if (r.appended) {
        const n = (eventCounts.get(evt.event) ?? 0) + 1;
        eventCounts.set(evt.event, n);
        if (crashOnEvent && evt.event === crashOnEvent.event
          && n === (crashOnEvent.after ?? 1)) {
          throw new SimulatedCrash(evt.event, evt.runId);
        }
      }
      return r;
    },
  };

  const executor = new FakeExecutor(executorScript);
  const auditor = new FakeAuditor(auditorScript);
  const run = AuditRun.create(proxied, manifestInput, { maxReviewIterations });

  /** REMOTE_SYNC 重试链（harness 局部：fake 不得进入 AuditRun 内部）。 */
  let pendingPush = null;
  const takePush = () => {
    if (pendingPush && pendingPush.length > 0) {
      const r = pendingPush.shift();
      if (pendingPush.length === 0) pendingPush = null;
      return r;
    }
    return { ok: true, tipMatches: true }; // 无链时默认成功（正常路径）
  };

  let steps = 0;
  while (steps++ < maxSteps) {
    const ctx = {
      runId: run.runId, stage: run.s.currentStage, iteration: run.s.iteration,
      hostId: run.manifest.hostId, // A1.1 P0-1：身份四元组全程参与
    };

    if (run.state === 'PAUSED_NEEDS_USER' || run.isTerminal) {
      return { run };
    }

    if (run.state === 'WAIT_DSH_QUOTA') { run.dshQuotaRecovered(); continue; }
    if (run.state === 'WAIT_WEB_QUOTA') { run.webQuotaRecovered(); continue; }

    if (run.state === 'WAIT_GIT_PUSH') {
      run.remoteSyncResult(pendingPush ? takePush() : { ok: false, kind: 'transient' });
      continue;
    }

    if (run.state === 'EXECUTING') {
      if (run.s.pendingRemoteSync) { // 上拍 READY 已解析，先走 §29 gate
        run.remoteSyncResult(takePush());
        continue;
      }
      const t = executor.nextTurn(ctx);
      if (t.kind === 'DSH_QUOTA') { run.dshQuotaExhausted(); continue; }
      if (t.kind === 'MISSING' || t.kind === 'MALFORMED') { run.markerMissing(); continue; }
      // READY
      try {
        const parsed = parseExecutorMarker(t.text);
        pendingPush = [...t.pushAll];
        const r = run.executorReady(parsed, { ancestryOk: t.ancestryOk });
        if (r.historyRewritten) { pendingPush = null; return { run }; }
      } catch (e) {
        if (e.code === 'AUDIT_IDENTITY_MISMATCH') {
          return { run, aborted: 'IDENTITY_MISMATCH', mismatch: { side: 'executor', field: e.field } };
        }
        if (e.code === 'AUDIT_PROTOCOL_PARSE') { run.markerMissing(); continue; }
        throw e;
      }
      continue;
    }

    if (run.state === 'AUDITING') {
      const a = auditor.next(ctx);
      if (a.kind === 'WEB_QUOTA') { run.webQuotaExhausted(); continue; }
      if (a.kind === 'MALFORMED') { run.verdictMissing(); continue; }
      // VERDICT
      let parsed;
      try {
        parsed = parseAuditorVerdict(a.text);
      } catch (e) {
        if (e instanceof ProtocolParseError) { run.verdictMissing(); continue; }
        throw e;
      }
      try {
        const r1 = run.auditorVerdict(parsed);
        if (a.el.duplicate) {
          const r2 = run.auditorVerdict(parseAuditorVerdict(a.text)); // 同一文本重复投递
          if (!r2.deduped) throw new AuditError('FAKE_DEDUPE_BROKEN', 'duplicate verdict was not deduped');
        }
        if (r1.needUser) return { run };
      } catch (e) {
        if (e.code === 'AUDIT_IDENTITY_MISMATCH') {
          return { run, aborted: 'IDENTITY_MISMATCH', mismatch: { side: 'auditor', field: e.field } };
        }
        throw e;
      }
      continue;
    }

    if (run.state === 'PAUSED') { run.resume(); continue; }
    if (run.state === 'NEXT_STAGE' || run.state === 'IDLE') {
      throw new AuditError('FAKE_HARNESS_BUG', `transient state leaked to harness loop: ${run.state}`);
    }
    throw new AuditError('FAKE_HARNESS_BUG', `unhandled state ${run.state}`);
  }
  throw new AuditError('FAKE_STEP_LIMIT', `scenario exceeded ${maxSteps} steps — script loop?`);
}
