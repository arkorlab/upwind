import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';

import { fakeHost, type FakeHost } from './fake-host.ts';

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
const BUNDLE_BUILD_ID = 'from-the-bundle';
const OUTPUT_DIRECTORY_BUILD_ID = 'from-the-output-directory';
const TOKEN = 'ark_a_token_nothing_may_read';
const HOOK_TIMEOUT_MS = 60_000;
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
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The script itself, by its own path, rather than a shell found on `PATH`: they are executable and
    // carry a shebang, and this is how the suite's harness starts them.
    const child = spawn(path.join(SCRIPTS, name), [], { cwd: appDir, env, detached: true });
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

/**
 * An application that builds without Next.js, and lies about its build id on purpose.
 *
 * `.next/BUILD_ID` says one thing and the bundle says another, so that reading the wrong one is a
 * failure here rather than a fixture whose build id the suite silently gets wrong. Which is which
 * arrives in the environment rather than in this text, so that the text stays a file and not a
 * template.
 */
const BUILD_SCRIPT = String.raw`
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const saw = (name) => name + ': ' + (process.env[name] === undefined ? 'no' : 'YES');
console.log('the build saw ' + saw('ARKOR_API_TOKEN') + ' ' + saw('ARKOR_API_TOKEN_FILE'));

mkdirSync('.next', { recursive: true });
writeFileSync('.next/BUILD_ID', process.env.CHECK_OUTPUT_DIRECTORY_BUILD_ID);

const bytes = Buffer.from('a function\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
mkdirSync('.arkor/blobs', { recursive: true });
writeFileSync('.arkor/blobs/' + sha256, bytes);
writeFileSync(
  '.arkor/bundle.json',
  JSON.stringify({
    v: 1,
    deploymentId: process.env.NEXT_DEPLOYMENT_ID,
    nextVersion: '16.3.6',
    buildId: process.env.CHECK_BUNDLE_BUILD_ID,
    projectDir: '.',
    generatedAt: new Date().toISOString(),
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'RSC',
        varyHeader: 'RSC',
        prefetchHeader: 'Next-Router-Prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'Next-Router-Segment-Prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [
      // First, so that it is the file the host serves and the one the probe prefers: a path carrying the
      // build id is as strong as a file gets, and still not proof of whose deployment answered — the
      // check's page assertions are what hold the probe to asking the page all the same.
      {
        pathname: '/_next/static/' + process.env.CHECK_BUNDLE_BUILD_ID + '/chunk.js',
        blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
        immutable: false,
      },
      {
        pathname: '/_next/static/immutable/' + sha256 + '.js',
        blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
        immutable: true,
      },
    ],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [
          {
            name: 'index.mjs',
            type: 'esm',
            blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
          },
        ],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  }),
);
`;

/**
 * Its `build` is shaped like the one the suite's harness writes (`… && pnpm post-build`), and its
 * `post-build` is its own — which is the case that must not be dropped.
 */
const MANIFEST = {
  name: 'deploy-tests-check-application',
  private: true,
  scripts: {
    build: 'node build.mjs && pnpm post-build',
    'post-build':
      "node -e \"console.log('the fixture post-build ran; it saw ARKOR_API_TOKEN: ' + (process.env.ARKOR_API_TOKEN === undefined ? 'no' : 'YES'))\"",
  },
};

function writeApplication(appDir: string): void {
  mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(appDir, 'build.mjs'), BUILD_SCRIPT);
  // Its own value, for `@next/env` to read and the deployment's environment to be replaced with.
  writeFileSync(path.join(appDir, '.env'), 'OWN=yes\n');
  writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  // A fixture arrives with its own `next`, which is where `@next/env` is resolved from. This one is
  // given the adapter's, linked: that package depends on Next.js and this one deliberately does not,
  // and what is under test here is the reader rather than npm.
  const fromAdapter = createRequire(path.join(REPO, 'packages', 'adapter', 'package.json'));
  symlinkSync(
    path.dirname(fromAdapter.resolve('next/package.json')),
    path.join(appDir, 'node_modules', 'next'),
  );
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

async function main(): Promise<void> {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'upwind-deploy-tests-check-'));
  const appDir = path.join(workDir, 'application');
  mkdirSync(appDir);
  writeApplication(appDir);
  const tokenFile = path.join(workDir, 'token');
  writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const deploymentId = createId(DEPLOYMENT_ID_PREFIX);
  const host = await fakeHost(deploymentId);
  let quiet: FakeHost | undefined;
  const env = {
    ...process.env,
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
        deployedAt - named >= Number(env.ADAPTER_TEST_SETTLE_SECONDS) * MS_PER_SECOND,
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
        unprovenAt - probed >= Number(env.ADAPTER_TEST_SETTLE_SECONDS) * MS_PER_SECOND,
    );
  } finally {
    host.close();
    quiet?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
