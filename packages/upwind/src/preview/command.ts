import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { constants } from 'node:os';
import path from 'node:path';

import {
  appFunctions,
  type DeploymentBundle,
  deploymentBundleSchema,
} from '@stayingupwind/core/bundle';
import type { CronJob } from '@stayingupwind/core/cron';
import { checkStack, type LocalStack, startStack, type StackOptions } from '@stayingupwind/local';

import { authLayout } from '../auth/layout.ts';
import { readSecrets, reservedNames } from '../deploy/env.ts';
import { AUTH_SECRETS, BUNDLE_PATH, carriesCacheHost } from '../deploy/preflight.ts';
import { shippedStackScripts } from '../deploy/shipped.ts';
import { CRON_SECRET } from '../deploy/workers/protocol.ts';
import type { PreviewOptions } from './args.ts';
import { failedChecks } from './checks.ts';
import { type RunningCronJobs, startCronJobs } from './crons.ts';
import { type PreviewSettings, readPreviewSettings } from './settings.ts';

/**
 * `upwind preview`: the build `upwind build` left, served on this machine as a deployment of it is
 * served — the edge in front, the runtime cache behind it, the prefetch Worker, and the build's
 * Functions, under one Miniflare (`@stayingupwind/local`). It builds nothing, as `next start`
 * builds nothing, and deploys nothing: it listens on this machine's loopback alone.
 *
 * What a deployment is given that the build does not say comes from the project's `deploy` section,
 * as a deploy reads it: the secrets, the nonce, the hostnames the site is reached on, and the paths
 * a deploy asks before it switches. What a deploy gives that a preview does not yet — storage,
 * images transformed, cron jobs fired — is said rather than left to be found.
 */

/** What a run waits on and is told of, where a test runs it: in place of a signal, the stack. */
export interface PreviewIo {
  /** Ends a serving preview, as a signal does. */
  readonly stopped?: Promise<unknown> | undefined;
  /** Told the stack once it serves. */
  readonly serving?: ((stack: LocalStack) => void) | undefined;
}

/** The signals a serving preview stops on. */
const SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];
/** What a process a signal ends exits with, as a shell reports it: this, and the signal's number. */
const SIGNAL_EXIT_BASE = 128;
/** How long a stopped preview waits for its stack to be let go before it ends regardless. */
const DISPOSE_MS = 10_000;
/** How long a port is asked whether something answers on it already. */
const PROBE_MS = 1000;

interface Build {
  readonly bundleDir: string;
  readonly bundle: DeploymentBundle;
}

/** The build in the project, or nothing where no build is there to serve. */
async function readBuild(projectDir: string): Promise<Build | undefined> {
  const file = path.join(projectDir, BUNDLE_PATH);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = deploymentBundleSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${BUNDLE_PATH} in ${projectDir} is no bundle this upwind reads (${parsed.error.message}); build it again with \`upwind build\``,
    );
  }
  return { bundleDir: path.dirname(file), bundle: parsed.data };
}

/**
 * Whether something answers on the port at `localhost` already — a development server, say, which
 * a bind to the loopback alone would not run into on every system.
 */
