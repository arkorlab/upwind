import type { NodeBridgeOptions } from './bridge.ts';

const MAX_TIMEOUT_MS = 2_147_483_647;
const HEADERS_TIMEOUT_ENV = 'UPWIND_NODE_HEADERS_TIMEOUT_MS';

/** The native executable's override; the transport's default remains a 30-second header budget. */
export function nativeBridgeOptions(
  env: Readonly<Record<string, string | undefined>>,
): NodeBridgeOptions {
  const value = env[HEADERS_TIMEOUT_ENV];
  if (value === undefined || value === '') return {};
  const headersTimeoutMs = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (
    !Number.isSafeInteger(headersTimeoutMs) ||
    headersTimeoutMs <= 0 ||
    headersTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `${HEADERS_TIMEOUT_ENV} must be a whole number from 1 to ${String(MAX_TIMEOUT_MS)}`,
    );
  }
  return { headersTimeoutMs };
}
