import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECRET_KEY = /(token|authorization|cookie|password|secret)/i;

function sanitize(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item)
  ]));
}

export function createLogger({ logPath = null, consoleOutput = true } = {}) {
  async function write(level, event, details = {}) {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitize(details)
    });
    if (consoleOutput) {
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(`${entry}\n`);
    }
    if (logPath) {
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${entry}\n`, { mode: 0o600 });
    }
  }

  return {
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details)
  };
}
