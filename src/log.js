/**
 * Minimal tagged logger — one line per event, no dependencies.
 *
 * Console as before, plus an optional durable file sink (the 2026-08-23
 * incident left zero trace because stdout went to a window that died with the
 * process): set DSH_FEISHU_LOG_FILE (or config.logFile) to append every line
 * with a timestamp; the file rotates at ~5 MB to `<file>.1`.
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(process.env.DSH_FEISHU_LOG || 'info')];

// ---- file sink -----------------------------------------------------------
const ROTATE_BYTES = 5 * 1024 * 1024;
let filePath = process.env.DSH_FEISHU_LOG_FILE || '';
let fileDisabled = false;

export function setLogFile(p) {
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    filePath = p;
  } catch {
    fileDisabled = true;
  }
}

function fileWrite(level, line) {
  if (!filePath || fileDisabled) return;
  try {
    try {
      const size = fs.statSync(filePath).size;
      if (size > ROTATE_BYTES) fs.renameSync(filePath, `${filePath}.1`);
    } catch {}
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    fileDisabled = true; // never let logging kill the bridge
  }
}

function emit(level, tag, parts) {
  if (LEVELS[level] < threshold) return;
  const line = `[feishu][${level}]${tag ? `[${tag}]` : ''} ${parts.join(' ')}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  fileWrite(level, line);
}

export const log = {
  setLevel(name) {
    if (LEVELS[name]) threshold = LEVELS[name];
  },
  debug: (...a) => emit('debug', '', a),
  info: (...a) => emit('info', '', a),
  warn: (...a) => emit('warn', '', a),
  error: (...a) => emit('error', '', a),
  tagged(tag) {
    return {
      debug: (...a) => emit('debug', tag, a),
      info: (...a) => emit('info', tag, a),
      warn: (...a) => emit('warn', tag, a),
      error: (...a) => emit('error', tag, a),
    };
  },
};
