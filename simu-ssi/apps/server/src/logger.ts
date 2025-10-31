import util from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown> | undefined;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const envLevel = String(process.env.LOG_LEVEL ?? DEFAULT_LEVEL).toLowerCase() as LogLevel;
const ACTIVE_LEVEL: LogLevel = (Object.keys(LEVEL_PRIORITY) as LogLevel[]).includes(envLevel)
  ? envLevel
  : DEFAULT_LEVEL;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[ACTIVE_LEVEL];
}

function normalizeMeta(meta: LogMeta): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    } else {
      normalized[key] = value as unknown;
    }
  }
  return normalized;
}

function formatMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) {
    return '';
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (error) {
    return ` ${util.inspect(meta, { depth: null })}`;
  }
}

function baseLog(level: LogLevel, message: string, meta?: LogMeta) {
  if (!shouldLog(level)) {
    return;
  }
  const timestamp = new Date().toISOString();
  const normalizedMeta = normalizeMeta(meta);
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${formatMeta(normalizedMeta)}`;
  switch (level) {
    case 'debug':
      console.debug(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
      console.error(line);
      break;
    default:
      console.log(line);
      break;
  }
}

export interface ScopedLogger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  child(scope: string): ScopedLogger;
}

function buildLogger(scope?: string): ScopedLogger {
  const withScope = (meta?: LogMeta): LogMeta => {
    if (!scope) {
      return meta;
    }
    return { ...meta, scope };
  };
  return {
    debug(message: string, meta?: LogMeta) {
      baseLog('debug', message, withScope(meta));
    },
    info(message: string, meta?: LogMeta) {
      baseLog('info', message, withScope(meta));
    },
    warn(message: string, meta?: LogMeta) {
      baseLog('warn', message, withScope(meta));
    },
    error(message: string, meta?: LogMeta) {
      baseLog('error', message, withScope(meta));
    },
    child(nextScope: string): ScopedLogger {
      const combined = scope ? `${scope}:${nextScope}` : nextScope;
      return buildLogger(combined);
    },
  };
}

export const logger = buildLogger();

export function createLogger(scope: string): ScopedLogger {
  return buildLogger(scope);
}

export function toError(input: unknown): Error {
  if (input instanceof Error) {
    return input;
  }
  return new Error(typeof input === 'string' ? input : util.inspect(input));
}
