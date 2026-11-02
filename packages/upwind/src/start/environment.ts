import path from 'node:path';

import type { StartOptions } from './args.ts';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;
/**
 * The longest keep-alive timeout Node.js can keep: it arms an idle socket's timer at the timeout
 * plus its 1 s buffer, and a timer past 2147483647 ms is clamped, with a warning on every answer.
 */
const MAX_TIMER_MS = 2_147_483_647;
const KEEP_ALIVE_BUFFER_MS = 1000;
const MAX_KEEP_ALIVE_TIMEOUT_MS = MAX_TIMER_MS - KEEP_ALIVE_BUFFER_MS;

export function startPort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT)
    throw new Error('a port must be a whole number from 0 to 65535');
  return port;
}

/** A keep-alive timeout in milliseconds, as `next start --keepAliveTimeout` takes one. */
export function startKeepAliveTimeout(value: string): number {
  const timeout = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_KEEP_ALIVE_TIMEOUT_MS)
    throw new Error(
      'a keep-alive timeout must be a whole number of milliseconds from 1 to 2147482647',
    );
  return timeout;
}

export function checkStartOrigin(value: string | undefined): void {
  if (value === undefined) return;
  const origin = new URL(value);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.username !== '' ||
    origin.password !== ''
  ) {
    throw new Error('the public origin must be an HTTP(S) origin without a path or credentials');
  }
}

export function startHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/** Apply defaults only after files, the inherited environment and explicit flags have merged. */
export function startEnvironment(
  options: StartOptions,
  fromFiles: Readonly<Record<string, string>>,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...fromFiles, ...inherited };
  const port = options.port ?? startPort(env['PORT']);
  const hostname = startHostname(options.hostname ?? env['UPWIND_NODE_HOSTNAME'] ?? '0.0.0.0');
  const origin = options.origin ?? env['UPWIND_NODE_ORIGIN'];
  checkStartOrigin(origin);
  const cacheDir = path.resolve(
    options.cacheDir ??
      env['UPWIND_NODE_CACHE_DIR'] ??
      path.join(options.projectDir, '.upwind/node-cache'),
  );
  const keepAliveTimeout =
    options.keepAliveTimeout ??
    (env['UPWIND_NODE_KEEP_ALIVE_TIMEOUT'] === undefined ||
    env['UPWIND_NODE_KEEP_ALIVE_TIMEOUT'] === ''
      ? undefined
      : startKeepAliveTimeout(env['UPWIND_NODE_KEEP_ALIVE_TIMEOUT']));
  return {
    ...env,
    PORT: String(port),
    UPWIND_NODE_HOSTNAME: hostname,
    UPWIND_NODE_CACHE_DIR: cacheDir,
    ...(origin !== undefined && { UPWIND_NODE_ORIGIN: origin }),
    ...(keepAliveTimeout !== undefined && {
      UPWIND_NODE_KEEP_ALIVE_TIMEOUT: String(keepAliveTimeout),
    }),
  };
}
