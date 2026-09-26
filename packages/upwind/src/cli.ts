#!/usr/bin/env node
import { parseDevOptions } from './args.ts';
import { serveDev } from './dev/serve.ts';
import { supervise, WORKER_ENV } from './dev/supervise.ts';
import { ownVersion } from './manifest.ts';

/**
 * `upwind` — the command in front of a Next.js development server.
 *
 * One binary, two jobs. Run by a developer it is the supervisor: it forks itself and starts the child
 * again whenever the child asks to be restarted. Run by that supervisor — `UPWIND_DEV_WORKER` set —
 * it is the server. `supervise.ts` says why a restart has to be a new process.
 */

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log((await ownVersion()) ?? 'unknown');
    return;
  }
  const [command, ...rest] = argv;
  if (command !== 'dev') {
    fail(`unknown command \`${command ?? ''}\`; the only one is \`dev\``, true);
  }
  let options;
  try {
    options = parseDevOptions(rest);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), true);
  }
  if (process.env[WORKER_ENV] === '1') {
    await serveDev(options);
    return;
  }
  // The child is this same file, with the same arguments: one place says what a run is.
  await supervise(import.meta.filename, argv);
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
