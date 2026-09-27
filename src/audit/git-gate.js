/**
 * audit/git-gate.js — A3 real GitHub remote gate.
 *
 * The gate is deliberately transport-free and shell-safe: git is invoked via
 * execFile (never a shell string). A READY head is audit-eligible only after
 * push succeeds and ls-remote(origin, branch) equals that exact head.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitGateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitGateError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class GitRemoteGate {
  constructor({ cwd, git = 'git', execFileFn = exec } = {}) {
    this.cwd = cwd;
    this.git = git;
    this.execFile = execFileFn;
  }

  async #git(args) {
    try {
      const { stdout, stderr } = await this.execFile(this.git, args, { cwd: this.cwd, encoding: 'utf8' });
      return { stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() };
    } catch (e) {
      const detail = `${e.stderr ?? ''} ${e.stdout ?? ''} ${e.message ?? ''}`;
      const rejected = /non-fast-forward|fetch first|rejected|failed to push some refs|denied/i.test(detail);
      throw new GitGateError(
        rejected ? 'AUDIT_GIT_REJECTED' : 'AUDIT_GIT_COMMAND_FAILED',
        `git ${args.join(' ')} failed: ${detail.trim()}`,
        { cause: e, args, stderr: String(e.stderr ?? ''), stdout: String(e.stdout ?? '') },
      );
    }
  }

  async inspect({ branch, repo } = {}) {
    if (!this.cwd) throw new GitGateError('AUDIT_GIT_CONFIG_INVALID', 'cwd is required');
    const { stdout: root } = await this.#git(['rev-parse', '--show-toplevel']);
    const { stdout: head } = await this.#git(['rev-parse', 'HEAD']);
    const { stdout: currentBranch } = await this.#git(['symbolic-ref', '--short', 'HEAD']);
    const { stdout: origin } = await this.#git(['remote', 'get-url', 'origin']);
    const { stdout: dirty } = await this.#git(['status', '--porcelain']);
    if (dirty) throw new GitGateError('AUDIT_GIT_DIRTY', 'workspace has uncommitted changes');
    if (repo && origin !== repo) {
      throw new GitGateError('AUDIT_GIT_REPO_MISMATCH', `origin mismatch: expected ${repo}, got ${origin}`);
    }
    if (branch && currentBranch !== branch) {
      throw new GitGateError('AUDIT_GIT_BRANCH_MISMATCH', `branch mismatch: expected ${branch}, got ${currentBranch}`);
    }
    if (/^stub:/i.test(origin)) throw new GitGateError('AUDIT_GIT_STUB_FORBIDDEN', 'stub remote is forbidden for A3 runs');
    const { stdout: remoteLine } = await this.#git(['ls-remote', origin, `refs/heads/${currentBranch}`]);
    const remoteHead = remoteLine.split(/\s+/)[0] ?? '';
    if (remoteHead !== head) {
      throw new GitGateError('AUDIT_GIT_START_REMOTE_MISMATCH', `startup remote tip ${remoteHead || '<empty>'} != local HEAD ${head}`, { remoteHead, head });
    }
    return { cwd: root, repo: origin, branch: currentBranch, head, remoteHead };
  }

  async isAncestor(ancestor, descendant) {
    try {
      await this.#git(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (e) {
      if (e.code === 'AUDIT_GIT_COMMAND_FAILED' && e.cause?.status === 1) return false;
      return false;
    }
  }

  async pushAndVerify({ branch, head, remote = 'origin' } = {}) {
    if (!branch || !head) throw new GitGateError('AUDIT_GIT_CONFIG_INVALID', 'branch and head are required');
    const { stdout: localHead } = await this.#git(['rev-parse', 'HEAD']);
    if (localHead !== head) {
      throw new GitGateError('AUDIT_GIT_HEAD_MISMATCH', `marker HEAD ${head} != local HEAD ${localHead}`, { head, localHead });
    }
    await this.#git(['push', remote, `HEAD:refs/heads/${branch}`]);
    const { stdout } = await this.#git(['ls-remote', remote, `refs/heads/${branch}`]);
    const tip = stdout.split(/\s+/)[0] ?? '';
    if (tip !== head) {
      throw new GitGateError('AUDIT_GIT_TIP_DIVERGED', `remote tip ${tip || '<empty>'} != HEAD ${head}`, { tip, head });
    }
    return { ok: true, tipMatches: true, tip, head };
  }
}
