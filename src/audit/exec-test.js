/**
 * audit/exec-test.js — 桥侧执行者测试执行记录（v0.4.2 direction-4）。
 *
 * 目的：评审 P0 反复要求"精确 TARGET_COMMIT 上的可信测试执行记录"。纯 git 内
 * 无法自证（提交无法内嵌自身哈希），正确通道是桥（审计基础设施，独立于执行者
 * 仓库）在目标提交上真实执行测试并把结构化结果注入评审包。
 *
 * 语义：
 *  - 在 `git worktree add --detach <tmp> <targetCommit>` 的隔离工作树上执行
 *    配置命令（不碰执行者的工作树）；
 *  - 命令中 `{junit}` 占位符替换为工作树内 junit xml 路径；若命令产出该文件则
 *    解析结构化计数（tests/failures/errors/skipped/time），杜绝数进度点；
 *  - 任何基础设施错误都记录进结果（record.error），绝不抛出——测试执行记录
 *    是证据通道，不能阻塞评审主流程；
 *  - 记录落盘 run store（executor-tests-i<iter>.json）并返回给调用方注入评审包。
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd }, (err, stdout, stderr) => {
    if (err) {
      err.stderr = stderr;
      reject(err);
      return;
    }
    resolve(stdout);
  });
});

const runShell = (cmd, cwd, timeoutMs) => new Promise((resolve) => {
  execFile('bash', ['-lc', cmd], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({
      exitCode: err && typeof err.code === 'number' ? err.code : err ? -1 : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      timedOut: Boolean(err?.killed && err?.signal === 'SIGTERM'),
    });
  });
});

/** 解析 pytest 风格 junit xml 的 testsuite 属性（最小实现：只读根元素属性）。 */
export function parseJUnitXml(xml) {
  if (!xml || typeof xml !== 'string') return null;
  const m = xml.match(/<testsuite\b[^>]*>/);
  if (!m) return null;
  const attrs = {};
  for (const a of m[0].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const out = {
    tests: num(attrs.tests),
    failures: num(attrs.failures) ?? 0,
    errors: num(attrs.errors) ?? 0,
    skipped: num(attrs.skipped) ?? 0,
  };
  if (attrs.time !== undefined) out.time = num(attrs.time);
  if (out.tests === null) return null;
  out.passed = out.tests - out.failures - out.errors - out.skipped;
  return out;
}

/**
 * @param {object} p
 * @param {string} p.cwd        执行者仓库工作目录（git 仓库根）
 * @param {string} p.repo       仓库标识（记录用）
 * @param {string} p.targetCommit 目标提交完整哈希
 * @param {{cmd:string, timeoutMs?:number}} p.cfg config.audit.execTest
 * @param {string|null} p.dumpDir 落盘目录（run store 目录；null=不落盘）
 * @param {number} p.iteration   当前迭代（落盘文件名用）
 * @returns {Promise<object>} record（永不 reject）
 */
export async function runExecutorTests({ cwd, repo, targetCommit, cfg, dumpDir, iteration }) {
  const record = {
    kind: 'bridge-executed-tests',
    repo,
    targetCommit,
    command: cfg?.cmd ?? null,
    ranAt: new Date().toISOString(),
    exitCode: null,
    junit: null,
    stdoutTail: null,
    stderrTail: null,
    error: null,
  };
  if (!cfg?.cmd || typeof cfg.cmd !== 'string' || !cfg.cmd.includes('{junit}')) {
    record.error = 'config audit.execTest.cmd missing or lacks {junit} placeholder';
    return record;
  }
  let worktree = null;
  try {
    worktree = mkdtempSync(join(tmpdir(), `audit-exec-test-${Date.now()}-`));
    // 注意：mkdtemp 目录已存在，git worktree add 要求目标不存在——先删再让 git 建。
    rmSync(worktree, { recursive: true, force: true });
    await git(cwd, ['worktree', 'add', '--detach', worktree, targetCommit]);
    const junitPath = join(worktree, 'bridge-junit.xml');
    const cmd = cfg.cmd.replaceAll('{junit}', junitPath);
    const res = await runShell(cmd, worktree, cfg.timeoutMs ?? 900_000);
    record.exitCode = res.exitCode;
    record.timedOut = res.timedOut;
    record.stdoutTail = res.stdout.slice(-4000);
    record.stderrTail = res.stderr.slice(-2000);
    try {
      record.junit = parseJUnitXml(readFileSync(junitPath, 'utf8'));
    } catch {
      record.junit = null; // 命令未产出 junit：exitCode 仍是证据
    }
  } catch (e) {
    record.error = String(e?.message ?? e);
    if (e?.stderr) record.stderrTail = String(e.stderr).slice(-2000);
  } finally {
    if (worktree) {
      try { await git(cwd, ['worktree', 'remove', '--force', worktree]); } catch { /* best-effort */ }
      try { rmSync(worktree, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  if (dumpDir) {
    try {
      mkdirSync(dumpDir, { recursive: true });
      writeFileSync(join(dumpDir, `executor-tests-i${iteration}.json`), JSON.stringify(record, null, 2));
    } catch { /* 落盘失败不影响返回 */ }
  }
  return record;
}
