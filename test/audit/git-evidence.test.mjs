#!/usr/bin/env node
/** A5.5（A′）git-evidence：verified git evidence bundle 硬约束覆盖。 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitEvidenceProvider, EVIDENCE_TAG } from '../../src/audit/git-evidence.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`PASS ${name}`); }).catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`); });

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-evidence-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['-C', work, 'init', '-q', '-b', 'main']);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'alpha line1\nalpha line2\n');
  fs.writeFileSync(path.join(work, 'b.txt'), 'to be deleted\n');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'main');
  // target：M a.txt / A new.py / A bin.dat(binary) / A big.txt(>64KiB) / D b.txt
  fs.writeFileSync(path.join(work, 'a.txt'), 'alpha line1\nalpha line2 CHANGED\nalpha line3\n');
  fs.writeFileSync(path.join(work, 'new.py'), 'def f():\n    return 42\n');
  fs.writeFileSync(path.join(work, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  fs.writeFileSync(path.join(work, 'big.txt'), 'y'.repeat(200 * 1024));
  fs.unlinkSync(path.join(work, 'b.txt'));
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'target');
  const target = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', 'origin', 'main');
  return { root, work, bare, base, target };
}

await ok('bundle verifies remote tip and carries manifest + patch + contents', async () => {
  const f = fixture();
  const p = new GitEvidenceProvider();
  const bundle = await p.build({ cwd: f.work, repo: 'https://github.com/x/y.git', branch: 'main', baseCommit: f.base, targetCommit: f.target });
  assert.ok(bundle.startsWith(EVIDENCE_TAG));
  assert.ok(bundle.includes('REMOTE_TIP_VERIFIED: true'));
  assert.ok(bundle.includes(`REMOTE_TIP: ${f.target}`));
  assert.ok(bundle.includes(`BASE_COMMIT: ${f.base}`));
  assert.ok(bundle.includes(`TARGET_COMMIT: ${f.target}`));
  assert.match(bundle, /TARGET_TREE: [0-9a-f]{40}/);
  assert.ok(bundle.includes('- M a.txt'));
  assert.ok(bundle.includes('- A new.py'));
  assert.ok(bundle.includes('- A bin.dat'));
  assert.ok(bundle.includes('- A big.txt'));
  assert.ok(bundle.includes('- D b.txt'));
  // patch 段来自 object db
  assert.ok(bundle.includes('PATCH (BASE_COMMIT..TARGET_COMMIT):'));
  assert.ok(bundle.includes('alpha line2 CHANGED'));
  // A/M 给 TARGET 版全文，D 给 BASE 版全文
  assert.ok(bundle.includes('--- a.txt (MODIFIED'));
  assert.ok(bundle.includes('alpha line3'));
  assert.ok(bundle.includes('--- new.py (ADDED'));
  assert.ok(bundle.includes('return 42'));
  assert.ok(bundle.includes('--- b.txt (DELETED; BASE version'));
  assert.ok(bundle.includes('to be deleted'));
});

await ok('binary excluded explicitly; oversized file truncated with marker (never silent)', async () => {
  const f = fixture();
  const p = new GitEvidenceProvider();
  const bundle = await p.build({ cwd: f.work, branch: 'main', baseCommit: f.base, targetCommit: f.target });
  assert.ok(bundle.includes('bin.dat (NOT_INCLUDED: BINARY)'));
  assert.ok(!bundle.includes('--- bin.dat'));
  assert.ok(bundle.includes('big.txt (TRUNCATED: FILE_SIZE, 204800 bytes)'));
  assert.ok(bundle.includes('[FILE TRUNCATED at 65536/204800 bytes]'));
});

await ok('worktree immunity: post-build worktree edits never leak into the bundle', async () => {
  const f = fixture();
  const p = new GitEvidenceProvider();
  const before = await p.build({ cwd: f.work, branch: 'main', baseCommit: f.base, targetCommit: f.target });
  fs.writeFileSync(path.join(f.work, 'a.txt'), 'WORKTREE TAMPER\n');
  fs.writeFileSync(path.join(f.work, 'untracked.txt'), 'should not appear\n');
  const after = await p.build({ cwd: f.work, branch: 'main', baseCommit: f.base, targetCommit: f.target });
  assert.equal(after, before);
  assert.ok(!after.includes('WORKTREE TAMPER'));
  assert.ok(!after.includes('untracked.txt'));
});

await ok('remote tip mismatch → AUDIT_EVIDENCE_UNVERIFIED fail-closed', async () => {
  const f = fixture();
  // 在另一个 clone 上推进远端，使 remote tip != TARGET_COMMIT
  const clone = path.join(f.root, 'clone');
  execFileSync('git', ['clone', '-q', f.bare, clone]);
  git(clone, 'config', 'user.email', 't@t'); git(clone, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(clone, 'c.txt'), 'diverged\n');
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'diverge');
  git(clone, 'push', '-q', 'origin', 'main');
  const p = new GitEvidenceProvider();
  await assert.rejects(
    () => p.build({ cwd: f.work, branch: 'main', baseCommit: f.base, targetCommit: f.target }),
    (e) => e.code === 'AUDIT_EVIDENCE_UNVERIFIED',
  );
});

await ok('base/target commit objects required (forged refs rejected)', async () => {
  const f = fixture();
  const p = new GitEvidenceProvider();
  await assert.rejects(
    () => p.build({ cwd: f.work, branch: 'main', baseCommit: '0'.repeat(40), targetCommit: f.target }),
    (e) => e.code === 'AUDIT_EVIDENCE_UNVERIFIED',
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
