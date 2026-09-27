#!/usr/bin/env node
import { type DevRequest, parseDevRequest } from './args.ts';
import { type BuildRequest, parseBuildRequest } from './build/args.ts';
import { runBuild } from './build/run.ts';
import { serveDev } from './dev/serve.ts';
import { supervise } from './dev/supervise.ts';
import { WORKER_ENV, WORKER_PORT_ENV } from './dev/worker-env.ts';
import { ownVersion } from './manifest.ts';

/**
 * `upwind` — the command in front of a Next.js application.
 *
 * `dev` runs the project's development server behind upwind's own front door; `build` runs the
 * project's build with the adapter named. Both are the project's own Next.js: this CLI decides
 * nothing about an application beyond where its platform is.
 *
 * `dev` is one binary with two jobs. Run by a developer it is the supervisor: it forks itself and
 * starts the child again whenever the child asks to be restarted. Run by that supervisor —
 * `UPWIND_DEV_WORKER` set — it is the server. `supervise.ts` says why a restart has to be a new
 * process.
 */

/** What answers for itself before a command names one. */
const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);
const VERSION_FLAGS: ReadonlySet<string> = new Set(['--version', '-v']);

const USAGE = `upwind — the front door of a Next.js application

Usage
  upwind dev [directory]
  upwind build [directory]

Options
  -p, --port <port>      Port to listen on, \`dev\` only (default: $PORT, else 3000)
  -H, --hostname <host>  Hostname to bind, \`dev\` only (default: every interface)
  -v, --version          Print upwind's version
  -h, --help             Print this
      --                 Everything after this is the directory, even \`--help\`

\`upwind dev\` runs the project's own Next.js development server behind upwind, and answers
/__upwind itself: a request for that prefix is never handed to Next.js.

\`upwind build\` runs the project's own \`next build\` with the deployment adapter named, which
writes the deployment bundle under .ppr-cdn/.
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

/** What a command understood of its own arguments, or the usage and an end if it understood none. */
function orFail<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), true);
  }
}

/** The project's own `next build`, with the adapter named; it ends this process as that one ended. */
async function build(rest: readonly string[]): Promise<void> {
  const request: BuildRequest = orFail(() => parseBuildRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  await runBuild(request.options);
}

async function dev(rest: readonly string[], argv: readonly string[]): Promise<void> {
  const request: DevRequest = orFail(() => parseDevRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  if (process.env[WORKER_ENV] === '1') {
    // Read once, and then gone: everything the project runs — `next.config`, the application, whatever
    // either of them spawns — inherits this environment, and an `upwind dev` started from inside it
    // would take itself for a worker of a supervisor that is not watching, on a port it was not asked
    // for.
    Reflect.deleteProperty(process.env, WORKER_ENV);
    Reflect.deleteProperty(process.env, WORKER_PORT_ENV);
    await serveDev(request.options);
    return;
  }
  // The child is this same file, with the same arguments: one place says what a run is.
  await supervise(import.meta.filename, argv);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  // Before a command, these are the whole of what was asked. After one they are that command's own
  // options, and each command's parser reads them where it can see what else was given — which is
  // also what makes a directory named `--help` reachable, after a `--`.
  if (command === undefined || HELP_FLAGS.has(command)) {
    await answer('help');
    return;
  }
  if (VERSION_FLAGS.has(command)) {
    await answer('version');
    return;
  }
  if (command === 'build') {
    await build(rest);
    return;
  }
  if (command !== 'dev') {
    fail(`unknown command \`${command}\`; the commands are \`dev\` and \`build\``, true);
  }
  await dev(rest, argv);
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
