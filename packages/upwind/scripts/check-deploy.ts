import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { compareCodeUnits } from '@stayingupwind/core/util';

import { createCloudflareClient } from '../src/deploy/cloudflare/client.ts';
import {
  type AccountScope,
  accountSubdomain,
  listDeployments,
  listScripts,
} from '../src/deploy/cloudflare/workers.ts';
import { deploymentLabel, projectNames } from '../src/deploy/names.ts';
import { BUNDLE_PATH } from '../src/deploy/preflight.ts';
import { READINESS_PATH } from '../src/deploy/workers/protocol.ts';
import { CI_PROJECT, everything, leftOf, staleProjects, sweep } from './check-deploy-account.ts';
import {
  BLOG_PAGE,
  buildAll,
  CHECKS,
  cliOf,
  command,
  CONFIG_FILE,
  homeOf,
  say,
  succeed,
  type Version,
  VERSIONS,
} from './check-deploy-build.ts';

/**
 * `upwind deploy` against a real Cloudflare account, end to end: what
 * `.github/workflows/deploy-cloudflare.yaml` runs, in two halves.
 *
 * `build` (`check-deploy-build.ts`), in a job that holds no credentials: three builds of
 * `fixtures/next-minimal`, each installed from packs of this checkout and built for a deploy.
 *
 * `run`, here, in the job that holds them. The three builds are deployed to one project, one after
 * another, with what each deployment has to show checked between them: the site served, a page of
 * each kind the fixture has, what must stay closed, the previous deployment's files kept, rollback
 * and forward again, retention, a deploy of what is live already changing nothing — and the project
 * destroyed at the end, whatever happened before, and checked gone. Projects earlier runs left are
 * destroyed first.
 *
 * Nothing here prints a credential: the token and the account's id are read from the environment,
 * checked present, and handed on in it, to the client and to the CLI.
 */

