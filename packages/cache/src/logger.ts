/** Structured JSON logging. Never receives a token, a body or a cache key. */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type LogLevel = 'info' | 'warn' | 'error';

function emit(level: LogLevel, base: LogFields, message: string, fields?: LogFields): void {
  const line = JSON.stringify({ level, msg: message, component: 'cache', ...base, ...fields });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    info: (message, fields) => {
      emit('info', base, message, fields);
    },
    warn: (message, fields) => {
      emit('warn', base, message, fields);
    },
    error: (message, fields) => {
      emit('error', base, message, fields);
    },
  };
}

export function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
