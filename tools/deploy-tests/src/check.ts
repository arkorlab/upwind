import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';

import {
  BUNDLE_BUILD_ID,
  OUTPUT_DIRECTORY_BUILD_ID,
  writeApplication,
} from './check-application.ts';
import { fakeHost, type FakeHost } from './fake-host.ts';
import { AFTER_SERVED_MS } from './hook.ts';

/**
 * The three hooks, run for real against a host that is not one.
 *
 * Everything else about this tool is checked by the type checker or by a run against a platform, and a
 * run against a platform needs a credential, a project and a built Next.js — so what breaks quietly is
 * what neither would notice: a shell contract (what reaches standard output, which variables a
 * fixture's own scripts can see, which file the build id comes from) and an HTTP protocol (the order of
 * the calls, and what is read out of each answer).
 *
 * So: a fake application, a fake host, and the real `scripts/e2e-*.sh`. No credential, no network, a
 * few seconds. `pnpm check:deploy-tests`, and CI runs it.
 */

const SCRIPTS = path.join(import.meta.dirname, '..', 'scripts');
const REPO = path.join(import.meta.dirname, '..', '..', '..');
const TOKEN = 'ark_a_token_nothing_may_read';
const HOOK_TIMEOUT_MS = 60_000;
/**
 * How much of a suite's hook the scenario that runs one out leaves the deployment, beyond what is kept
 * for after it is served: the fake build and the upload, and a few seconds of waiting.
 */
const HOOK_RUN_OUT_MS = 8000;
/** About a megabyte of each stream, which is what `execFile` would have held. */
const MAX_CAPTURED = 1_000_000;
const DEPLOY_HOOK = 'e2e-deploy.sh';
const MS_PER_SECOND = 1000;

/**
 * A stream of a child process, held to a size.
 *
 * What it says is read to decide things and to explain a failure, and neither wants all of a build that
 * has gone wrong in a loop — which `execFile` bounded for us and a stream of one's own does not. The far
 * end is not stopped for it: a hook that will not stop is what the timeout is for. The rest is dropped
 * as it arrives, and the tail says so, so that nobody reads a truncated log as a complete one.
 */
function keptTo(said: string, chunk: Buffer): string {
  if (said.length >= MAX_CAPTURED) {
    return said;
  }
  const grown = `${said}${chunk.toString()}`;
  return grown.length <= MAX_CAPTURED ? grown : `${grown.slice(0, MAX_CAPTURED)}\n… (truncated)`;
}

interface HookFailureOptions extends ErrorOptions {
  /** What the hook had written to standard error by the time it failed. */
  readonly said: string;
}

/** A hook that did not finish well, with whatever it had said by then. */
class HookFailureError extends Error {
  readonly said: string;

  constructor(message: string, options: HookFailureOptions) {
    super(message, options);
    this.name = 'HookFailureError';
    this.said = options.said;
  }
}

function orNothing(said: string | undefined): string {
  return said !== undefined && said.trim() !== '' ? said.trimEnd() : '(nothing)';
}

/** Whatever the hook had written to standard error by the time it failed. */
function saidBy(error: unknown): string {
  return orNothing(error instanceof HookFailureError ? error.said : undefined);
}

/**
 * One hook, run to the end or ended — and with it everything it started.
 *
 * Bounded because the deploy hook's own patience is fifteen minutes of a host that never becomes ready.
 * That is the right answer against a real host and the wrong shape of failure here: a readiness check
 * that asks this fake host something it will never say would hold the whole run open for it. Eight seconds
 * is the whole of this file against a warm store, the longest hook in it a few, so a minute is failure
 * rather than slowness.
 *
 * `detached`, so that the hook and everything below it are one process group and the bound can end all
 * of it. The shell is only the shell: the deployment is a `node` grandchild of it, and a signal to the
 * shell alone leaves that one running — measured, still polling a host that had gone away two seconds
 * after the check had reported the timeout and exited. `SIGKILL` for the same reason; there is nothing
 * left for it to wind down, and the file it writes is appended to as it goes.
 */