/** Where a leftover project is given its name, to be destroyed. */
const CLEANUP_DIR = 'cleanup';
const SECOND_MS = 1000;
/** How long a check waits for a site to show what it should: a deployment takes a moment to reach every place. */
const SETTLE_MS = 90_000;
const POLL_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;
/** How much of an answer a failed check quotes. */
const EXCERPT = 200;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const STALE_KEY_BYTES = 36;
/** What `/api/wasm` adds up, in its two WebAssembly forms. */
const WASM_SUMS = { compiled: 3, instantiated: 7 };
/** A static file a page loads, as its markup names it. */
const STATIC_FILE = /["'](\/_next\/static\/[^"'?]+\.js(?:\?[^"']*)?)["']/gu;

interface Build {
  readonly version: Version;
  readonly dir: string;
  readonly deploymentId: string;
  /** What its home page says. */
  readonly home: string;
}

interface Run {
  readonly scope: AccountScope;
  readonly project: string;
  readonly subdomain: string;
  readonly site: URL;
  /** The CLI as the projects installed it. */
  readonly cli: string;
  readonly builds: Readonly<Record<Version, Build>>;
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, POLL_MS);
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Each version, installed again from its lockfile where the artifact came without its modules. */
async function buildsIn(dir: string, project: string): Promise<Record<Version, Build>> {
  const builds: Partial<Record<Version, Build>> = {};
  for (const version of VERSIONS) {
    const at = path.join(dir, version);
    if (!(await exists(path.join(at, 'node_modules')))) {
      succeed('npm', ['ci', '--no-audit', '--no-fund'], at);
    }
    const config = { deploy: { name: project, checks: CHECKS } };
    await writeFile(path.join(at, CONFIG_FILE), `${JSON.stringify(config, undefined, 2)}\n`);
    const bundle = JSON.parse(await readFile(path.join(at, BUNDLE_PATH), 'utf8')) as {
      readonly deploymentId: string;
    };
    builds[version] = {
      version,
      dir: at,
      deploymentId: bundle.deploymentId,
      home: homeOf(version),
    };
  }
  return builds as Record<Version, Build>;
}

/** The CLI, run on a project directory; what it exited with, and its output where asked. */
function upwind(
  run: Run,
  args: readonly string[],
  capture = false,
): { readonly status: number; readonly stdout: string } {
  say(`upwind ${args.join(' ')}`);
  return command(process.execPath, [run.cli, ...args], { cwd: run.builds.v1.dir, capture });
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

async function ask(
  url: URL,
  headers: Readonly<Record<string, string>> = {},
): Promise<Answer | undefined> {
  try {
    const response = await fetch(url, {
      headers: { 'cache-control': 'no-cache', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } catch {
    return undefined;
  }
}

/** Ask until `holds` says the answer is the one wanted, or the wait is over; the last answer. */
async function eventually(
  what: string,
  url: URL,
  holds: (answer: Answer) => boolean,
): Promise<Answer> {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const answer = await ask(url);
    if (answer !== undefined && holds(answer)) {
      return answer;
    }
    if (Date.now() >= until) {
      const said =
        answer === undefined
          ? 'no answer'
          : `${String(answer.status)}: ${answer.text.slice(0, EXCERPT)}`;
      throw new Error(
        `${what}: ${url.pathname} did not answer as it should within ${String(SETTLE_MS / SECOND_MS)} s (${said})`,
      );
    }
    await pause();
  }
}

function readinessOf(
  answer: Answer,
): { readonly deploymentId?: unknown; readonly versionId?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(answer.text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The site serving the build: the edge says so, and the home page says which it is. */
async function expectServing(run: Run, build: Build): Promise<void> {
  await eventually(
    `${build.version} live`,
    new URL(READINESS_PATH, run.site),
    (answer) =>
      answer.status === HTTP_OK && readinessOf(answer)?.deploymentId === build.deploymentId,
  );
  await eventually(
    `${build.version}'s home page`,
    run.site,
    (answer) => answer.status === HTTP_OK && answer.text.includes(build.home),
  );
  say(`${build.version} (${build.deploymentId}) is served`);
}

/** The static files the home page loads. */
async function staticFiles(run: Run): Promise<URL[]> {
  const home = await eventually('the home page', run.site, (answer) => answer.status === HTTP_OK);
  const files = [...home.text.matchAll(STATIC_FILE)].map(
    (match) => new URL(match[1] ?? '/', run.site),
  );
  assert.ok(files.length > 0, 'the home page loads no static file');
  return files;
}

async function expectStatic(files: readonly URL[], what: string): Promise<void> {
  for (const file of files) {
    await eventually(what, file, (answer) => answer.status === HTTP_OK);
  }
}

function json(answer: Answer): unknown {
  return JSON.parse(answer.text);
}

/** A page of each kind the fixture has, answered by the deployment. */
async function expectPages(run: Run): Promise<void> {
  const page = (pathname: string): URL => new URL(pathname, run.site);
  // `getStaticProps`: a Pages Router prerender, served from the bucket.
  await eventually(
    'a Pages prerender',
    page('/hello'),
    (answer) => answer.status === HTTP_OK && answer.text.includes('hello'),
  );
  // A page of `generateStaticParams`, through the middleware (`proxy.js`), which marks it.
  await eventually('a prerender through the middleware', page(BLOG_PAGE), (answer) => {
    return (
      answer.status === HTTP_OK &&
      answer.text.includes('hello first') &&
      answer.headers.get('x-upwind-fixture') === BLOG_PAGE
    );
  });
  // `getServerSideProps`: rendered by the Function on each request.
  await eventually(
    'a server-rendered page',
    page('/ssr'),
    (answer) => answer.status === HTTP_OK && answer.text.includes('request time'),
  );
  // A Pages API route, and an App route handler with WebAssembly modules in its Function.
  await eventually(
    'an API route',
    page('/api/ping'),
    (answer) => answer.status === HTTP_OK && isDeepEqual(json(answer), { body: null }),
  );
  await eventually(
    'a route handler with WebAssembly',
    page('/api/wasm'),
    (answer) => answer.status === HTTP_OK && isDeepEqual(json(answer), WASM_SUMS),
  );
  say('every kind of page answers');
}

function isDeepEqual(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

/** A deployment's Functions answer nobody but the edge, and the agent nobody without this run's key. */
async function expectClosed(run: Run, build: Build): Promise<void> {
  const label = deploymentLabel(build.deploymentId);
  for (const role of ['app', 'mw']) {
    const direct = new URL(`https://${run.project}-${label}-${role}.${run.subdomain}.workers.dev/`);
    const answer = await ask(direct);
    assert.ok(
      answer === undefined || (answer.status !== HTTP_OK && !answer.text.includes(build.home)),
      `${direct.host} answered ${String(answer?.status)} on workers.dev`,
    );
  }
  const health = new URL(
    `https://${projectNames(run.project).agent}.${run.subdomain}.workers.dev/v1/health`,
  );
  const stale = randomBytes(STALE_KEY_BYTES).toString('base64url');
  for (const headers of [{ authorization: `Bearer ${stale}` }, {}]) {
    const answer = await ask(health, headers);
    assert.equal(
      answer?.status,
      HTTP_UNAUTHORIZED,
      `the agent answered ${String(answer?.status)} to a key it does not hold`,
    );
  }
  say('the Functions and the agent are closed');
}

/** The account's Workers of the project, by name. */
async function projectWorkers(run: Run): Promise<Set<string>> {
  const scripts = await listScripts(run.scope);
  return new Set(
    scripts.map((script) => script.id).filter((name) => name.startsWith(`${run.project}-`)),
  );
}

/** What the edge serves now, as the versions and their shares, and the project's Workers. */
async function snapshot(run: Run): Promise<string> {
  const [live] = (await listDeployments(run.scope, projectNames(run.project).edge)) ?? [];
  const shares = (live?.versions ?? []).map(
    (share) => `${share.version_id}=${String(share.percentage)}`,
  );
  const workers = [...(await projectWorkers(run))];
  return JSON.stringify({
    shares: shares.toSorted(compareCodeUnits),
    workers: workers.toSorted(compareCodeUnits),
  });
}

function deploy(run: Run, build: Build, extra: readonly string[] = []): void {
  const { status } = upwind(run, ['deploy', build.dir, '--prebuilt', ...extra]);
  assert.equal(status, 0, `deploying ${build.version} exited ${String(status)}`);
}

function rollback(run: Run, to: Build): number {
  return upwind(run, ['rollback', run.builds.v1.dir, '--to', to.deploymentId]).status;
}

/** Every step a project goes through, in order; each throws where it fails. */
async function scenario(run: Run): Promise<void> {
  const { v1, v2, v3 } = run.builds;
  deploy(run, v1);
  await expectServing(run, v1);
  const v1Files = await staticFiles(run);
  await expectStatic(v1Files, 'a static file');
  await expectPages(run);
  await expectClosed(run, v1);

  deploy(run, v2);
  await expectServing(run, v2);
  // The pages of v1 still open in a browser load its files, which v2's deployment kept.
  await expectStatic(v1Files, "v1's static file, after v2");
  const listed = upwind(run, ['deployments', v1.dir], true);
  assert.equal(listed.status, 0, `upwind deployments exited ${String(listed.status)}`);
  for (const build of [v1, v2]) {
    assert.ok(
      listed.stdout.includes(build.deploymentId),
      `upwind deployments does not list ${build.version}`,
    );
  }

  assert.equal(rollback(run, v1), 0, 'rolling back to v1 failed');
  await expectServing(run, v1);
  assert.equal(rollback(run, v2), 0, 'rolling forward to v2 failed');
  await expectServing(run, v2);

  deploy(run, v3, ['--keep', '1']);
  await expectServing(run, v3);
  const v1Prefix = `${run.project}-${deploymentLabel(v1.deploymentId)}-`;
  const left = [...(await projectWorkers(run))].filter((name) => name.startsWith(v1Prefix));
  assert.deepEqual(left, [], 'v1 kept its Functions past --keep 1');
  assert.notEqual(
    rollback(run, v1),
    0,
    'rolling back to v1, whose Functions are gone, was not refused',
  );
  await expectServing(run, v3);

  const before = await snapshot(run);
  deploy(run, v3);
  assert.equal(await snapshot(run), before, 'deploying what is live already changed the account');
  await expectServing(run, v3);
}

/** Destroy the project, and see that nothing named for it is left. */
async function destroyAndCheck(run: Run, dir: string, project: string): Promise<void> {
  const { status } = command(process.execPath, [run.cli, 'destroy', dir, '--yes'], { cwd: dir });
  assert.equal(status, 0, `destroying ${project} exited ${String(status)}`);
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const left = await leftOf(run.scope, project);
    if (left.length === 0) {
      say(`${project} is gone`);
      return;
    }
    if (Date.now() >= until) {
      throw new Error(`${project} left ${left.join(', ')} behind`);
    }
    await pause();
  }
}

/** A directory that names the leftover project, beside the installed CLI and adapter. */
async function projectDirFor(run: Run, project: string): Promise<string> {
  const dir = path.join(path.dirname(run.builds.v1.dir), CLEANUP_DIR, project);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'upwind-ci', private: true })}\n`,
  );
  await writeFile(
    path.join(dir, CONFIG_FILE),
    `${JSON.stringify({ deploy: { name: project } })}\n`,
  );
  await rm(path.join(dir, 'node_modules'), { force: true });
  await symlink(
    path.join(run.builds.v1.dir, 'node_modules'),
    path.join(dir, 'node_modules'),
    'dir',
  );
  return dir;
}

/** Destroy what earlier runs left, as `upwind destroy` would, and what a destroy could not reach. */
async function cleanUp(run: Run): Promise<void> {
  const all = await everything(run.scope);
  for (const project of staleProjects(all, run.project, Date.now())) {
    say(`destroying ${project}, left by an earlier run`);
    try {
      await destroyAndCheck(run, await projectDirFor(run, project), project);
    } catch (error) {
      // What a destroy cannot take — a namespace no mark records any longer, an empty bucket with
      // no mark in it — is taken here; what is left after that is said, and left for a person.
      console.warn(`check-deploy: ${error instanceof Error ? error.message : String(error)}`);
      await sweep(run.scope, project);
    }
  }
}

function credentials(): { readonly apiToken: string; readonly accountId: string } {
  const apiToken = process.env['CLOUDFLARE_API_TOKEN'];
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
  // Named, never printed.
  assert.ok(apiToken !== undefined && apiToken !== '', 'CLOUDFLARE_API_TOKEN is not set');
  assert.ok(accountId !== undefined && accountId !== '', 'CLOUDFLARE_ACCOUNT_ID is not set');
  return { apiToken, accountId };
}

async function runChecks(dir: string, project: string): Promise<void> {
  assert.ok(CI_PROJECT.test(project), `${project} is not a ci-<run>-<attempt> name`);
  const { apiToken, accountId } = credentials();
  const scope = { client: createCloudflareClient({ apiToken }), accountId };
  const subdomain = await accountSubdomain(scope);
  assert.ok(subdomain !== undefined, 'the account has no workers.dev subdomain');
  const builds = await buildsIn(dir, project);
  const run: Run = {
    scope,
    project,
    subdomain,
    site: new URL(`https://${projectNames(project).edge}.${subdomain}.workers.dev/`),
    cli: cliOf(builds.v1.dir),
    builds,
  };
  await cleanUp(run);
  let failure: unknown;
  try {
    await scenario(run);
  } catch (error) {
    failure = error;
  }
  try {
    await destroyAndCheck(run, builds.v1.dir, project);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error('the check failed', { cause: failure });
  }
  say('every check passed');
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      dir: { type: 'string' },
      project: { type: 'string' },
    },
    strict: true,
  });
  const [phase] = positionals;
  if (phase === 'build' && values.out !== undefined) {
    await buildAll(path.resolve(values.out));
    return;
  }
  if (phase === 'run' && values.dir !== undefined && values.project !== undefined) {
    await runChecks(path.resolve(values.dir), values.project);
    return;
  }
  throw new Error(
    'usage: check-deploy.ts build --out <dir> | run --dir <dir> --project <ci-run-attempt>',
  );
}

await main();
