#!/usr/bin/env node
import type { DevRequest } from './args.ts';
import type { BuildRequest } from './build/args.ts';
import { WORKER_ENV, WORKER_PORT_ENV } from './dev/worker-env.ts';
import { ownVersion } from './manifest.ts';

/**
 * `upwind` — the command in front of a Next.js application.
 *
 * `dev` runs the project's development server behind upwind's own front door; `build` runs the
 * project's build with the adapter named; `preview` serves that build on this machine as a
 * deployment serves it; `deploy` builds it for, and deploys it to, a Cloudflare account of the
 * developer's own, and `destroy` deletes what `deploy` made there. Each runs the
 * project's own Next.js: this CLI decides nothing about an application beyond where its platform
 * is.
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
  upwind start [directory]
  upwind preview [directory]
  upwind deploy [directory]
  upwind deployments [directory]
  upwind rollback [directory] [--to <deployment>] [--env-file <file>]...
  upwind destroy [directory] --yes

Options
  -p, --port <port>      Port to listen on, \`dev\`, \`preview\` and \`start\` (default: $PORT, else 3000)
  -H, --hostname <host>  Hostname to bind, \`dev\` and \`start\` (default: every interface)
      --target <target> Build for \`cloudflare\` (default) or native \`node\`
      --origin <url>    Trusted public origin, \`start\` only
      --cache-dir <dir> Persistent native cache directory, \`start\` only
      --remote-ai        Enable declared Workers AI bindings using your Cloudflare account, \`dev\` only
      --check            Ask the build once and stop, rather than serve it, \`preview\` only
      --dry-run          Say what a deploy would do and change nothing, \`deploy\` only
      --build-only       Build for a deploy and stop, \`deploy\` only
      --prebuilt         Deploy what --build-only built, \`deploy\` only
      --env-file <file>  Secrets for \`deploy\`, \`preview\` and \`start\`; CRON_SECRET,
                         for \`rollback\`; may repeat
      --keep <n>         Deployments kept to roll back to, \`deploy\` only (default: 5)
      --message <text>   What the deployment is noted as, \`deploy\` only
      --reset-cache-key  Give the runtime cache a new key, \`deploy\` only
      --to <deployment>  The deployment to go back to, \`rollback\` only (default: the one before)
      --yes              Delete everything a deploy made, \`destroy\` only
      --include-storage  And the storage deploy.storage names, with its data, \`destroy\` only
  -v, --version          Print upwind's version
  -h, --help             Print this
      --                 Everything after this is the directory, even \`--help\`

\`upwind dev\` runs the project's own Next.js development server behind upwind, and answers
/__upwind itself: a request for that prefix is never handed to Next.js.

\`upwind build\` runs the project's own \`next build\` with the deployment adapter named, which
writes the deployment bundle under .arkor/. On Vercel (VERCEL set, NEXT_ADAPTER_PATH not) it
names no adapter and writes no bundle: the build there is Vercel's.

\`upwind build --target=node\` writes a relocatable native artifact under .arkor/node/.
\`upwind start\` serves that artifact with Node.js and its own persistent local cache. It
needs no Cloudflare account or runtime. The generated server.mjs can also run directly.

\`upwind preview\` serves the bundle \`upwind build\` wrote on this machine, as a deployment of
it is served: the edge in front, the runtime cache behind it, and the build's Functions. It
builds nothing and deploys nothing, and listens on the loopback alone. \`--check\` asks every
route and file of the build once, and the paths deploy.checks names, and ends.

\`upwind deploy\` builds the project and deploys it to a Cloudflare account of your own: the
edge in front, the runtime cache behind it, each deployment's Functions as Workers of their own,
and the edge switched to the new deployment once it answers. It reads CLOUDFLARE_API_TOKEN and
CLOUDFLARE_ACCOUNT_ID from the environment, and the project's \`deploy\` settings from
upwind.config.ts. \`upwind deployments\` lists the deployments it made, \`upwind rollback\` gives
the edge back to one of them, and \`upwind destroy\` deletes everything it made. One deploy or
rollback of a project runs at a time.
`;

function fail(message: string): never {
  console.error(`upwind: ${message}`);
  console.error(`\n${USAGE}`);
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
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** The project's own `next build`, with the adapter named; it ends this process as that one ended. */
async function build(rest: readonly string[]): Promise<void> {
  const { parseBuildRequest } = await import('./build/args.ts');
  const request: BuildRequest = orFail(() => parseBuildRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runBuild } = await import('./build/run.ts');
  await runBuild(request.options);
}

