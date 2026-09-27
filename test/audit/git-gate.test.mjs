#!/usr/bin/env node
/** A3：真实临时 git 工作树 + bare remote 的 push/ls-remote gate。 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRemoteGate, GitGateError } from '../../src/audit/git-gate.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass += 1; console.log(`PASS ${name}`);
}).catch((e) => {
  fail += 1; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`);
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const repoFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-git-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(work); fs.mkdirSync(bare);
  git(work, 'init', '-b', 'main');
  git(bare, 'init', '--bare');
  git(work, 'config', 'user.email', 'audit@test.invalid');
  git(work, 'config', 'user.name', 'Audit Test');
  fs.writeFileSync(path.join(work, 'README'), 'base\n');
  git(work, 'add', 'README'); git(work, 'commit', '-m', 'base');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-u', 'origin', 'main');
  return { root, work, bare };
};

await ok('inspect validates real origin, branch and starting HEAD', async () => {
  const f = repoFixture();
  const gate = new GitRemoteGate({ cwd: f.work, allowNonGithubRemote: true });
  const info = await gate.inspect({ branch: 'main', repo: f.bare });
  assert.equal(info.repo, f.bare);
  assert.equal(info.branch, 'main');
  assert.match(info.head, /^[0-9a-f]{40}$/);
  assert.equal(info.cwd, f.work);
});

await ok('pushAndVerify requires exact remote tip == commit HEAD', async () => {
  const f = repoFixture();
  const gate = new GitRemoteGate({ cwd: f.work, allowNonGithubRemote: true });
  const info = await gate.inspect({ branch: 'main', repo: f.bare });
  fs.writeFileSync(path.join(f.work, 'a.txt'), 'A\n');
  git(f.work, 'add', 'a.txt'); git(f.work, 'commit', '-m', 'A');
  const head = git(f.work, 'rev-parse', 'HEAD');
  const result = await gate.pushAndVerify({ branch: 'main', head });
  assert.equal(result.tipMatches, true);
  assert.equal(result.tip, head);
  assert.notEqual(info.head, head);
});

await ok('repo/branch mismatch fails closed before a run can start', async () => {
  const f = repoFixture();
  const gate = new GitRemoteGate({ cwd: f.work, allowNonGithubRemote: true });
  await assert.rejects(() => gate.inspect({ branch: 'develop', repo: f.bare }),
    (e) => e.code === 'AUDIT_GIT_BRANCH_MISMATCH');
  await assert.rejects(() => gate.inspect({ branch: 'main', repo: `${f.bare}-other` }),
    (e) => e.code === 'AUDIT_GIT_REPO_MISMATCH');
});

await ok('stub remote is forbidden', async () => {
  const f = repoFixture();
  git(f.work, 'remote', 'set-url', 'origin', 'stub://fake');
  const gate = new GitRemoteGate({ cwd: f.work, allowNonGithubRemote: true });
  await assert.rejects(() => gate.inspect({ branch: 'main', repo: 'stub://fake' }),
    (e) => e.code === 'AUDIT_GIT_STUB_FORBIDDEN');
});

await ok('remote divergence is reported as tip mismatch', async () => {
  const f = repoFixture();
  const gate = new GitRemoteGate({ cwd: f.work, allowNonGithubRemote: true });
  const info = await gate.inspect({ branch: 'main', repo: f.bare });
  await assert.rejects(() => gate.pushAndVerify({ branch: 'main', head: `${info.head.slice(0, 39)}0` }),
    (e) => e.code === 'AUDIT_GIT_COMMAND_FAILED' || e.code === 'AUDIT_GIT_TIP_DIVERGED' || e.code === 'AUDIT_GIT_HEAD_MISMATCH');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