function answering(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: 'localhost', port, timeout: PROBE_MS });
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.once('connect', () => {
      done(true);
    });
    socket.once('timeout', () => {
      done(false);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/** What a preview serves otherwise than a deployment would, or than the project may expect. */
async function warningsOf(
  options: PreviewOptions,
  build: Build,
  settings: PreviewSettings,
  secrets: ReadonlyMap<string, string>,
): Promise<string[]> {
  const { projectDir, crons } = options;
  const warnings: string[] = [];
  for (const [name, spec] of appFunctions(build.bundle)) {
    if (!(await carriesCacheHost(build.bundleDir, spec))) {
      warnings.push(
        `the ${name} Function was built without the runtime cache's host, so every cache read is a miss; build it again with \`upwind build\``,
      );
    }
  }
  if (settings.storage.length > 0) {
    warnings.push(
      `deploy.storage names ${settings.storage.join(', ')}, and a preview binds no storage yet: the Functions find none of it`,
    );
  }
  const jobs = build.bundle.crons?.length ?? 0;
  if (!crons && jobs > 0) {
    warnings.push(
      `the build declares ${String(jobs)} cron ${jobs === 1 ? 'job' : 'jobs'}, which a preview fires only with --crons`,
    );
  }
  if (crons && jobs === 0) {
    warnings.push('--crons is given, and the build declares no cron job to fire');
  }
  if (settings.images) {
    warnings.push(
      'deploy.images is set, and a preview transforms no image: each is answered as it is',
    );
  }
  const signsIn = authLayout(projectDir) !== undefined;
  if (signsIn && AUTH_SECRETS.every((name) => (secrets.get(name) ?? '') === '')) {
    warnings.push(
      `the project signs users in, and none of ${AUTH_SECRETS.join(', ')} is among the secrets with a value; unless its auth configuration names its secret itself, sign-in will refuse to answer — name one in deploy.secrets or an --env-file`,
    );
  }
  if (secrets.has('PORT')) {
    warnings.push(
      'PORT is among the secrets, and a preview gives its Functions the port it serves on instead',
    );
  }
  return warnings;
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * A stop a serving preview is asked for by a signal. While the stack is still starting, a signal
 * ends the process at once — Miniflare's exit hook stops its runtime as the process exits; once it
 * serves, the first ends the wait, for the stack to be let go, and a second ends the process at once.
 */
function signalStop(): { readonly asked: Promise<void>; serving(): void; release(): void } {
  const asked = Promise.withResolvers<undefined>();
  const state = { serving: false, stopping: false };
  const handlers = SIGNALS.map((signal) => {
    const handler = (): void => {
      if (!state.serving || state.stopping) {
        process.exit(SIGNAL_EXIT_BASE + constants.signals[signal]);
      }
      state.stopping = true;
      asked.resolve(undefined);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    asked: asked.promise,
    serving: () => {
      state.serving = true;
    },
    release: () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  };
}

/** The stack let go, within a time: a process that ends regardless stops its runtime as it ends. */
async function disposed(stack: LocalStack): Promise<void> {
  const { promise: late, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(resolve, DISPOSE_MS, undefined);
  try {
    await Promise.race([stack.dispose(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a serving preview the paths a deploy asks, and say which fail — beside the wait for a stop
 * rather than before it, so that a stop does not wait on them: it ends the asking.
 */
async function warnOfChecks(
  site: URL,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const failures = await failedChecks(site, paths, { signal });
  for (const failure of failures) {
    console.warn(`upwind: ${failure}, which a deploy would not switch to`);
  }
}

/** The build's cron jobs a serving preview fires (`--crons`), and the secret each is sent. */
interface CronFiring {
  readonly jobs: readonly CronJob[];
  readonly secret: string | undefined;
}

/** Fire the build's cron jobs on their schedules at the site, saying when the first fires. */
function firingCrons(site: URL, firing: CronFiring): RunningCronJobs {
  const running = startCronJobs({ jobs: firing.jobs, site, secret: firing.secret });
  const [first] = running.next.toSorted((a, b) => a.at - b.at);
  const count = firing.jobs.length;
  const when =
    first === undefined
      ? 'though no schedule of them comes round again'
      : `the first on "${first.schedule}", at ${new Date(first.at).toISOString()}`;
  const jobs = count === 1 ? 'cron job on its schedule' : 'cron jobs on their schedules';
  console.log(`upwind: firing ${String(count)} ${jobs}, in UTC — ${when}`);
  return running;
}

/** Serve until stopped; what the run exits with. */
async function serve(
  stackOptions: StackOptions,
  settings: PreviewSettings,
  io: PreviewIo,
  crons: CronFiring | undefined,
): Promise<number> {
  const signals = io.stopped === undefined ? signalStop() : undefined;
  let stack: LocalStack;
  try {
    stack = await startStack({ ...stackOptions, signals: 'caller' });
  } catch (error) {
    signals?.release();
    throw new Error(
      `the preview did not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const asking = new AbortController();
  let fired: RunningCronJobs | undefined;
  try {
    signals?.serving();
    console.log(`upwind: serving ${stack.deploymentId} at ${stack.url.href} (Ctrl-C to stop)`);
    fired = crons === undefined ? undefined : firingCrons(stack.url, crons);
    const checked = warnOfChecks(stack.url, settings.checks, asking.signal);
    io.serving?.(stack);
    await (io.stopped ?? signals?.asked);
    asking.abort();
    await checked;
  } finally {
    asking.abort();
    // Before the stack goes: no job fires on a stack being let go, and none under way is waited on.
    await fired?.stop();
    await disposed(stack);
    signals?.release();
  }
  return 0;
}

/** Ask the build once, as a deploy asks it and as every deployment's edge has to answer it. */
async function check(stackOptions: StackOptions, settings: PreviewSettings): Promise<number> {
  let stack: LocalStack;
  try {
    // Miniflare's own handling of the signals: a check stopped part way exits as one that failed.
    stack = await startStack(stackOptions);
  } catch (error) {
    throw new Error(
      `the preview did not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    const paths = await failedChecks(stack.url, settings.checks);
    const { checked, failures, skipped } = await checkStack(stack, {});
    for (const { path: asked, reason } of skipped) {
      console.log(`upwind: ${asked}: not judged, ${reason}`);
    }
    for (const failure of paths) {
      console.error(`upwind: ${failure}`);
    }
    for (const { path: asked, reason } of failures) {
      console.error(`upwind: ${asked}: ${reason}`);
    }
    console.log(
      `upwind: ${stack.deploymentId}: ${String(checked - failures.length)} of ${String(checked)} answered as deployed; ${String(settings.checks.length - paths.length)} of ${String(settings.checks.length)} deploy.checks answered`,
    );
    return paths.length === 0 && failures.length === 0 ? 0 : 1;
  } catch (error) {
    // The stack itself failed the check — rather than an answer it judged.
    console.error(
      `upwind: ${stack.deploymentId}: the check could not finish: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    await disposed(stack);
  }
}

/** What `upwind preview` exits with. */
export async function runPreview(options: PreviewOptions, io: PreviewIo = {}): Promise<number> {
  const build = await readBuild(options.projectDir);
  if (build === undefined) {
    console.error(
      `upwind: ${BUNDLE_PATH} is not in ${options.projectDir}; build the project first, with \`upwind build\``,
    );
    return 1;
  }
  const settings = await readPreviewSettings(options.projectDir);
  // Read as a deploy reads them, and refused as a deploy refuses them: a preview of a project
  // whose deploy would be refused would serve what no deployment of it will.
  const secrets = await readSecrets({
    files: options.envFiles,
    names: settings.secrets,
    env: process.env,
    reserved: reservedNames(settings.storage.map((name) => ({ name }))),
  });
  if (options.port !== 0 && (await answering(options.port))) {
    console.error(
      `upwind: something answers on port ${String(options.port)} already; serve on another with --port`,
    );
    return 1;
  }
  const warnings = await warningsOf(options, build, settings, secrets);
  for (const warning of warnings) {
    console.warn(`upwind: ${warning}`);
  }
  const stackOptions: StackOptions = {
    bundleDir: build.bundleDir,
    port: options.port,
    env: Object.fromEntries(secrets),
    hostnames: settings.hostnames,
    cspNonce: settings.cspNonce,
    scripts: await shippedStackScripts(),
    log,
  };
  if (options.check) {
    return check(stackOptions, settings);
  }
  const jobs = build.bundle.crons ?? [];
  const crons =
    options.crons && jobs.length > 0 ? { jobs, secret: secrets.get(CRON_SECRET) } : undefined;
  return serve(stackOptions, settings, io, crons);
}
