#!/usr/bin/env node
import { type DevRequest, parseDevRequest } from './args.ts';
import { serveDev } from './dev/serve.ts';
import { supervise } from './dev/supervise.ts';
import { WORKER_ENV } from './dev/worker-env.ts';
import { ownVersion } from './manifest.ts';

/**
 * `upwind` — the command in front of a Next.js development server.
 *
 * One binary, two jobs. Run by a developer it is the supervisor: it forks itself and starts the child
 * again whenever the child asks to be restarted. Run by that supervisor — `UPWIND_DEV_WORKER` set —
 * it is the server. `supervise.ts` says why a restart has to be a new process.
 */

/** What answers for itself before a command names one. */
const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);
const VERSION_FLAGS: ReadonlySet<string> = new Set(['--version', '-v']);

const USAGE = `upwind — the front door of a Next.js development server

Usage
  upwind dev [directory]

Options
  -p, --port <port>      Port to listen on (default: $PORT, else 3000)
  -H, --hostname <host>  Hostname to bind (default: every interface)
  -v, --version          Print upwind's version
  -h, --help             Print this

\`upwind dev\` runs the project's own Next.js development server behind upwind, and answers
/__upwind itself: a request for that prefix is never handed to Next.js.
`;

function fail(message: string, withUsage: boolean): never {
  console.error(`upwind: ${message}`);
  if (withUsage) {
    console.error(`\n${USAGE}`);
  }
  process.exit(1);
}

async function answer(what: 'help' | 'version'): Promise<void> {
  if (what === 'help') {
    console.log(USAGE);
    return;
  }
  console.log((await ownVersion()) ?? 'unknown');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // Before a command, these are the whole of what was asked. After one they are that command's own
  // options, and `parseDevRequest` reads them where it can see what else was given.
  if (command === undefined || HELP_FLAGS.has(command)) {
    await answer('help');
    return;
  }
  if (VERSION_FLAGS.has(command)) {
    await answer('version');
    return;
  }
  if (command !== 'dev') {
    fail(`unknown command \`${command}\`; the only one is \`dev\``, true);
  }
  let request: DevRequest;
  try {
    request = parseDevRequest(rest);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), true);
  }
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  if (process.env[WORKER_ENV] === '1') {
    await serveDev(request.options);
    return;
  }
  // The child is this same file, with the same arguments: one place says what a run is.
  await supervise(import.meta.filename, process.argv.slice(2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? `upwind: ${error.message}` : error);
  // Left rather than returned from: a run that failed after Next.js had started holds whatever
  // Next.js still holds, and nothing that was asked for is waiting on it. `next dev` ends the same
  // way for the same reason.
  process.exit(1);
}
