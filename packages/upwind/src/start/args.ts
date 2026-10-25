import path from 'node:path';
import { parseArgs } from 'node:util';

export interface StartOptions {
  readonly projectDir: string;
  readonly port: number;
  readonly hostname: string;
  readonly origin?: string | undefined;
  readonly cacheDir: string;
  readonly envFiles: readonly string[];
}

export type StartRequest =
  | { readonly answer: 'help' | 'version' }
  | { readonly answer: undefined; readonly options: StartOptions };

const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;

function portOf(value: string): number {
  if (value === '') return DEFAULT_PORT;
  const port = /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT)
    throw new Error('a port must be a whole number from 0 to 65535');
  return port;
}

function checkOrigin(value: string | undefined): void {
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
    throw new Error('`--origin` must be an HTTP(S) origin without a path or credentials');
  }
}

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
  const port = portOf(values.port ?? process.env['PORT'] ?? String(DEFAULT_PORT));
  const originValue = values.origin ?? process.env['UPWIND_NODE_ORIGIN'];
  checkOrigin(originValue);
  const host = values.hostname ?? process.env['UPWIND_NODE_HOSTNAME'] ?? '0.0.0.0';
  return {
    answer: undefined,
    options: {
      projectDir,
      port,
      hostname: host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host,
      origin: originValue,
      cacheDir: path.resolve(
        values['cache-dir'] ??
          process.env['UPWIND_NODE_CACHE_DIR'] ??
          path.join(projectDir, '.upwind/node-cache'),
      ),
      envFiles: (values['env-file'] ?? []).map((file) => path.resolve(file)),
    },
  };
}
