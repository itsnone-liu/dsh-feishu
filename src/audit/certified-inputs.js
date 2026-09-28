/**
 * audit/certified-inputs.js — 桥侧认证 live 输入物化（v0.4.3 direction-4b）。
 *
 * 背景（CSR-8 Phase A iteration-16 审计裁决）：桥在目标提交的隔离 detached
 * worktree 上执行 pytest，gitignored 的 data/ 不存在于 worktree；而冻结阶段
 * 要求真实生产门禁（C4-C regression、live preflight、candidate gates、
 * blindness、real fingerprint）可复现。裁决给出的正解：提交内测试不得必然
 * 失败；依赖不入库 live/secret 输入的门禁，由审计基础设施提供"经过认证的
 * 输入"。
 *
 * 认证协议（manifest version 2，多根）：
 *  - 执行者仓库在提交内声明 config/audit/certified_live_inputs.json：
 *    {version:2, forbiddenPrefixes, roots:[{root, dirs, files, ...}]}，
 *    每个 root 是该 data 子树的完整 inventory（每文件 sha256/bytes/mode，
 *    每目录 mode）；
 *  - 桥从 TARGET COMMIT 的 git object db 读该清单（绝不读工作树副本）；
 *  - 桥对执行者工作树的每棵认证树做全量核验：每个列出文件存在且哈希/大小/
 *    模式一致，且树中不存在清单之外的任何条目（完整 inventory，不是子集
 *    挑选）；
 *  - 全部一致才物化进 worktree（文件与目录按清单 mode 还原），任何漂移都
 *    不复制任何文件（fail-closed），漂移明细记入测试记录；
 *  - 物化结果（含清单自身 sha256）写入 executor-tests 记录，供评审审阅。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, chmod, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** 仓库内认证清单的固定路径（相对仓库根）。 */
export const CERTIFIED_MANIFEST_PATH = 'config/audit/certified_live_inputs.json';

async function shaFile(p) {
  return await new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function walkTree(root, rel = '', out = { dirs: [], files: [] }) {
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.dirs.push(r);
      await walkTree(root, r, out);
    } else if (e.isFile()) {
      out.files.push(r);
    } else {
      throw new Error(`non-regular entry in certified source tree: ${r}`);
    }
  }
  return out;
}

const mode = (st) => st.mode & 0o777;

/** 校验 manifest 形状（version 2 多根）；通过返回 roots 数组，否则 null。 */
export function validateManifest(manifest) {
  if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.roots) ||
      manifest.roots.length === 0) {
    return null;
  }
  for (const r of manifest.roots) {
    if (!r || typeof r.root !== 'string' || r.root.includes('..') ||
        r.root.startsWith('/') || !Array.isArray(r.dirs) ||
        !Array.isArray(r.files)) {
      return null;
    }
  }
  return manifest.roots;
}

/**
 * 校验并（可选）物化认证输入树（全部根）。纯函数式：不读 git、不猜路径。
 *
 * @param {object} p
 * @param {string} p.sourceRepo          执行者工作树（仓库根，绝对路径）
 * @param {string} p.targetRepo          worktree（仓库根，绝对路径）
 * @param {object} p.manifest            从 TARGET COMMIT 读出的清单（已 parse）
 * @param {boolean} [p.apply=true]       校验通过后执行复制
 * @returns {Promise<{verified:boolean, applied:boolean, roots:number,
 *   files:number, bytes:number, mismatches:string[]}>}
 */
export async function materializeCertifiedInputs({ sourceRepo, targetRepo, manifest, apply = true }) {
  const result = { verified: false, applied: false, roots: 0, files: 0, bytes: 0, mismatches: [] };
  const roots = validateManifest(manifest);
  if (!roots) {
    result.mismatches.push('manifest shape invalid (version:2 roots[] required)');
    return result;
  }
  const perRoot = [];
  for (const r of roots) {
    const sourceRoot = join(sourceRepo, r.root);
    const mDirs = new Map(r.dirs.map((d) => [d.path, d.mode]));
    const mFiles = new Map(r.files.map((f) => [f.path, f]));
    let seen;
    try {
      seen = await walkTree(sourceRoot);
    } catch (e) {
      result.mismatches.push(`source tree unreadable (${r.root}): ${e.message}`);
      continue;
    }
    const seenDirs = new Set(seen.dirs);
    const seenFiles = new Set(seen.files);
    for (const d of seenDirs) {
      if (!mDirs.has(d)) result.mismatches.push(`extra dir not in manifest: ${r.root}/${d}`);
    }
    for (const f of seenFiles) {
      if (!mFiles.has(f)) result.mismatches.push(`extra file not in manifest: ${r.root}/${f}`);
    }
    for (const [d] of mDirs) {
      if (!seenDirs.has(d)) result.mismatches.push(`manifest dir missing: ${r.root}/${d}`);
    }
    for (const [f, entry] of mFiles) {
      if (!seenFiles.has(f)) { result.mismatches.push(`manifest file missing: ${r.root}/${f}`); continue; }
      if (result.mismatches.length > 20) break;
      const st = await stat(join(sourceRoot, f));
      if (entry.bytes !== st.size) result.mismatches.push(`size drift: ${r.root}/${f}`);
      if (mode(st) !== entry.mode) result.mismatches.push(`mode drift: ${r.root}/${f}`);
      if ((await shaFile(join(sourceRoot, f))) !== entry.sha256) {
        result.mismatches.push(`sha256 drift: ${r.root}/${f}`);
      }
    }
    perRoot.push({ r, sourceRoot, mDirs, mFiles });
  }
  if (result.mismatches.length > 0) return result;
  result.verified = true;
  result.roots = roots.length;
  result.files = roots.reduce((a, r) => a + r.files.length, 0);
  result.bytes = roots.reduce((a, r) => a + r.files.reduce((x, f) => x + f.bytes, 0), 0);
  if (!apply) return result;
  for (const { r, sourceRoot } of perRoot) {
    const targetRoot = join(targetRepo, r.root);
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    for (const f of r.files) {
      const dst = join(targetRoot, f.path);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(join(sourceRoot, f.path), dst);
      if ((mode(await stat(dst))) !== f.mode) await chmod(dst, f.mode);
    }
    // 目录 mode 最后收紧（深序），避免先收紧 0500/0700 阻塞写入。
    for (const d of [...r.dirs].sort((a, b) => b.path.length - a.path.length)) {
      const dst = join(targetRoot, d.path);
      if ((mode(await stat(dst))) !== d.mode) await chmod(dst, d.mode);
    }
  }
  result.applied = true;
  return result;
}

export { shaFile };
