import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';

import {
  type Expected,
  FIXTURE_COVERAGE,
  type FixtureCoverage,
  type FixtureName,
} from './coverage.ts';

/**
 * Builds real applications with real Next.js versions, and holds each build to what the adapter
 * says it does.
 *
 * `packages/adapter/scripts/check-patches.ts` answers most of the same question far more cheaply,
 * by applying each rewrite to the files of a published package. Three patches are out of its reach
 * because they rewrite what `next build` *writes* rather than what Next.js ships —
 * `turbopack-runtime`, `wasm-loader`, `vercel-og` — and no amount of reading a tarball produces a
 * Turbopack runtime. Those need a build, which is this.
 *
 * It is also the only thing that checks the other half of the claim: that each patch still finds
 * its file *in a bundle*. A rewrite can apply perfectly to a module no build ever loads, and the
 * `instrumentation` patch's target was exactly that until this was written — it matched Next.js's
 * ESM copy too, which no Function has ever bundled.
 *
 * Each fixture declares the patches a build of it must apply. A patch that stops firing is the
 * failure worth catching: the build still succeeds, the bundle still uploads, and the Function
 * fails at the first request that needs what was not rewritten.
 */

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');
const ADAPTER = path.join(ROOT, 'packages', 'adapter', 'dist', 'index.js');
const REGISTRY = 'https://registry.npmjs.org';
const MANIFEST = 'package.json';
const MINUTE_MS = 60_000;
/** 15 minutes: a fixture builds in a couple on a cold npm cache, and a hung one takes for ever. */
const BUILD_TIMEOUT_MS = 900_000;
/** 64 MiB. `next build` is talkative, and Rolldown repeats a plugin's error once per bundle. */
const OUTPUT_LIMIT = 67_108_864;
/** How much of a failed command's output is worth showing when nothing better can be found in it. */
const TAIL_LINES = 20;
/** The tags whose meaning is "whatever it is today", which is what the matrix means to check. */
const TAGS = new Set(['beta', 'canary', 'latest', 'rc']);
/** Where `next build` leaves what the adapter wrote. */
const OUT_DIR = '.ppr-cdn';
/**
 * npm, as something `execFile` can start without a shell: its own JavaScript, run by this Node.
 *
 * The name on `PATH` is a shell script on Unix and a `.cmd` on Windows, and Node will not spawn the
 * second without a shell — which this must not use, since a version read off a registry travels through
 * these arguments. npm ships beside the Node that is running: under `lib/node_modules` on Unix, and
 * beside the executable itself on Windows.
 *
 * Duplicated in `packages/adapter/scripts/check-patches.ts`, deliberately: the two live in different
 * packages, and sharing twenty lines would mean either a tool package the adapter's own scripts depend
 * on or a reach across the workspace. The `npm` name each of them used was duplicated before this was.
 */