function bounded(
  name: string,
  appDir: string,
  env: NodeJS.ProcessEnv,
  via?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The script itself, by its own path, rather than a shell found on `PATH`: they are executable and
    // carry a shebang, and this is how the suite's harness starts them. Or through `via`, a Node.js
    // script handed that path, which starts it as a harness of its own would.
    const script = path.join(SCRIPTS, name);
    const options = { cwd: appDir, env, detached: true };
    const child =
      via === undefined
        ? spawn(script, [], options)
        : spawn(process.execPath, [via, script], options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout = keptTo(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keptTo(stderr, chunk)));
    let expired = false;
    const bound = setTimeout(() => {
      expired = true;
      if (child.pid !== undefined) {
        // The group, not the process: `-pid` is how a group is named, and `detached` made this one its
        // leader. Killing it twice is what happens if it has already gone, and that is not an error.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already over.
        }
      }
    }, HOOK_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(bound);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(bound);
      if (expired) {
        const seconds = String(HOOK_TIMEOUT_MS / MS_PER_SECOND);
        reject(
          new HookFailureError(
            `was still running after ${seconds}s, so it and its children were killed`,
            { said: stderr },
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new HookFailureError(`exited ${String(code)}`, { said: stderr }));
    });
  });
}

/** What a marker line carries after its prefix, or nothing when it is absent or carries nothing. */
function markerAfter(line: string | undefined, prefix: string): string | undefined {
  return line !== undefined && line.startsWith(prefix) && line.length > prefix.length
    ? line.slice(prefix.length)
    : undefined;
}

function holds(said: string, held: boolean): void {
  console.log(`  ${held ? 'ok  ' : 'NOT '} ${said}`);
  if (!held) {
    process.exitCode = 1;
  }
}

/**
 * A host that gives each deployment a URL of its own: at once, a moment late, and with a path the suite
 * cannot be handed. Each is a host of its own, closed here whatever happened.
 */
async function ownUrlScenarios(
  deploymentId: string,
  appDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const hosts: FakeHost[] = [];
  try {
    // A host that gives the deployment a URL of its own: the suite is sent there, the probe asks there,
    // and nothing is settled, since no other deployment answers at that URL.
    const own = await fakeHost(deploymentId, 'moves', 'at once');
    hosts.push(own);
    const onItsOwn = await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(own.port)}`,
    });
    holds(
      "a deployment's own URL is the one the suite is given",
      own.ownPort !== undefined &&
        onItsOwn.stdout.trim() === `http://127.0.0.1:${String(own.ownPort)}`,
    );
    holds('and the one the probe asked', own.probedOn() === own.ownPort);
    holds(
      'with nothing settled, since no other deployment answers there',
      !onItsOwn.stderr.includes('letting the host settle'),
    );

    // A host that writes the URL a moment after it says the deployment is live: waited for, not missed.
    const late = await fakeHost(deploymentId, 'moves', 'late');
    hosts.push(late);
    const lateOwn = await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(late.port)}`,
    });
    holds(
      'a URL the host gives only a moment after the deployment is live is still the one used',
      late.ownPort !== undefined &&
        lateOwn.stdout.trim() === `http://127.0.0.1:${String(late.ownPort)}`,
    );

    // A deployment whose own URL answers while the project still answers with the one before: its
    // own URL is the question, and it is not held up by the project's.
    const ahead = await fakeHost(deploymentId, 'moves', 'ahead of the project');
    hosts.push(ahead);
    const onItsOwnFirst = await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(ahead.port)}`,
    });
    holds(
      'a deployment served at its own URL is not held up by what the project answers with',
      ahead.ownPort !== undefined &&
        onItsOwnFirst.stdout.trim() === `http://127.0.0.1:${String(ahead.ownPort)}`,
    );
    holds('and the probe asked its own URL, not the project', ahead.probedOn() === ahead.ownPort);

    // A project still running the deployment before this one: the finalize is refused until that run
    // ends, and is made again until it is taken, rather than failing this fixture for the one before.
    const busy = await fakeHost(deploymentId, 'moves', 'none', 2);
    hosts.push(busy);
    const afterTheOther = await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(busy.port)}`,
    });
    holds(
      "a project's run still under way is waited for, and this deployment then deploys",
      afterTheOther.stdout.trim() === `http://127.0.0.1:${String(busy.port)}` &&
        afterTheOther.stderr.includes('another run of the project is still under way'),
    );

    // One that does not end before the suite's hook would: the wait ends where the hook's time does,
    // and says what it was waiting for, rather than being cut off by the harness in the middle of it.
    const stuck = await fakeHost(deploymentId, 'moves', 'none', Number.MAX_SAFE_INTEGER);
    hosts.push(stuck);
    let outlasted: unknown;
    const waitedFrom = performance.now();
    try {
      await bounded(DEPLOY_HOOK, appDir, {
        ...env,
        ARKOR_API_URL: `http://127.0.0.1:${String(stuck.port)}`,
        NEXT_E2E_TEST_TIMEOUT: String(AFTER_SERVED_MS + HOOK_RUN_OUT_MS),
      });
    } catch (error) {
      outlasted = error;
    }
    // Half the hook's time at least, rather than all of it: the hook's clock is the wall clock, which
    // steps, and this one is not. A wait cut short to nothing still fails it.
    const waitedFor = performance.now() - waitedFrom;
    holds(
      "a run that outlasts the suite's hook is waited for as long as the hook lasts, and said so",
      outlasted instanceof HookFailureError &&
        outlasted.said.includes("the suite's hook timeout came first") &&
        waitedFor >= HOOK_RUN_OUT_MS / 2 &&
        waitedFor < HOOK_TIMEOUT_MS / 2,
    );

    // A URL that needs a path to reach the deployment cannot be handed to the suite, which joins its own
    // paths to an origin: refused, by what is wrong with it.
    const pathed = await fakeHost(deploymentId, 'moves', 'with a path');
    hosts.push(pathed);
    let refusedPath: unknown;
    try {
      await bounded(DEPLOY_HOOK, appDir, {
        ...env,
        ARKOR_API_URL: `http://127.0.0.1:${String(pathed.port)}`,
      });
    } catch (error) {
      refusedPath = error;
    }
    holds(
      "a deployment's own URL with a path is refused, not cut down to its host",
      refusedPath instanceof HookFailureError && refusedPath.said.includes('more than an origin'),
    );
  } finally {
    for (const host of hosts) {
      host.close();
    }
  }
}

