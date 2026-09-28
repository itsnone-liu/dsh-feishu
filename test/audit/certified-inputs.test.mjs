#!/usr/bin/env node
/**
 * audit/certified-inputs.test.mjs — 认证输入物化 helper 的离线单元测试。
 *
 * 覆盖：完整一致（多根）→ 物化且内容/mode 保持；哈希漂移/多余文件/缺失
 * 文件 → fail-closed 全局不复制；清单损坏（v1 或缺 roots）→ 拒绝；
 * apply=false 只校验。
 */
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeCertifiedInputs, CERTIFIED_MANIFEST_PATH } from '../../src/audit/certified-inputs.js';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass++; console.log(`PASS ${name}`); })
  .catch((e) => { fail++; console.error(`FAIL ${name}\n  ${e.stack?.split('\n').slice(0, 6).join('\n  ')}`); });

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** 造两根小认证树 + 对应 version-2 多根清单。 */
function buildRepo(repo, { modeFile = 0o600, modeDir = 0o700 } = {}) {
  const mk = (rel) => {
    const root = join(repo, rel);
    mkdirSync(join(root, 'secret'), { recursive: true });
    mkdirSync(join(root, 'production/c4-prod-0002/sealing'), { recursive: true });
    writeFileSync(join(root, 'secret/secret_salt'), `salt-${rel}`);
    writeFileSync(join(root, 'production/c4-prod-0002/sealing/sealing_log.jsonl'), '{"e":1}\n');
    for (const p of ['secret', 'production', 'production/c4-prod-0002', 'production/c4-prod-0002/sealing']) {
      chmodSync(join(root, p), modeDir);
    }
    chmodSync(join(root, 'secret/secret_salt'), modeFile);
    chmodSync(join(root, 'production/c4-prod-0002/sealing/sealing_log.jsonl'), modeFile);
    const file = (r2) => {
      const b = readFileSync(join(root, r2));
      return { path: r2, sha256: sha(b), bytes: b.length, mode: statSync(join(root, r2)).mode & 0o777 };
    };
    return {
      root: rel,
      dirCount: 4, fileCount: 2,
      totalBytes: 2 * modeFile, // 占位，helper 不读
      dirs: ['secret', 'production', 'production/c4-prod-0002', 'production/c4-prod-0002/sealing']
        .map((p) => ({ path: p, mode: modeDir })),
      files: [file('secret/secret_salt'), file('production/c4-prod-0002/sealing/sealing_log.jsonl')],
    };
  };
  return { version: 2, forbiddenPrefixes: ['annotator/'], roots: [mk('data/csr8_phase_c'), mk('data/adjustment_baostock')] };
}

await ok('完整一致（两根）→ 物化且内容/mode 保持', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cert-in-'));
  const src = join(base, 'src'), dst = join(base, 'dst');
  mkdirSync(src, { recursive: true });
  const manifest = buildRepo(src);
  const r = await materializeCertifiedInputs({ sourceRepo: src, targetRepo: dst, manifest });
  assert.equal(r.verified, true);
  assert.equal(r.applied, true);
  assert.equal(r.roots, 2);
  assert.equal(r.files, 4);
  assert.equal(readFileSync(join(dst, 'data/csr8_phase_c/secret/secret_salt'), 'utf8'), 'salt-data/csr8_phase_c');
  assert.equal(statSync(join(dst, 'data/adjustment_baostock/secret')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dst, 'data/csr8_phase_c/secret/secret_salt')).mode & 0o777, 0o600);
  assert.equal(r.mismatches.length, 0);
  rmSync(base, { recursive: true, force: true });
});

await ok('哈希漂移 → fail-closed 两根都不复制', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cert-in-'));
  const src = join(base, 'src'), dst = join(base, 'dst');
  mkdirSync(src, { recursive: true });
  const manifest = buildRepo(src);
  writeFileSync(join(src, 'data/adjustment_baostock/secret/secret_salt'), 'tampered');
  const r = await materializeCertifiedInputs({ sourceRepo: src, targetRepo: dst, manifest });
  assert.equal(r.verified, false);
  assert.equal(r.applied, false);
  assert.ok(r.mismatches.some((m) => m.includes('sha256 drift: data/adjustment_baostock/secret/secret_salt')));
  assert.equal(existsSync(join(dst, 'data/csr8_phase_c')), false);
  rmSync(base, { recursive: true, force: true });
});

await ok('多余文件 → fail-closed（完整 inventory 语义）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cert-in-'));
  const src = join(base, 'src'), dst = join(base, 'dst');
  mkdirSync(src, { recursive: true });
  const manifest = buildRepo(src);
  mkdirSync(join(src, 'data/csr8_phase_c/annotator'));
  writeFileSync(join(src, 'data/csr8_phase_c/annotator/draft.json'), '{}');
  const r = await materializeCertifiedInputs({ sourceRepo: src, targetRepo: dst, manifest });
  assert.equal(r.verified, false);
  assert.ok(r.mismatches.some((m) => m.includes('extra file not in manifest: data/csr8_phase_c/annotator/draft.json')));
  assert.equal(r.applied, false);
  assert.equal(existsSync(dst), false);
  rmSync(base, { recursive: true, force: true });
});

await ok('缺失文件 → fail-closed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cert-in-'));
  const src = join(base, 'src'), dst = join(base, 'dst');
  mkdirSync(src, { recursive: true });
  const manifest = buildRepo(src);
  rmSync(join(src, 'data/csr8_phase_c/production'), { recursive: true, force: true });
  const r = await materializeCertifiedInputs({ sourceRepo: src, targetRepo: dst, manifest });
  assert.equal(r.verified, false);
  assert.ok(r.mismatches.some((m) => m.includes('manifest file missing: data/csr8_phase_c')));
  assert.equal(r.applied, false);
  rmSync(base, { recursive: true, force: true });
});

await ok('清单损坏（v1 单根 / 缺 roots）→ 拒绝', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cert-in-'));
  const src = join(base, 'src');
  mkdirSync(src, { recursive: true });
  for (const bad of [{ version: 1 }, { version: 2, roots: [] }, null]) {
    const r = await materializeCertifiedInputs({ sourceRepo: src, targetRepo: join(base, 'd'), manifest: bad });
    assert.equal(r.verified, false);
    assert.ok(r.mismatches[0].includes('manifest shape invalid'));
  }
  rmSync(base, { recursive: true, force: true });
});

await ok('apply=false → 只校验不物化', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cert-in-'));
  const src = join(base, 'src'), dst = join(base, 'dst');
  mkdirSync(src, { recursive: true });
  const manifest = buildRepo(src);
  const r = await materializeCertifiedInputs({ sourceRepo: src, targetRepo: dst, manifest, apply: false });
  assert.equal(r.verified, true);
  assert.equal(r.applied, false);
  assert.equal(existsSync(dst), false);
  rmSync(base, { recursive: true, force: true });
});

await ok('导出的清单路径常量符合协议', async () => {
  assert.equal(CERTIFIED_MANIFEST_PATH, 'config/audit/certified_live_inputs.json');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
