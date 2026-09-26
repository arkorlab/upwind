import path from 'node:path';
import { parseArgs } from 'node:util';

import type { DevOptions } from './dev/serve.ts';

/**
 * What `upwind dev` understands.
 *
 * Deliberately a short list. `next dev`'s other flags — `--experimental-https`, `--inspect`,
 * `--turbopack` — are not quietly accepted and ignored: `parseArgs` in strict mode refuses an option
 * this does not implement, and the message says what is understood. The bundler is left to Next.js's
 * own default, which is Turbopack, and which is also the only one the adapter can build.
 */

const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;

function portOf(value: string | undefined): number {
  const asked = value ?? process.env['PORT'];
  if (asked === undefined || asked === '') {
    return DEFAULT_PORT;
  }
  const port = Number(asked);
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT) {
    throw new Error(
      `a port has to be a whole number from 0 to ${MAX_PORT}, and \`${asked}\` is not`,
    );
  }
  return port;
}

export function parseDevOptions(args: readonly string[]): DevOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      hostname: { type: 'string', short: 'H' },
      port: { type: 'string', short: 'p' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new Error(
      `\`upwind dev\` takes at most one directory, and was given ${positionals.length}`,
    );
  }
  return {
    // Resolved here so every later use — the adapter's resolution, the config watch, Next.js's own
    // `dir` — is the same absolute path.
    projectDir: path.resolve(positionals[0] ?? '.'),
    hostname: values.hostname,
    port: portOf(values.port),
  };
}