async function start(rest: readonly string[]): Promise<void> {
  const { parseStartRequest } = await import('./start/args.ts');
  const request = orFail(() => parseStartRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runStart } = await import('./start/command.ts');
  process.exitCode = await runStart(request.options);
}

/**
 * `upwind preview`. Its stack loaded only when asked for: it runs the bundler's parser and
 * Miniflare, which no other command needs. The Cloudflare credentials come out of the environment
 * as they do for `deploy`, before the project's configuration runs: a preview reaches no account,
 * and hands its Functions nothing of one.
 */
async function preview(rest: readonly string[]): Promise<void> {
  const { takeCredentials } = await import('./deploy/credentials.ts');
  takeCredentials();
  const { parsePreviewRequest } = await import('./preview/args.ts');
  const request = orFail(() => parsePreviewRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runPreview } = await import('./preview/command.ts');
  // Ended rather than returned from: a stack let go may still hold a socket or a timer of its own
  // for a moment, and nothing is waiting on it. Miniflare's exit hook stops its runtime as it ends.
  process.exit(await runPreview(request.options));
}

/**
 * `upwind deploy`. The credentials come out of the environment first, before anything of the
 * project's runs — its configuration and its build both do (`deploy/credentials.ts`).
 */
async function deploy(rest: readonly string[]): Promise<void> {
  const { takeCredentials } = await import('./deploy/credentials.ts');
  const credentials = takeCredentials();
  const { parseDeployRequest } = await import('./deploy/args.ts');
  const request = orFail(() => parseDeployRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runDeploy } = await import('./deploy/command.ts');
  process.exitCode = await runDeploy(request.options, credentials);
}

/** `upwind deployments`, with the credentials taken out of the environment as `deploy` takes them. */
async function deployments(rest: readonly string[]): Promise<void> {
  const { takeCredentials } = await import('./deploy/credentials.ts');
  const credentials = takeCredentials();
  const { parseDeploymentsRequest } = await import('./deploy/args.ts');
  const request = orFail(() => parseDeploymentsRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runDeployments } = await import('./deploy/deployments.ts');
  process.exitCode = await runDeployments(request.options, credentials);
}

/** `upwind rollback`, with the credentials taken out of the environment as `deploy` takes them. */
async function rollback(rest: readonly string[]): Promise<void> {
  const { takeCredentials } = await import('./deploy/credentials.ts');
  const credentials = takeCredentials();
  const { parseRollbackRequest } = await import('./deploy/args.ts');
  const request = orFail(() => parseRollbackRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runRollback } = await import('./deploy/rollback.ts');
  process.exitCode = await runRollback(request.options, credentials);
}

/** `upwind destroy`, with the credentials taken out of the environment as `deploy` takes them. */
async function destroy(rest: readonly string[]): Promise<void> {
  const { takeCredentials } = await import('./deploy/credentials.ts');
  const credentials = takeCredentials();
  const { parseDestroyRequest } = await import('./deploy/args.ts');
  const request = orFail(() => parseDestroyRequest(rest));
  if (request.answer !== undefined) {
    await answer(request.answer);
    return;
  }
  const { runDestroy } = await import('./deploy/destroy.ts');
  process.exitCode = await runDestroy(request.options, credentials);
}

async function dev(rest: readonly string[], argv: readonly string[]): Promise<void> {
  const { parseDevRequest } = await import('./args.ts');
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
    const { serveDev } = await import('./dev/serve.ts');
    await serveDev(request.options);
    return;
  }
  // The child is this same file, with the same arguments: one place says what a run is.
  const { supervise } = await import('./dev/supervise.ts');
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
  if (command === 'preview') {
    await preview(rest);
    return;
  }
  if (command === 'start') {
    await start(rest);
    return;
  }
  if (command === 'deploy') {
    await deploy(rest);
    return;
  }
  if (command === 'deployments') {
    await deployments(rest);
    return;
  }
  if (command === 'rollback') {
    await rollback(rest);
    return;
  }
  if (command === 'destroy') {
    await destroy(rest);
    return;
  }
  if (command !== 'dev') {
    fail(
      `unknown command \`${command}\`; the commands are \`dev\`, \`build\`, \`start\`, \`preview\`, \`deploy\`, \`deployments\`, \`rollback\` and \`destroy\``,
    );
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
