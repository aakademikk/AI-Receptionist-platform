import { serverEnv } from '../env.ts';
import { redactObject } from './redact.ts';

/**
 * Structured JSON logging.
 *
 * JSON lines rather than pretty text because these logs are read by a log
 * aggregator far more often than by a person, and because `trace_id` needs to be
 * a queryable field to correlate an n8n execution with the API calls and model
 * calls it caused.
 *
 * Every payload passes through `redactObject`, so a caller who logs a whole
 * request body cannot accidentally publish a customer's phone number.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = serverEnv.logLevel.toLowerCase() as Level;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

export interface LogContext {
  traceId?: string;
  businessId?: string;
  conversationId?: string;
  [key: string]: unknown;
}

function emit(level: Level, message: string, context: LogContext = {}): void {
  if (LEVEL_ORDER[level] < threshold()) return;

  const record = {
    level,
    message,
    time: new Date().toISOString(),
    ...(redactObject(context) as Record<string, unknown>),
  };

  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),

  /**
   * A child logger with baked-in context, so a request handler sets `traceId` and
   * `businessId` once instead of threading them through every call.
   */
  child(base: LogContext) {
    return {
      debug: (message: string, context?: LogContext) => emit('debug', message, { ...base, ...context }),
      info: (message: string, context?: LogContext) => emit('info', message, { ...base, ...context }),
      warn: (message: string, context?: LogContext) => emit('warn', message, { ...base, ...context }),
      error: (message: string, context?: LogContext) => emit('error', message, { ...base, ...context }),
    };
  },
};

export type Logger = typeof logger;

/** Correlation id. Prefixed so it is recognisable in a mixed log stream. */
export function newTraceId(): string {
  return `atw_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}