/**
 * A suite of a `next.config.ts` that Node.js loads itself is built with that loader, as Next.js's own CI
 * builds it; any other suite is built without, as every application is.
 */
async function nativeConfigScenario(
  deploymentId: string,
  appDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const host = await fakeHost(deploymentId);
  try {
    await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
      JEST_SUITE_NAME:
        'deploy:e2e:test/e2e/app-dir/next-config-ts-native-ts/export-default/next-config-ts-export-default-esm.test.ts',
    });
    const build = readFileSync(path.join(appDir, '.adapter-build.log'), 'utf8');
    holds(
      "a suite of a next.config Node.js loads itself is built with Node.js's loader",
      build.includes('__NEXT_NODE_NATIVE_TS_LOADER_ENABLED: YES'),
    );
    holds('and with types transformed', build.includes('the build saw types transformed: YES'));
  } finally {
    host.close();
  }
}

/** The shell's `NODE_OPTIONS` without the one a native-TS suite's build is given (`e2e-deploy.sh`). */
function ordinaryNodeOptions(options: string | undefined): string | undefined {
  const kept = (options ?? '')
    .split(/\s+/u)
    .filter((option) => option !== '' && option !== '--experimental-transform-types');
  return kept.length === 0 ? undefined : kept.join(' ');
}

/** Whether two environments hold the same names with the same values, in whatever order. */
function sameEnvironment(
  environment: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  const sorted = (of: Record<string, string>): string =>
    JSON.stringify(Object.entries(of).toSorted(([a], [b]) => a.localeCompare(b)));
  return sorted(environment) === sorted(expected);
}

/** A harness as Next.js's is one: it starts the hook it is handed, with a suite's variable on top. */
const HARNESS = `
import { spawnSync } from 'node:child_process';

const [hook] = process.argv.slice(2);
const env = { ...process.env, SUITE_ONLY: 'via-the-parent' };
const result = spawnSync(hook, [], { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`;

