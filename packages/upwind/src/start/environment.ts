import path from 'node:path';

import type { StartOptions } from './args.ts';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;

export function startPort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT)
    throw new Error('a port must be a whole number from 0 to 65535');
  return port;
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
  return {
    ...env,
    PORT: String(port),
    UPWIND_NODE_HOSTNAME: hostname,
    UPWIND_NODE_CACHE_DIR: cacheDir,
    ...(origin !== undefined && { UPWIND_NODE_ORIGIN: origin }),
  };
}
