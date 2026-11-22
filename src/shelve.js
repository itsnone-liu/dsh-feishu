/**
 * 会话自动归档（方案C，2026-11-21）：桥启动后自动清扫——
 * >N 天未动、未显式命名、非任何聊天绑定的 session 目录，移入
 * sessions-archive/<日期>/<工作区slug>/。同盘 rename，可逆（挪回即复活）。
 * 防呆：① 绑定会话绝不碰 ② 显式 /name 过的保留 ③ 近60分钟改动的当live放过
 *       ④ 非 uuid 形态目录不碰 ⑤ 任何失败只记日志，绝不影响桥启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { dshHome } from './config.js';

const SESSION_DIR = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 跑一次清扫。store=BindingStore, titles=TitleStore。返回 {moved, kept}。 */
export function sweepShelve({ config, store, titles, dryRun = false }) {
  const days = Number(config.sessionSweepDays) || 30;
  const cut = Date.now() - days * 86400_000;
  const liveGuard = Date.now() - 60 * 60_000;

  const protectedIds = new Set((store?.sessionIds?.() ?? []).flatMap((id) => [id, id.replace(/^session-/, ''), `session-${id}`]));
  const explicit = new Set((titles?.explicitIds?.() ?? []).flatMap((id) => [id, id.replace(/^session-/, ''), `session-${id}`]));

  const root = path.join(dshHome(), 'sessions');
  if (!fs.existsSync(root)) return { moved: 0, kept: 0 };
  const arcRoot = path.join(dshHome(), 'sessions-archive', new Date().toISOString().slice(0, 10));
  let moved = 0, kept = 0;
  for (const slug of fs.readdirSync(root)) {
    const srcDir = path.join(root, slug);
    let st0; try { st0 = fs.statSync(srcDir); } catch { continue; }
    if (!st0.isDirectory()) continue;
    for (const name of fs.readdirSync(srcDir)) {
      if (!SESSION_DIR.test(name)) continue;
      const p = path.join(srcDir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (protectedIds.has(name) || explicit.has(name)) { kept++; continue; }
      if (st.mtimeMs > liveGuard || st.mtimeMs > cut) { kept++; continue; }
      if (dryRun) { log.info(`shelve dry-run: would move ${slug}/${name}`); moved++; continue; }
      const dstDir = path.join(arcRoot, slug);
      fs.mkdirSync(dstDir, { recursive: true });
      const dst = path.join(dstDir, name);
      if (fs.existsSync(dst)) { kept++; continue; }
      try { fs.renameSync(p, dst); moved++; }
      catch (e) { log.warn(`shelve skip ${name}: ${e.message}`); }
    }
  }
  log.info(`session sweep: moved=${moved} kept=${kept} (retain=${days}d dryRun=${dryRun})`);
  return { moved, kept };
}