/**
 * A suite's own variables (`createNext({ env })`), which its harness hands the hook on top of its own
 * environment: the deployment is given them, over the application's `.env` files, and nothing else of
 * what the hook was handed.
 */
async function suiteEnvScenario(
  deploymentId: string,
  appDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!existsSync('/proc/self/environ')) {
    console.log(
      'skipped: a suite’s own variables are read off /proc, which this machine has none of',
    );
    return;
  }
  const host = await fakeHost(deploymentId);
  try {
    await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
      SUITE_ONLY: 'from-the-suite',
      OWN: 'the-suites-over-the-files',
      // What Next.js's harness sets in its own process as it runs: its, not the suite's. Next.js sets
      // the stack size in any process that has loaded its native bindings, the harness among them.
      TEST_FILE_PATH: '/next.js/test/e2e/some.test.ts',
      NEXT_TEST_JOB: '1',
      RUST_MIN_STACK: '8388608',
      // The suite's, and too short to go up as a secret: Next.js's deploy mode gives it to every
      // fixture kept as a directory.
      NEXT_PRIVATE_LOCAL_DEV: '1',
      // What no `.env` file gives a deployment either: a Function that started with it skips its own.
      __NEXT_PROCESSED_ENV: 'true',
    });
    holds(
      "a suite's own variables reach the deployment, over the application's .env files, and the harness's do not",
      sameEnvironment(host.environment(), {
        NEXT_PRIVATE_LOCAL_DEV: '1',
        OWN: 'the-suites-over-the-files',
        SUITE_ONLY: 'from-the-suite',
      }),
    );
    holds(
      'and each goes up as a secret, but one too short to be one',
      JSON.stringify(host.secrets().toSorted((a, b) => a.localeCompare(b))) ===
        JSON.stringify(['OWN', 'SUITE_ONLY']),
    );
  } finally {
    host.close();
  }
  // And as Next.js's harness starts the hook — from its own process, which names no pid — read off
  // the hook's parent.
  const parent = await fakeHost(deploymentId);
  const harness = path.join(path.dirname(appDir), 'harness.mjs');
  writeFileSync(harness, HARNESS);
  try {
    await bounded(
      DEPLOY_HOOK,
      appDir,
      {
        ...env,
        ARKOR_API_URL: `http://127.0.0.1:${String(parent.port)}`,
        ADAPTER_TEST_HARNESS_PID: undefined,
      },
      harness,
    );
    holds(
      "and read off the hook's parent where no harness is named",
      sameEnvironment(parent.environment(), { OWN: 'yes', SUITE_ONLY: 'via-the-parent' }),
    );
  } finally {
    parent.close();
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'upwind-deploy-tests-check-'));
  const appDir = path.join(workDir, 'application');
  mkdirSync(appDir);
  writeApplication(appDir);
  const tokenFile = path.join(workDir, 'token');
  writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const deploymentId = createId(DEPLOYMENT_ID_PREFIX);
  const host = await fakeHost(deploymentId);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // An ordinary suite's, whatever the shell running the check says: a suite name decides how its
    // fixture is built (`e2e-deploy.sh`), and the check of that names its own. So do the two settings
    // that build turns on, which the check has to see the hook add, and a hook's own time, which the
    // scenario that runs it out sets.
    JEST_SUITE_NAME: 'deploy:e2e:test/e2e/app-dir/app-simple-routes/app-simple-routes.test.ts',
    __NEXT_NODE_NATIVE_TS_LOADER_ENABLED: undefined,
    NODE_OPTIONS: ordinaryNodeOptions(process.env['NODE_OPTIONS']),
    NEXT_E2E_TEST_TIMEOUT: undefined,
    ADAPTER_TEST_HOOK_STARTED_MS: undefined,
    ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
    ARKOR_API_TOKEN_FILE: tokenFile,
    ADAPTER_TEST_PROJECT_ID: 'p',
    // Short, but long enough that the wait cannot fit inside the probe: the fake host answers in
    // milliseconds, so most of these two seconds are still owed when the probe gets through.
    ADAPTER_TEST_SETTLE_SECONDS: '2',
    ADAPTER_DIR: REPO,
    NEXT_DEPLOYMENT_ID: deploymentId,
    CHECK_BUNDLE_BUILD_ID: BUNDLE_BUILD_ID,
    CHECK_OUTPUT_DIRECTORY_BUILD_ID: OUTPUT_DIRECTORY_BUILD_ID,
  };
  // The harness the hooks are started from, as Next.js's starts them: a process of their own
  // environment, which a suite's variables are read against (`suite-env.ts`). Everything the check
  // hands a hook is then the harness's, and nothing the suite's, but where a scenario adds some.
  const harness = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], {
    env,
    stdio: 'ignore',
  });
  harness.on('error', (error) => {
    console.error(`the stand-in harness failed: ${error.message}`);
    process.exitCode = 1;
  });
  if (harness.pid === undefined) {
    throw new Error('the stand-in harness did not start');
  }
  env['ADAPTER_TEST_HARNESS_PID'] = String(harness.pid);
  let quiet: FakeHost | undefined;
  const hook = async (name: string): Promise<{ stdout: string; stderr: string }> => {
    try {
      return await bounded(name, appDir, env);
    } catch (error) {
      // Rethrown with the hook's own account of itself in the message, which a child process that
      // failed otherwise arrives without: Node prints its `stderr` truncated. Everything worth knowing
      // is there — the build, the API calls the deployment made, what it waited for, why it gave up.
      throw new Error(
        `${name} ${error instanceof Error ? error.message : String(error)}. It said:\n${saidBy(error)}`,
        { cause: error },
      );
    }
  };
  try {
    const deployed = await hook(DEPLOY_HOOK);
    const deployedAt = performance.now();
    const logs = await hook('e2e-logs.sh');
    await hook('e2e-cleanup.sh');
    const build = readFileSync(path.join(appDir, '.adapter-build.log'), 'utf8');

    holds(
      'the deploy hook prints the URL, and only the URL',
      deployed.stdout.trim() === `http://127.0.0.1:${String(host.port)}`,
    );
    holds(
      'and its account of the deployment goes to standard error, which is what reaches the suite',
      deployed.stderr.includes('answers with this deployment'),
    );
    holds(
      'a page that still names the deployment before is waited for, since the file could not say',
      deployed.stderr.includes('still names another deployment') &&
        deployed.stderr.includes('names this deployment'),
    );
    const named = host.namedAt();
    holds(
      'and the settle is waited out in full from there, before the suite starts',
      // Measured from the page first naming this deployment to the hook finishing, which nothing but the
      // wait fills: the hook's own build comes before it, so a build slower than the settle cannot pass
      // for it, and a log line without the wait behind it would not either.
      deployed.stderr.includes('letting the host settle') &&
        named !== undefined &&
        deployedAt - named >= Number(env['ADAPTER_TEST_SETTLE_SECONDS']) * MS_PER_SECOND,
    );
    holds(
      "the registration carries the bundle's own build id",
      host.registered() === BUNDLE_BUILD_ID,
    );
    holds(
      "and the marker the harness reads is not the output directory's",
      !build.includes(OUTPUT_DIRECTORY_BUILD_ID),
    );
    holds(
      "the deployment's environment is the application's own value, and only it",
      JSON.stringify(host.environment()) === JSON.stringify({ OWN: 'yes' }),
    );
    holds('the blobs the host asked for were uploaded', host.uploaded().length === 1);
    holds('and nothing was asked of it out of order', host.refusals().length === 0);
    holds('the build saw no token', build.includes('ARKOR_API_TOKEN: no'));
    holds(
      "and, for any other suite, not Node.js's own loader of next.config",
      build.includes('__NEXT_NODE_NATIVE_TS_LOADER_ENABLED: no') &&
        build.includes('the build saw types transformed: no'),
    );
    holds('nor the file holding it', build.includes('ARKOR_API_TOKEN_FILE: no'));
    holds("the application's own post-build ran", build.includes('the fixture post-build ran'));
    holds('and it saw no token either', build.includes('it saw ARKOR_API_TOKEN: no'));
    const bundle = JSON.parse(readFileSync(path.join(appDir, '.arkor', 'bundle.json'), 'utf8')) as {
      staticFiles: { pathname: string; immutable: boolean }[];
    };
    // Computed from what the build wrote and then compared with what the hook said: the marker is
    // derived or it is not, and an assertion that expects a constant cannot tell the difference. Both
    // the flag and the path, for the reason the hook gives beside it.
    const immutable = bundle.staticFiles.some(
      (file) => file.immutable && file.pathname.includes('/_next/static/immutable/'),
    )
      ? '1'
      : '0';
    const markers = logs.stdout.split('\n');
    holds(
      'the logs hook leads with a build id and a deployment id',
      // Named *and* non-empty: a hook that printed `BUILD_ID: ` with nothing after it is the failure
      // reading the id from the bundle exists to prevent, and the harness would take the empty string.
      markerAfter(markers[0], 'BUILD_ID: ') !== undefined &&
        markerAfter(markers[1], 'DEPLOYMENT_ID: ') !== undefined,
    );
    holds(
      "and with the immutable-assets marker the bundle's own files add up to",
      markers[2] === `NEXT_SUPPORTS_IMMUTABLE_ASSETS: ${immutable}`,
    );
    holds('which, for this application, is yes', immutable === '1');

    /*
     * Last, because it builds the application again over the files read above.
     *
     * A deployment that fails has to fail the hook and say why where the suite's log will show it —
     * which, for a harness that quotes only standard output and does not call the logs hook when setup
     * failed, is standard error. A project the host does not have is the cheapest failure to arrange: it
     * is the first thing the tool asks for, and the refusal comes back before anything is uploaded.
     */
    let refused: unknown;
    try {
      await bounded(DEPLOY_HOOK, appDir, { ...env, ADAPTER_TEST_PROJECT_ID: 'q' });
    } catch (error) {
      refused = error;
    }
    holds('a deployment that fails fails the hook', refused instanceof HookFailureError);
    holds(
      'and says why on standard error',
      refused instanceof HookFailureError && refused.said.includes('HTTP 404 (not_found)'),
    );

    // A settle that is not a number of seconds is refused before anything is asked of the host, and
    // without being repeated: it arrives as the other host settings do, and none of them is echoed.
    let unsettled: unknown;
    try {
      await bounded(DEPLOY_HOOK, appDir, { ...env, ADAPTER_TEST_SETTLE_SECONDS: 'soon' });
    } catch (error) {
      unsettled = error;
    }
    holds(
      'a settle that is not a number of seconds is refused, by name',
      unsettled instanceof HookFailureError &&
        unsettled.said.includes('ADAPTER_TEST_SETTLE_SECONDS must be a whole number of seconds'),
    );
    holds(
      'and is not repeated back',
      unsettled instanceof HookFailureError && !unsettled.said.includes('soon'),
    );

    // A host whose page names nobody: the probe's shared file is all the evidence there is, and the
    // deployment goes ahead on it, settling from there and saying so — not waiting out a deadline for a
    // mark that route will never carry.
    quiet = await fakeHost(deploymentId, 'names nobody');
    const unproven = await bounded(DEPLOY_HOOK, appDir, {
      ...env,
      ARKOR_API_URL: `http://127.0.0.1:${String(quiet.port)}`,
    });
    const unprovenAt = performance.now();
    const probed = quiet.probedAt();
    holds(
      'a page that names nobody leaves the probe as the evidence, and says so',
      unproven.stdout.trim() === `http://127.0.0.1:${String(quiet.port)}` &&
        unproven.stderr.includes('no page names a deployment either'),
    );
    holds(
      'and the settle is still waited out in full, from after the probe',
      probed !== undefined &&
        unprovenAt - probed >= Number(env['ADAPTER_TEST_SETTLE_SECONDS']) * MS_PER_SECOND,
    );

    await ownUrlScenarios(deploymentId, appDir, env);
    await nativeConfigScenario(deploymentId, appDir, env);
    await suiteEnvScenario(deploymentId, appDir, env);
  } finally {
    harness.kill();
    host.close();
    quiet?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
