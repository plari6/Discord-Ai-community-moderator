const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const at = (lvl, fn) => (LEVELS[lvl] >= min ? (...a) => fn(new Date().toISOString().slice(11, 19), ...a) : () => {});
  return {
    debug: at('debug', console.debug),
    info: at('info', console.log),
    warn: at('warn', console.warn),
    error: at('error', console.error),
  };
}

export const silentLogger = createLogger('silent');
