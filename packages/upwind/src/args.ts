import path from 'node:path';
import { parseArgs } from 'node:util';

import { MAX_PORT } from './dev/listen.ts';
import type { DevOptions } from './dev/serve.ts';

/**
 * What `upwind dev` understands.
 *
 * Deliberately a short list. `next dev`'s other flags — `--experimental-https`, `--inspect`,
 * `--turbopack` — are not quietly accepted and ignored: `parseArgs` in strict mode refuses an option
 * this does not implement, and the message says what is understood. The bundler is left to Next.js's
 * own default, which is Turbopack, and which is also the only one the adapter can build.
 *
 * `--help` and `--version` are options here rather than tokens looked for in the arguments, so that a
 * flag that swallowed them — `--port --help`, where the port is what is actually missing — is the
 * error it is instead of a usage message that answers a question nobody asked.
 */

const DEFAULT_PORT = 3000;

export interface DevRequest {
  /** What was asked for instead of a server, if anything. */
  readonly answer: 'help' | 'version' | undefined;
  readonly options: DevOptions;
}

/** Digits, and nothing else: what the message below promises, rather than what `Number` would take. */
const PORT_SPELLING = /^\d+$/u;

function portOf(value: string | undefined): number {
  const asked = value ?? process.env['PORT'];
  if (asked === undefined || asked === '') {
    return DEFAULT_PORT;
  }
  // `Number` would take `1e3`, `0x10` and a string of spaces, and bind 1000, 16 and a port the kernel
  // picked. A port is written the way it is read.
  const port = PORT_SPELLING.test(asked) ? Number(asked) : NaN;
  if (!Number.isSafeInteger(port) || port > MAX_PORT) {
    throw new Error(
      `a port has to be a whole number from 0 to ${MAX_PORT}, and \`${asked}\` is not`,
    );
  }
  return port;
}

/**
 * The hostname as a socket takes it: an IPv6 literal, not the bracketed form a URL writes.
 *
 * `[::1]` is what a developer copies out of a browser's address bar, and what `listen` answers with
 * `ENOTFOUND`, since it resolves a hostname rather than parsing a URL.
 */
function hostnameOf(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function answerOf(values: {
  readonly help?: boolean;
  readonly version?: boolean;
}): DevRequest['answer'] {
  if (values.help === true) {
    return 'help';
  }
  return values.version === true ? 'version' : undefined;
}

export function parseDevRequest(args: readonly string[]): DevRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      hostname: { type: 'string', short: 'H' },
      port: { type: 'string', short: 'p' },
      version: { type: 'boolean', short: 'v' },
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
    answer: answerOf(values),
    options: {
      // Resolved here so every later use — the adapter's resolution, the config watch, Next.js's own
      // `dir` — is the same absolute path.
      projectDir: path.resolve(positionals[0] ?? '.'),
      hostname: hostnameOf(values.hostname),
      port: portOf(values.port),
    },
  };
}
