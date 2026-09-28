/**
 * audit/git-evidence.js — A5.5 Verified Git Evidence Bundle provider（用户裁决 A′）。
 *
 * A5 fact source 仍是 GitHub @ TARGET_COMMIT；evidence transport 改为桥生成的
 * verified git evidence bundle。信任链：
 *
 *   GitHub remote --ls-remote tip == TARGET_COMMIT--> verified TARGET_COMMIT
 *     --git object database--> bridge evidence bundle
 *     --> WebAuditRunner --> web reviewer
 *
 * 硬约束（用户 2026-09-28 裁定）：
 *  1. 绝不读 worktree —— 只用 git diff / git show / git cat-file（object db），
 *     审核材料固定在 commit object 上，worktree 后续修改不影响 bundle；
 *  2. 内容 = changed-file manifest + BASE..TARGET patch + 全部变更文本文件全文
 *     （A/M 给 TARGET 版本，D 给 BASE 版本）；
 *  3. 顶部机器生成 manifest（repo/branch/base/target/remoteTip/targetTree/
 *     changedFiles），显式 REMOTE_TIP_VERIFIED；
 *  4. 截断/排除必须显式标注（TRUNCATED / NOT_INCLUDED），绝不静默截断；
 *  5. remote tip 不匹配 → AUDIT_EVIDENCE_UNVERIFIED（fail-closed，不自动重试）。
 *
 * A4 reviewer orchestration 不变：本模块由 WebAuditRunner 通过只读
 * resolver（runId → manifest.cwd）调用，packet 形状不动。
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const EVIDENCE_TAG = '[VERIFIED-GIT-EVIDENCE]';

export class GitEvidenceProvider {
  constructor({
    git = 'git',
    execFileFn = execFile,
    maxFileBytes = 64 * 1024,
    maxTotalBytes = 512 * 1024,
    maxPatchBytes = 256 * 1024,
  } = {}) {
    this.git = git;
    this.execFileFn = execFileFn;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxPatchBytes = maxPatchBytes;
  }

  async #git(args, cwd) {
    const { stdout } = await this.execFileFn(this.git, args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  async build({ cwd, repo, branch, baseCommit, targetCommit }) {
    if (!cwd || !branch || !baseCommit || !targetCommit) {
      throw Object.assign(new Error('evidence build requires cwd, branch, baseCommit, targetCommit'), { code: 'AUDIT_EVIDENCE_UNVERIFIED' });
    }
    // 1. remote tip == TARGET_COMMIT（信任链第一环）
    const remoteOut = (await this.#git(['ls-remote', 'origin', `refs/heads/${branch}`], cwd)).toString();
    const remoteTip = remoteOut.trim().split(/\s+/)[0] ?? '';
    if (!remoteTip || remoteTip !== targetCommit) {
      throw Object.assign(new Error(`remote tip ${remoteTip || '<empty>'} != TARGET_COMMIT ${targetCommit}`), { code: 'AUDIT_EVIDENCE_UNVERIFIED' });
    }
    // 2. commit objects 存在（防伪造引用）
    for (const c of [baseCommit, targetCommit]) {
      try { await this.#git(['cat-file', '-e', `${c}^{commit}`], cwd); }
      catch (e) {
        throw Object.assign(new Error(`commit object unavailable: ${c}`), { code: 'AUDIT_EVIDENCE_UNVERIFIED', cause: e });
      }
    }
    const targetTree = (await this.#git(['rev-parse', `${targetCommit}^{tree}`], cwd)).toString().trim();

    // 3. 变更清单（--no-renames：R 分解为 A+D；numstat 的 '-' = binary）
    const statusOut = (await this.#git(['diff', '--no-renames', '--name-status', baseCommit, targetCommit], cwd)).toString();
    const numstatOut = (await this.#git(['diff', '--no-renames', '--numstat', baseCommit, targetCommit], cwd)).toString();
    const binaryPaths = new Set();
    for (const line of numstatOut.split('\n')) {
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
      if (m && (m[1] === '-' || m[2] === '-')) binaryPaths.add(m[3]);
    }
    const changed = []; // { status, path }
    for (const line of statusOut.split('\n')) {
      const m = line.match(/^([AMD])\t(.+)$/);
      if (m) changed.push({ status: m[1], path: m[2] });
    }

    // 4. patch（object db；显式截断标注）
    const patchBuf = await this.#git(['diff', '--no-renames', baseCommit, targetCommit], cwd);
    let patch = patchBuf.toString('utf8');
    let patchTruncated = false;
    if (Buffer.byteLength(patch) > this.maxPatchBytes) {
      patch = Buffer.from(patchBuf.subarray(0, this.maxPatchBytes)).toString('utf8')
        + `\n... [PATCH TRUNCATED at ${this.maxPatchBytes}/${patchBuf.length} bytes — full file contents below are authoritative]`;
      patchTruncated = true;
    }

    // 5. 变更文件全文（A/M → TARGET 版本；D → BASE 版本；预算制，显式排除）
    const notIncluded = [];
    const contents = [];
    let budget = this.maxTotalBytes;
    for (const { status, path } of changed) {
      if (binaryPaths.has(path)) { notIncluded.push(`${path} (NOT_INCLUDED: BINARY)`); continue; }
      const source = status === 'D' ? baseCommit : targetCommit;
      let size;
      try { size = Number((await this.#git(['cat-file', '-s', `${source}:${path}`], cwd)).toString().trim()); }
      catch (e) { notIncluded.push(`${path} (NOT_INCLUDED: OBJECT_UNREADABLE)`); continue; }
      if (size > budget) { notIncluded.push(`${path} (NOT_INCLUDED: TOTAL_BUDGET_EXCEEDED, ${size} bytes)`); continue; }
      budget -= size;
      const buf = await this.#git(['show', `${source}:${path}`], cwd);
      let text = buf.toString('utf8');
      const note = status === 'D' ? 'DELETED; BASE version' : status === 'A' ? 'ADDED' : 'MODIFIED';
      if (buf.length > this.maxFileBytes) {
        text = Buffer.from(buf.subarray(0, this.maxFileBytes)).toString('utf8')
          + `\n... [FILE TRUNCATED at ${this.maxFileBytes}/${buf.length} bytes]`;
        notIncluded.push(`${path} (TRUNCATED: FILE_SIZE, ${buf.length} bytes)`);
      }
      contents.push(`--- ${path} (${note}, ${buf.length} bytes) ---\n${text}`);
    }

    // 6. 组装 bundle（两层 handoff 的第二层；第一层 DSH-AUDIT HANDOFF 不变）
    const lines = [
      EVIDENCE_TAG,
      `REMOTE_TIP_VERIFIED: true`,
      `REMOTE_TIP: ${remoteTip}`,
      `REPO: ${repo ?? '(unspecified)'}`,
      `BRANCH: ${branch}`,
      `BASE_COMMIT: ${baseCommit}`,
      `TARGET_COMMIT: ${targetCommit}`,
      `TARGET_TREE: ${targetTree}`,
      `PATCH_TRUNCATED: ${patchTruncated ? 'true' : 'false'}`,
      `CHANGED_FILES:`,
      ...(changed.length ? changed.map((c) => `- ${c.status} ${c.path}`) : ['- (none)']),
      '',
      `PATCH (BASE_COMMIT..TARGET_COMMIT):`,
      patch,
      '',
      `TARGET_FILE_CONTENTS:`,
      ...contents,
    ];
    if (notIncluded.length) {
      lines.push('', `EXCLUSIONS:`, ...notIncluded.map((n) => `- ${n}`));
    }
    lines.push('', `(bundle machine-generated from git objects at the commits above; worktree state is never read)`);
    return lines.join('\n');
  }
}
