import path from 'node:path';
import { parseArgs } from 'node:util';

import { MAX_PORT } from '../dev/listen.ts';

/**
 * What `upwind preview` understands: a directory whose build to serve, the port to serve it on,
 * each `--env-file` whose variables join the secrets its Functions are given, and `--check`, which
 * asks the build once and ends rather than serving it.
 *
 * Strict, like the other commands' parsers: a flag this does not implement is an error rather than
 * a preview that ignored it.
 */

export interface PreviewOptions {
  readonly projectDir: string;
  /** Where the site is served: `0` for a port the system hands out. */
  readonly port: number;
  /** Files of secrets, in the order given; a later one wins. */
  readonly envFiles: readonly string[];
  /** Ask the build once and end, rather than serve it. */
  readonly check: boolean;
}

export type PreviewRequest =
  | { readonly answer: 'help' | 'version' }
  | { readonly answer: undefined; readonly options: PreviewOptions };

/** Where a preview serves when nothing names a port, as `upwind dev` and `next start` do. */
const DEFAULT_PORT = 3000;
const PORT_SPELLING = /^\d+$/u;

/**
 * The port asked for: `--port`, then `PORT`, then 3000 — but a check, which nothing outside asks,
 * takes any free one unless `--port` names one.
 */
function portOf(value: string | undefined, check: boolean): number {
  const asked = value ?? (check ? undefined : process.env['PORT']);
  if (asked === undefined) {
    return check ? 0 : DEFAULT_PORT;
  }
  // `Number` would take `1e3`, `0x10` and a string of spaces: a port is written the way it is read.
  const port = PORT_SPELLING.test(asked) ? Number(asked) : NaN;
  if (!Number.isSafeInteger(port) || port > MAX_PORT) {
    throw new Error(
      `a port has to be a whole number from 0 to ${MAX_PORT}, and \`${asked}\` is not`,
    );
  }
  return port;
}

export function parsePreviewRequest(args: readonly string[]): PreviewRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string', short: 'p' },
      'env-file': { type: 'string', multiple: true },
      check: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    return { answer: 'help' };
  }
  if (values.version === true) {
    return { answer: 'version' };
  }
  if (positionals.length > 1) {
    throw new Error(
      `\`upwind preview\` takes at most one directory, and was given ${positionals.length}`,
    );
  }
  const check = values.check === true;
  return {
    answer: undefined,
    options: {
      projectDir: path.resolve(positionals[0] ?? '.'),
      port: portOf(values.port, check),
      envFiles: (values['env-file'] ?? []).map((file) => path.resolve(file)),
      check,
    },
  };
}
