/** The structured log record that carries an invocation's developer-defined identifiers. */
export const LOG_CONTEXT_MESSAGE = 'upwind.custom-context.v1';

/** Set by the edge after sanitization, only on requests dispatched to hosted Workers. */
export const LOG_CORRELATION_HEADER = 'x-arkor-log-request-id';

export const MAX_LOG_CONTEXT_ENTRIES = 16;
export const MAX_LOG_CONTEXT_KEY_LENGTH = 64;
export const MAX_LOG_CONTEXT_VALUE_LENGTH = 200;
/** Includes the envelope: a Tail consumer can keep it as one console argument. */
export const MAX_LOG_CONTEXT_BYTES = 4096;

export interface LogContextEnvelope {
  readonly message: typeof LOG_CONTEXT_MESSAGE;
  readonly __upwindLogContext: 1;
  readonly context: Readonly<Record<string, string>>;
}

const CORRELATION_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const CORRELATION_ID_LENGTH = 36;

/** A canonical UUID v4, as crypto.randomUUID() produces it. */
export function isLogCorrelationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === CORRELATION_ID_LENGTH &&
    CORRELATION_ID.test(value)
  );
}

/** Accept ordinary identifier maps and null-prototype snapshots, without class instances. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Read data properties only: logging must not evaluate an application's getters. */
function ownValue(record: Readonly<Record<string, unknown>>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? (descriptor.value as unknown)
    : undefined;
}

/** Copy bounded, enumerable string data without retaining caller-owned objects or getters. */
function copiedContext(value: unknown): Record<string, string> | undefined {
  if (!plainRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > MAX_LOG_CONTEXT_ENTRIES) return undefined;
  const copied = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_LOG_CONTEXT_KEY_LENGTH) return undefined;
    const entry = ownValue(value, key);
    if (typeof entry !== 'string' || entry.length > MAX_LOG_CONTEXT_VALUE_LENGTH) return undefined;
    copied[key] = entry;
  }
  return copied;
}

/** Validate and snapshot one map. Malformed data and throwing proxy traps fail without a log. */
export function logContextEnvelope(context: unknown): LogContextEnvelope | undefined {
  try {
    const copied = copiedContext(context);
    if (copied === undefined) return undefined;
    const envelope: LogContextEnvelope = {
      message: LOG_CONTEXT_MESSAGE,
      __upwindLogContext: 1,
      context: copied,
    };
    return new TextEncoder().encode(JSON.stringify(envelope)).byteLength <= MAX_LOG_CONTEXT_BYTES
      ? envelope
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read a known marker without trusting getters, inherited fields, or its identifier map. */
export function readLogContext(envelope: unknown): Readonly<Record<string, string>> | undefined {
  try {
    if (
      !plainRecord(envelope) ||
      ownValue(envelope, 'message') !== LOG_CONTEXT_MESSAGE ||
      ownValue(envelope, '__upwindLogContext') !== 1
    ) {
      return undefined;
    }
    return logContextEnvelope(ownValue(envelope, 'context'))?.context;
  } catch {
    return undefined;
  }
}
