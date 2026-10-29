import { isProd } from '../config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const weight: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minWeight = isProd ? weight.info : weight.debug;

function write(level: Level, message: string, meta?: unknown): void {
  if (weight[level] < minWeight) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) out(line);
  else out(line, meta);
}

export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};