async function npmCli(): Promise<string> {
  const beside = path.dirname(process.execPath);
  const candidates = [
    path.join(beside, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(beside, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `next-matrix: npm was not found beside ${process.execPath}; looked in ${candidates.join(' and ')}`,
  );
}

/** Next.js's own entry in an installed application: JavaScript, and so the same on every platform. */
function nextBin(app: string): string {
  return path.join(app, 'node_modules', 'next', 'dist', 'bin', 'next');
}

type Dependencies = Readonly<
  Record<
    string,
    {
      readonly patches: readonly AppliedPatch[];
      readonly edge?: { readonly patches: readonly AppliedPatch[] };
    }
  >
>;

/** What the adapter recorded of one rewrite: which patch, and the file it rewrote. */
interface AppliedPatch {
  readonly patch: string;
  readonly file: string;
}

/** What a build wrote, as the record names it; anything else is a file of Next.js's own package. */
const BUILD_DIR = '.next/';

/** What else has to be true of a fixture's bundle, beyond its schema. */
type Holds = (bundle: DeploymentBundle, dependencies: Dependencies) => string[];

interface Fixture extends FixtureCoverage {
  readonly name: string;
  readonly holds: Holds;
}

const DATA_ROUTE = '/_next/data/';

/** Every kind of output the Routers have between them, from one application. */
function minimalHolds(bundle: DeploymentBundle): string[] {
  const problems: string[] = [];
  if (bundle.middleware === undefined) {
    problems.push('no middleware: `proxy.js` should have made one');
  }
  if (bundle.prerenders.length === 0) {
    problems.push('no prerenders: `generateStaticParams` should have made some');
  }
  if (bundle.prerenders.every((one) => one.postponed === undefined)) {
    problems.push('no postponed state: Cache Components should have made a shell to resume');
  }
  // The Pages Router's two data paths, which Next.js emits as different kinds of output:
  // `getServerSideProps` gives an entrypoint, `getStaticProps` a prerender, both named
  // `/_next/data/<buildId>/….json`.
  if (bundle.entrypoints.every((one) => !one.id.includes(DATA_ROUTE))) {
    problems.push('no `_next/data` entrypoint: `getServerSideProps` should have made one');
  }
  if (bundle.prerenders.every((one) => !one.pathname.includes(DATA_ROUTE))) {
    problems.push('no `_next/data` prerender: `getStaticProps` should have made one');
  }
  return problems;
}

/** The edge runtime, which is bundled apart and has its own copy of everything. */
function edgeHolds(bundle: DeploymentBundle, dependencies: Dependencies): string[] {
  const problems: string[] = [];
  if (bundle.entrypoints.every((one) => one.runtime !== 'edge')) {
    problems.push("no entrypoint on the edge runtime: `runtime = 'edge'` should have made one");
  }
  if (bundle.functions.middleware === undefined) {
    problems.push('no middleware Function: `middleware.js` should have made one');
  }
  for (const [name, one] of Object.entries(dependencies)) {
    if (one.edge === undefined) {
      problems.push(`the ${name} Function has no edge bundle`);
    }
  }
  return problems;
}

/** What each fixture has to show, by name — every name `coverage.ts` has, and no other. */
const HOLDS: Readonly<Record<FixtureName, Holds>> = {
  'next-minimal': minimalHolds,
  'next-edge': edgeHolds,
};

/**
 * Every fixture there is: `coverage.ts` says which they are and what each build has to show, and `HOLDS`
 * what else is true of each one's bundle. The names come off the coverage record rather than out of a
 * list here, so what this builds and what a checker reads are the same set by construction.
 *
 * `Object.keys` of a record whose keys are those literals is those literals; TypeScript types it as
 * `string` all the same.
 */
const FIXTURE_LIST: readonly Fixture[] = (Object.keys(FIXTURE_COVERAGE) as FixtureName[]).map(
  (name) => ({ name, ...FIXTURE_COVERAGE[name], holds: HOLDS[name] }),
);

// ─── the versions ────────────────────────────────────────────────────────────

/**
 * A tag is resolved through the registry; anything else is taken as it is. Naming a tag is the
 * point of the matrix: what it checks is then what a user would get today.
 */
async function resolveVersion(wanted: string): Promise<string> {
  if (!TAGS.has(wanted)) {
    return wanted;
  }
  const response = await fetch(`${REGISTRY}/-/package/next/dist-tags`);
  if (!response.ok) {
    throw new Error(`next-matrix: the registry answered ${String(response.status)} for dist-tags`);
  }
  const tags = (await response.json()) as Readonly<Record<string, string>>;
  const version = tags[wanted];
  if (version === undefined) {
    throw new Error(`next-matrix: next has no "${wanted}" tag`);
  }
  return version;
}

// ─── one build ───────────────────────────────────────────────────────────────

interface Outcome {
  readonly fixture: string;
  readonly version: string;
  readonly problems: readonly string[];
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  await execFileAsync(command, [...args], {
    cwd,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env },
  });
}

/** What a failed `execFile` rejected with: an `Error`, with the child's two streams hung off it. */
interface CommandFailure {
  readonly killed?: boolean;
  readonly stderr?: string;
  readonly stdout?: string;
}

function failureOf(error: unknown): CommandFailure {
  return error instanceof Error ? (error as CommandFailure & Error) : {};
}

/**
 * What a failed build was trying to say.
 *
 * A patch that does not fire throws a `PatchError` naming itself, its file and what it expected —
 * which is the whole answer — but Rolldown repeats it once per bundle with a stack under each, so
 * the distinct ones are pulled out and the stacks left behind. `next build` writes to both
 * streams and which one carries the reason depends on where it failed, so both are read.
 */
function explain(error: unknown): string[] {
  const failure = failureOf(error);
  if (failure.killed === true) {
    return [`the build was killed after ${String(BUILD_TIMEOUT_MS / MINUTE_MS)} minutes`];
  }
  // stderr last, because that is where the reason ends up and the tail is what gets shown:
  // `next build`'s progress fills stdout, and a tail of that says only that it was still going.
  const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.trim();
  if (output === '') {
    return [error instanceof Error ? error.message : String(error)];
  }
  const lines = output.split('\n');
  const patchErrors = [
    ...new Set(
      lines
        .filter((line) => line.includes('PatchError:'))
        .map((line) => line.slice(line.indexOf('PatchError:')).trim()),
    ),
  ];
  return patchErrors.length > 0 ? patchErrors : lines.slice(-TAIL_LINES);
}

/**
 * Every patch the build recorded, in either Function and in either of a Function's two bundles — and,
 * of those, the ones that rewrote something the build itself wrote.
 *
 * That second set is the half no published package can show, and so the half `check-patches.ts` cannot
 * check: a patch that says it reaches `build-output` is held to it here and nowhere else.
 */
function patchesApplied(dependencies: Dependencies): {
  applied: Set<string>;
  inChunks: Set<string>;
} {
  const applied = new Set<string>();
  const inChunks = new Set<string>();
  const record = ({ patch, file }: AppliedPatch): void => {
    applied.add(patch);
    if (file.startsWith(BUILD_DIR)) {
      inChunks.add(patch);
    }
  };
  for (const one of Object.values(dependencies)) {
    for (const entry of one.patches) {
      record(entry);
    }
    if (one.edge !== undefined) {
      for (const entry of one.edge.patches) {
        record(entry);
      }
    }
  }
  return { applied, inChunks };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

/**
 * One name, or exactly one of a group.
 *
 * Exactly one, not at least one: where a coverage entry names the two shapes one patch has across
 * the range, a build reaches whichever its version holds, and both firing means a marker has started
 * claiming what is not its shape — which is the thing naming both is there to catch, not to allow.
 */
function firedOnce(expected: Expected, fired: ReadonlySet<string>, missing: string): string[] {
  if (typeof expected === 'string') {
    return fired.has(expected) ? [] : [`the ${expected} patch ${missing}`];
  }
  const count = expected.filter((name) => fired.has(name)).length;
  return count === 1
    ? []
    : [`${expected.join(' / ')}: exactly one should have ${missing}, ${String(count)} did`];
}

async function checkOutput(fixture: Fixture, app: string): Promise<string[]> {
  const out = path.join(app, OUT_DIR);
  const parsed = deploymentBundleSchema.safeParse(await readJson(path.join(out, 'bundle.json')));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return [`bundle.json does not parse: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`];
  }
  const dependencies = (await readJson(path.join(out, 'dependencies.json'))) as Dependencies;
  const { applied, inChunks } = patchesApplied(dependencies);
  const problems = [
    ...fixture.expected.flatMap((patch) => firedOnce(patch, applied, 'applied to nothing')),
    // A patch that fired on Next.js's own file and on nothing this build wrote has lost the half of
    // itself that only a build can show: `check-patches.ts` would still see it fire, and a Function
    // would load a chunk it never rewrote.
    ...fixture.chunks.flatMap((patch) =>
      firedOnce(patch, inChunks, 'rewrote nothing this build wrote'),
    ),
  ];
  return [...problems, ...fixture.holds(parsed.data, dependencies)];
}

/**
 * What a fixture's directory holds that is the fixture, rather than what a build of it left there.
 * `package-lock.json` is among the leavings: it is npm's record of one Next.js, and this copy is
 * about to be given another.
 */
function isFixtureSource(source: string): boolean {
  const name = path.basename(source);
  return (
    name !== 'node_modules' && name !== '.next' && name !== OUT_DIR && name !== 'package-lock.json'
  );
}

/**
 * The fixture, copied out and built with one version of Next.js.
 *
 * A copy rather than the fixture itself, because each version needs its own `node_modules` and two
 * of them in one directory is one of them. `npm` rather than `pnpm`: the fixture is not a
 * workspace package and must not become one — the catalog pins a single Next.js for this
 * repository, which is the very thing the matrix is here to look past.
 */
async function build(fixture: Fixture, version: string, keep: boolean): Promise<Outcome> {
  const work = await mkdtemp(path.join(os.tmpdir(), `upwind-${fixture.name}-`));
  const app = path.join(work, fixture.name);
  try {
    await cp(path.join(FIXTURES, fixture.name), app, {
      recursive: true,
      filter: (source) => isFixtureSource(source),
    });
    const manifestPath = path.join(app, MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['next'] = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await run(process.execPath, [await npmCli(), 'install', '--no-audit', '--no-fund'], app);
    // Next.js's own entry under this Node, rather than the launcher npm wrote into `.bin`: that
    // one is a shell script on Unix and a `.cmd` on Windows, and `execFile` runs neither without
    // a shell. The file below is the same JavaScript both of them end up running.
    await run(process.execPath, [nextBin(app), 'build'], app, { NEXT_ADAPTER_PATH: ADAPTER });
    return { fixture: fixture.name, version, problems: await checkOutput(fixture, app) };
  } catch (error) {
    return { fixture: fixture.name, version, problems: explain(error) };
  } finally {
    if (keep) {
      console.log(`      kept: ${app}`);
    } else {
      await rm(work, { recursive: true, force: true });
    }
  }
}

// ─── the run ─────────────────────────────────────────────────────────────────

function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function adapterIsBuilt(): Promise<void> {
  try {
    await stat(ADAPTER);
  } catch {
    const where = path.relative(ROOT, ADAPTER);
    throw new Error(
      `next-matrix: ${where} is not there; run \`pnpm --filter @stayingupwind/adapter build\` first`,
    );
  }
}

function describeVersions(wanted: readonly string[], resolved: readonly string[]): string {
  return wanted
    .map((one, at) => {
      const version = resolved[at];
      return version === undefined || version === one ? one : `${one} (${version})`;
    })
    .join(', ');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const wanted = (argument(argv, '--versions') ?? 'latest,canary')
    .split(',')
    .map((one) => one.trim());
  const only = argument(argv, '--fixture');
  const fixtures =
    only === undefined ? FIXTURE_LIST : FIXTURE_LIST.filter((one) => one.name === only);
  // A name nothing matches would otherwise build nothing and call it a pass, which is the one
  // outcome a check must never have.
  if (fixtures.length === 0) {
    const names = FIXTURE_LIST.map((one) => one.name).join(', ');
    throw new Error(`next-matrix: no fixture named "${only ?? ''}"; there are ${names}`);
  }

  await adapterIsBuilt();
  const versions = await Promise.all(wanted.map((one) => resolveVersion(one)));
  console.log(
    `next-matrix: ${String(fixtures.length)} fixture(s) × ${String(versions.length)} version(s)`,
  );
  console.log(`  fixtures: ${fixtures.map((one) => one.name).join(', ')}`);
  console.log(`  versions: ${describeVersions(wanted, versions)}\n`);

  const outcomes: Outcome[] = [];
  for (const version of versions) {
    for (const fixture of fixtures) {
      process.stdout.write(`  building ${fixture.name} with next@${version} … `);
      const outcome = await build(fixture, version, keep);
      outcomes.push(outcome);
      console.log(outcome.problems.length === 0 ? '✓' : '✗');
      for (const problem of outcome.problems) {
        console.log(`      ${problem}`);
      }
    }
  }

  const failed = outcomes.filter((one) => one.problems.length > 0);
  if (failed.length > 0) {
    const names = failed.map((one) => `${one.fixture}@${one.version}`).join(', ');
    console.error(
      `\n${String(failed.length)} of ${String(outcomes.length)} build(s) did not hold: ${names}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n${String(outcomes.length)} build(s) held`);
}

await main();
