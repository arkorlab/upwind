import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';

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
      readonly patches: readonly { readonly patch: string }[];
      readonly edge?: { readonly patches: readonly { readonly patch: string }[] };
    }
  >
>;

/**
 * A patch a build has to apply, or — where Next.js has shipped a thing in two shapes across the
 * supported range — the set of patches of which exactly the one for this version must fire. The
 * Turbopack WebAssembly loader is the case in point: its own module from 16.3, the Turbopack
 * runtime itself in 16.2. Naming both is what lets one expectation hold for the whole range.
 */
type Expected = string | readonly string[];

interface Fixture {
  readonly name: string;
  /** Every patch a build of this fixture has to apply, in one Function or the other. */
  readonly expected: readonly Expected[];
  /** What else has to be true of the bundle, beyond its schema. */
  readonly holds: (bundle: DeploymentBundle, dependencies: Dependencies) => string[];
}

/** The rewrites that reach Next.js's own package, and so every build of any fixture. */
const PACKAGE_PATCHES = [
  'cache-signal-timers',
  'fetch-cache-wait-until',
  'graph-manifests',
  'hanging-input-abort',
  'instrumentation',
  'load-manifest',
  'resume-cache-limit',
  'task-timers',
] as const;

const DATA_ROUTE = '/_next/data/';

const FIXTURE_LIST: readonly Fixture[] = [
  {
    name: 'next-minimal',
    // Every patch there is: this fixture exists to be the one build that reaches all of them.
    expected: [
      ...PACKAGE_PATCHES,
      'turbopack-runtime',
      // One or the other, by version: see `Expected`.
      ['wasm-loader', 'runtime-wasm-loader'],
      'vercel-og',
      'vercel-og-font',
      'vercel-og-image-response',
    ],
    holds: (bundle) => {
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
    },
  },
  {
    name: 'next-edge',
    // No `wasm-loader`: WebAssembly on the edge runtime travels as `wasmAssets` under Turbopack's
    // own global and never reaches the Node.js loader that patch rewrites. No `vercel-og` either —
    // nothing here renders an image.
    expected: [...PACKAGE_PATCHES, 'turbopack-runtime'],
    holds: (bundle, dependencies) => {
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
    },
  },
];

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

/** Every patch the build recorded, in either Function and in either of a Function's two bundles. */
function patchesApplied(dependencies: Dependencies): Set<string> {
  const applied = new Set<string>();
  for (const one of Object.values(dependencies)) {
    for (const { patch } of one.patches) {
      applied.add(patch);
    }
    if (one.edge !== undefined) {
      for (const { patch } of one.edge.patches) {
        applied.add(patch);
      }
    }
  }
  return applied;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

async function checkOutput(fixture: Fixture, app: string): Promise<string[]> {
  const out = path.join(app, OUT_DIR);
  const parsed = deploymentBundleSchema.safeParse(await readJson(path.join(out, 'bundle.json')));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return [`bundle.json does not parse: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`];
  }
  const dependencies = (await readJson(path.join(out, 'dependencies.json'))) as Dependencies;
  const applied = patchesApplied(dependencies);
  const problems = fixture.expected.flatMap((expected) => {
    const names = typeof expected === 'string' ? [expected] : expected;
    return names.some((name) => applied.has(name))
      ? []
      : [`${names.join(' / ')} applied to nothing`];
  });
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
