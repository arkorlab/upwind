import path from 'node:path';
import { parseArgs } from 'node:util';

import { checkStartOrigin, startHostname, startPort } from './environment.ts';

export interface StartOptions {
  readonly projectDir: string;
  readonly port?: number | undefined;
  readonly hostname?: string | undefined;
  readonly origin?: string | undefined;
  readonly cacheDir?: string | undefined;
  readonly envFiles: readonly string[];
}

export type StartRequest =
  | { readonly answer: 'help' | 'version' }
  | { readonly answer: undefined; readonly options: StartOptions };

export function parseStartRequest(args: readonly string[]): StartRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string', short: 'p' },
      hostname: { type: 'string', short: 'H' },
      origin: { type: 'string' },
      'cache-dir': { type: 'string' },
      'env-file': { type: 'string', multiple: true },
    },
  });
  if (values.help === true) return { answer: 'help' };
  if (values.version === true) return { answer: 'version' };
  if (positionals.length > 1) throw new Error('`upwind start` takes at most one directory');
  const projectDir = path.resolve(positionals[0] ?? '.');
  checkStartOrigin(values.origin);
  return {
    answer: undefined,
    options: {
      projectDir,
      ...(values.port !== undefined && { port: startPort(values.port) }),
      ...(values.hostname !== undefined && { hostname: startHostname(values.hostname) }),
      ...(values.origin !== undefined && { origin: values.origin }),
      ...(values['cache-dir'] !== undefined && { cacheDir: path.resolve(values['cache-dir']) }),
      envFiles: (values['env-file'] ?? []).map((file) => path.resolve(file)),
    },
  };
}
