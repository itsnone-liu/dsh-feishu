/** Minimal tagged logger — one line per event, no dependencies. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(process.env.DSH_FEISHU_LOG || 'info')];

function emit(level, tag, parts) {
  if (LEVELS[level] < threshold) return;
  const line = `[feishu][${level}]${tag ? `[${tag}]` : ''} ${parts.join(' ')}`;
  if (level === 'error') console.error(line);
  else console.log(line);
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
