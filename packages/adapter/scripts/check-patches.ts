import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type Copy, type Patch, PATCHES, type PatchContext } from '../src/patches/index.ts';
import { SUPPORTED_NEXT_RANGE } from '../src/patches/versions.ts';

/**
 * Holds `SUPPORTED_NEXT_RANGE` to its word.
 *
 * A patch is a pure function of a file's source and the build's context (`src/patches/types.ts`),
 * which is what lets this run at all: no bundler, no build, no `.next` — the files come out of the
 * published package and each patch is applied to the ones its target names. A patch that fires is
 * a patch that still found everything it insists on, because insisting is what a patch does: it
 * counts what it is about to rewrite and throws when the count is wrong.
 *
 * Three modes, because the cheap question and the thorough one are not the same question:
 *
 * - no flags: the Next.js in `node_modules` (the catalog pin). No network, a second or two, and it
 *   answers "did a change to the patches break the version this repository builds against" —
 *   which is the question a pull request asks. CI runs this on every change.
 * - `--range`: every release published under `SUPPORTED_NEXT_RANGE`, each fetched with `npm pack`.
 *   This is what makes the range a claim with evidence behind it rather than a number in a
 *   `package.json`. Hundreds of megabytes, so it runs on its own schedule.
 * - `--canary`: the current canary as well, as a forecast. See `Target.forecast`.
 *
 * What it cannot reach: three patches rewrite `next build`'s *output* rather than Next.js's
 * package — `turbopack-runtime` and `wasm-loader` (the Turbopack runtime and the WebAssembly
 * loader it bundles) and `vercel-og` (the chunk Turbopack emits for the external import). They
 * find nothing here and are reported as such; `tools/next-matrix` builds real applications and
 * covers them.
 */

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.join(ROOT, '..', '..');
const MANIFEST = 'package.json';
/**
 * The Next.js this repository builds against. Resolved rather than joined: pnpm links a package
 * into the one workspace that depends on it and keeps the real copy under `.pnpm`, so there is no
 * path to guess at.
 */
const INSTALLED_NEXT = path.dirname(createRequire(import.meta.url).resolve(`next/${MANIFEST}`));
/**
 * Where a fetched package is unpacked; under `node_modules`, so it is already ignored. It is kept
 * between runs because fetching Next.js is by far the slow part, and it is worth knowing that it
 * grows: a version unpacked is a few hundred megabytes, and `--range` fetches every one of them.
 * Deleting the directory is the whole of cleaning it up.
 */
const CACHE = path.join(REPO, 'node_modules', '.cache', 'next-versions');
const REGISTRY = 'https://registry.npmjs.org';
/** `major.minor.patch`, and nothing after it that this file has any use for. */
const VERSION_PARTS = 3;
/** 64 MiB, for room rather than for need: both commands are run quiet and print a line at most. */
const OUTPUT_LIMIT = 67_108_864;
/**
 * npm, as something `execFile` can start without a shell: its own JavaScript, run by this Node.
 *
 * The name on `PATH` is a shell script on Unix and a `.cmd` on Windows, and Node will not spawn the
 * second without a shell — which this must not use, since a version read off a registry travels through
 * these arguments. npm ships beside the Node that is running: under `lib/node_modules` on Unix, and
 * beside the executable itself on Windows.
 *
 * Duplicated in `tools/next-matrix/src/run.ts`, deliberately: the two live in different packages, and
 * sharing twenty lines would mean either a tool package these scripts depend on or a reach across the
 * workspace. The `npm` name each of them used was duplicated before this was.
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
    `check-patches: npm was not found beside ${process.execPath}; looked in ${candidates.join(' and ')}`,
  );
}

/** `tar` needs no such care: Windows has shipped one since 10, as an executable. */

/** The context a patch is handed. Only `instrumentation` reads any of it from a package file. */
const CONTEXT: PatchContext = {
  distDir: path.join(REPO, '.next'),
  chunks: [],
  instrumentation: undefined,
  wasm: [],
};

/** What one patch did to one file. */
interface Applied {
  readonly patch: string;
  readonly file: string;
  readonly edits: number;
}

// ─── semantic versions ───────────────────────────────────────────────────────

type Version = readonly [number, number, number];

/** A release, or nothing: a prerelease (`16.4.0-canary.48`) is not one and sorts nowhere here. */
function release(version: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) {
    return undefined;
  }
  const [, major = '0', minor = '0', patch = '0'] = match;
  return [Number(major), Number(minor), Number(patch)];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

type Operator = '<' | '<=' | '>' | '>=';
interface Comparator {
  readonly operator: Operator;
  readonly bound: Version;
}

/**
 * `>=16.3.0 <17` and the like: space-separated comparators, all of which must hold. Deliberately
 * only as much of the syntax as `SUPPORTED_NEXT_RANGE` is written in — a range this file cannot
 * read is refused rather than guessed at, since guessing would quietly check the wrong versions.
 */
function comparatorsOf(range: string): Comparator[] {
  return range
    .split(/\s+/u)
    .filter((part) => part !== '')
    .map((part) => {
      const match = /^(?<operator><=|>=|<|>)(?<version>[\d.]+)$/u.exec(part);
      const operator = match?.groups?.['operator'];
      const version = match?.groups?.['version'];
      if (operator === undefined || version === undefined) {
        throw new Error(`check-patches: cannot read the comparator "${part}"`);
      }
      const [major = '0', minor = '0', patch = '0'] = version.split('.', VERSION_PARTS);
      return {
        operator: operator as Operator,
        bound: [Number(major), Number(minor), Number(patch)] as Version,
      };
    });
}

/** What a comparator asks of `compare`'s answer. */
function holds(operator: Operator, order: number): boolean {
  switch (operator) {
    case '<': {
      return order < 0;
    }
    case '<=': {
      return order <= 0;
    }
    case '>': {
      return order > 0;
    }
    case '>=': {
      return order >= 0;
    }
  }
}

function satisfies(version: Version, comparators: readonly Comparator[]): boolean {
  return comparators.every(({ operator, bound }) => holds(operator, compare(version, bound)));
}

// ─── the packages to check ───────────────────────────────────────────────────

interface Metadata {
  readonly versions: Readonly<Record<string, unknown>>;
  readonly 'dist-tags': Readonly<Record<string, string>>;
}

/** The registry's abbreviated metadata: versions and tags, without the rest of every manifest. */
async function registryMetadata(): Promise<Metadata> {
  const response = await fetch(`${REGISTRY}/next`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!response.ok) {
    throw new Error(`check-patches: the registry answered ${String(response.status)} for next`);
  }
  return (await response.json()) as Metadata;
}

/** Every release the range admits, oldest first. */
function releasesInRange(metadata: Metadata, range: string): string[] {
  const comparators = comparatorsOf(range);
  return Object.keys(metadata.versions)
    .flatMap((version) => {
      const parsed = release(version);
      return parsed !== undefined && satisfies(parsed, comparators) ? [{ version, parsed }] : [];
    })
    .toSorted((a, b) => compare(a.parsed, b.parsed))
    .map((one) => one.version);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** `npm pack` the version and unpack it, unless a previous run already did. */
async function fetchPackage(version: string): Promise<string> {
  const dir = path.join(CACHE, version);
  const root = path.join(dir, 'package');
  if (await exists(path.join(root, MANIFEST))) {
    return root;
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const { stdout } = await execFileAsync(
    process.execPath,
    [await npmCli(), 'pack', `next@${version}`, '--silent', '--pack-destination', dir],
    { maxBuffer: OUTPUT_LIMIT },
  );
  const printed = stdout.trim().split('\n').at(-1)?.trim();
  if (printed === undefined || printed === '') {
    throw new Error(`check-patches: npm pack printed no tarball for next@${version}`);
  }
  // Node has no tar reader, and the alternative is vendoring one to unpack a file this script
  // throws away. `tar` is on every platform this repository's engines admit.
  await execFileAsync('tar', ['-xzf', path.join(dir, printed), '-C', dir]);
  await rm(path.join(dir, printed), { force: true });
  return root;
}

// ─── applying the patches ────────────────────────────────────────────────────

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(file, out);
    } else if (entry.isFile() && file.endsWith('.js')) {
      out.push(file);
    }
  }
  return out;
}

/** The members of `wanted` that `have` has not got. */
function missingFrom(wanted: Iterable<string>, have: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const one of wanted) {
    if (!have.has(one)) {
      missing.push(one);
    }
  }
  return missing;
}

/**
 * Every patch applied to every file of one package, as a build would apply it.
 *
 * A file is named to the patch the way a build names it — `…/node_modules/next/dist/…` — because
 * that is what the targets match on, and a package's own root is `package/`.
 *
 * A patch that cannot find what it insists on throws, and that is the whole verdict: this version
 * is not one the adapter supports. The message names the patch, the file and what it expected, so
 * it travels up as it comes.
 */
async function profile(root: string): Promise<Applied[]> {
  const files = await walk(path.join(root, 'dist'));
  const applied: Applied[] = [];
  for (const patch of PATCHES) {
    for (const file of files) {
      const name = `/node_modules/next/${path.relative(root, file).split(path.sep).join('/')}`;
      if (!patch.target.test(name)) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      // The marker is asked after the target and before `apply`, as a build asks it: a file the
      // target claims and the marker does not is left alone and is not a patch that failed.
      if (patch.marker !== undefined && !patch.marker(source)) {
        continue;
      }
      const result = patch.apply(source, name, CONTEXT);
      applied.push({ patch: patch.name, file: name, edits: result.edits });
    }
  }
  return applied;
}

/**
 * Which copy of Next.js a file is, by the name a build knows it under.
 *
 * The same module is shipped more than once, and a patch declares the kinds it has to reach
 * (`Copy`, `src/patches/types.ts`). This is where a file is read as one of them: the compiled server
 * runtimes each bundle their own copy, everything else under `compiled/` is a vendored package's,
 * `esm/` is the ESM copy beside a file, and the rest is the file itself.
 *
 * `build-output` is not among the answers, because a published package holds none of it. That is the
 * one kind this checker cannot see, and `tools/next-matrix` is what holds a patch to it.
 */
function copyOf(file: string): Exclude<Copy, 'build-output'> {
  const inPackage = file.replace(/^.*\/node_modules\/next\/dist\//u, '');
  if (/^compiled\/next-server\/[\w-]+\.runtime\.prod\.js$/u.test(inPackage)) {
    return 'server-runtime';
  }
  if (inPackage.startsWith('compiled/')) {
    return 'vendored';
  }
  return inPackage.startsWith('esm/') ? 'esm-module' : 'module';
}

/** The kinds a patch has to reach that a published package can show at all. */
function packageKinds(patch: Patch): string[] {
  return patch.reaches.filter((kind) => kind !== 'build-output');
}

/** The patches a published package does hold a file for, and so every checked version must fire. */
const REQUIRED_PATCHES = PATCHES.filter((patch) => packageKinds(patch).length > 0);

// ─── the range and what declares it ──────────────────────────────────────────

async function installedVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(INSTALLED_NEXT, MANIFEST), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/**
 * The range, and everything else that has to agree with it: the two `peerDependencies` that repeat
 * it, and the catalog pin this repository builds against. Four declarations of one fact are three
 * chances to drift, so they are held to each other here rather than by whoever remembers.
 *
 * The catalog pin matters most quietly. With no flags this script checks that version and no
 * other, so a pin that had wandered outside the range would leave the whole of CI agreeing with
 * something the range does not admit.
 */
async function checkDeclarations(): Promise<string[]> {
  const problems: string[] = [];
  for (const workspace of ['adapter', 'upwind']) {
    const file = path.join(REPO, 'packages', workspace, MANIFEST);
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      peerDependencies?: Record<string, string>;
    };
    const declared = manifest.peerDependencies?.['next'];
    if (declared !== SUPPORTED_NEXT_RANGE) {
      problems.push(
        `packages/${workspace}/${MANIFEST} declares next "${declared ?? '(none)'}", SUPPORTED_NEXT_RANGE is "${SUPPORTED_NEXT_RANGE}"`,
      );
    }
  }
  const installed = await installedVersion();
  const parsed = release(installed);
  if (parsed === undefined || !satisfies(parsed, comparatorsOf(SUPPORTED_NEXT_RANGE))) {
    problems.push(
      `the installed next is ${installed}, which ${SUPPORTED_NEXT_RANGE} does not admit; the catalog pin has to be inside the range it declares`,
    );
  }
  return problems;
}

// ─── the run ─────────────────────────────────────────────────────────────────

interface Target {
  readonly version: string;
  readonly root: string;
  /**
   * A prerelease: in the range's direction but not in the range, since a semantic-version range
   * admits no prerelease it does not name. It is checked as a forecast — what the next release is
   * about to do to these rewrites — so a break in one is not this adapter being wrong about a
   * version somebody can install today. A canary is numbered as the next minor whatever it is
   * going to become, and which it becomes is decided when it ships: as a major it is outside this
   * range already, as a minor it is inside it. It is reported apart and, like everything else
   * here, exits non-zero — a warning nothing fails on is a warning nobody reads — and what to do
   * about it is the workflow's to decide, by running the forecast as a step allowed to fail.
   */
  readonly forecast: boolean;
}

async function targets(wholeRange: boolean, canary: boolean): Promise<Target[]> {
  const installed = await installedVersion();
  const list: Target[] = [{ version: installed, root: INSTALLED_NEXT, forecast: false }];
  if (!wholeRange && !canary) {
    return list;
  }
  const metadata = await registryMetadata();
  const wanted: { version: string; forecast: boolean }[] = [];
  if (wholeRange) {
    const releases = releasesInRange(metadata, SUPPORTED_NEXT_RANGE);
    // Otherwise `--range` would quietly check the installed version alone and report a pass over
    // a range that admits nothing anyone could install.
    if (releases.length === 0) {
      throw new Error(`check-patches: no published next satisfies ${SUPPORTED_NEXT_RANGE}`);
    }
    for (const version of releases) {
      wanted.push({ version, forecast: false });
    }
  }
  const tag = metadata['dist-tags']['canary'];
  if (canary && tag !== undefined) {
    wanted.push({ version: tag, forecast: true });
  }
  for (const { version, forecast } of wanted) {
    if (version !== installed) {
      list.push({ version, root: await fetchPackage(version), forecast });
    }
  }
  return list;
}

/**
 * The versions a build matrix should take, as JSON on stdout: the floor of the range, its top, and
 * the canary — the three that say something the others do not. Printed rather than written into a
 * workflow so that the range stays one declaration; a workflow with a list of versions in it is a
 * second declaration, and it is the one that goes stale.
 */
async function printMatrix(): Promise<void> {
  const metadata = await registryMetadata();
  const inRange = releasesInRange(metadata, SUPPORTED_NEXT_RANGE);
  // A matrix of nothing is a job GitHub skips without a word, which would read as a pass — and so
  // is a matrix of the canary alone, which would build a version the range does not admit and none
  // that it does. What is asked for here is a *release*, so that is what the emptiness is read off.
  if (inRange.length === 0) {
    throw new Error(`check-patches: no published next satisfies ${SUPPORTED_NEXT_RANGE}`);
  }
  const floor = inRange[0];
  const top = inRange.at(-1);
  const canary = metadata['dist-tags']['canary'];
  // `{ include: [...] }`, which is a GitHub Actions `strategy.matrix` as it stands.
  console.log(
    JSON.stringify({
      include: [
        ...(floor === undefined ? [] : [{ version: floor, forecast: false }]),
        ...(top === undefined || top === floor ? [] : [{ version: top, forecast: false }]),
        ...(canary === undefined ? [] : [{ version: canary, forecast: true }]),
      ],
    }),
  );
}

/** One version's verdict: what its patches did, or what went wrong. */
async function verdict(target: Target): Promise<{ applied?: Applied[]; problem?: string }> {
  let applied: Applied[];
  try {
    applied = await profile(target.root);
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  // Each patch is held to the kinds of copy it says it reaches, and not merely to having fired
  // somewhere: `cache-signal-timers` is loaded from the source module *and* from each compiled
  // runtime, and a version where only the first still matches is a Function with the bug back. A
  // kind that went missing means `target` or `marker` stopped matching it, whether because Next.js
  // moved the file or because an edit here missed.
  const problems: string[] = [];
  for (const patch of REQUIRED_PATCHES) {
    const reached = new Set(
      applied.filter((one) => one.patch === patch.name).map((one) => copyOf(one.file)),
    );
    const missing = missingFrom(packageKinds(patch), reached);
    if (missing.length > 0) {
      problems.push(`${patch.name} reached no ${missing.join(', no ')}`);
    }
  }
  if (problems.length > 0) {
    return { applied, problem: problems.join('; ') };
  }
  return { applied };
}

function report(target: Target, applied: readonly Applied[]): void {
  const patches = new Set(applied.map((one) => one.patch));
  const edits = applied.reduce((total, one) => total + one.edits, 0);
  console.log(
    `✓ next@${target.version}  ${String(patches.size)} patch(es), ${String(applied.length)} file(s), ${String(edits)} edit(s)`,
  );
}

/** Every version checked, reported as it goes; what is left is the two kinds of problem. */
async function checkAll(
  checked: readonly Target[],
): Promise<{ failures: string[]; forecasts: string[] }> {
  const failures: string[] = [];
  const forecasts: string[] = [];
  for (const target of checked) {
    const { applied, problem } = await verdict(target);
    if (problem !== undefined) {
      (target.forecast ? forecasts : failures).push(`next@${target.version}: ${problem}`);
      console.error(`${target.forecast ? '!' : '✗'} next@${target.version}\n    ${problem}`);
      continue;
    }
    if (applied !== undefined) {
      report(target, applied);
    }
  }
  return { failures, forecasts };
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  if (argv.has('--print-matrix')) {
    await printMatrix();
    return;
  }

  const declarations = await checkDeclarations();
  for (const problem of declarations) {
    console.error(`✗ ${problem}`);
  }

  console.log(`supported range: ${SUPPORTED_NEXT_RANGE}`);
  const buildOutput = PATCHES.filter((patch) => packageKinds(patch).length === 0).map(
    (patch) => patch.name,
  );
  console.log(
    `${String(REQUIRED_PATCHES.length)} patch(es) held to the copies they reach; ${buildOutput.join(', ')} rewrite build output alone and are covered by tools/next-matrix`,
  );
  const checked = await targets(argv.has('--range'), argv.has('--canary'));
  const names = checked.map((one) => one.version).join(', ');
  console.log(`checking ${String(checked.length)} version(s): ${names}\n`);

  const { failures, forecasts } = await checkAll(checked);

  for (const forecast of forecasts) {
    console.warn('\n! a prerelease breaks a patch, and so will the release it becomes:');
    console.warn(`    ${forecast}`);
    console.warn('  A canary is numbered as the next minor whatever it becomes. Shipped as a');
    console.warn(`  major it is outside ${SUPPORTED_NEXT_RANGE} and costs nothing; shipped as a`);
    console.warn('  minor it is inside, and the patch has to learn the new shape before it lands.');
  }

  const wrong = failures.length + declarations.length;
  if (wrong > 0) {
    console.error(
      `\n${String(wrong)} problem(s); ${SUPPORTED_NEXT_RANGE} is not supported as declared`,
    );
  } else {
    const releases = checked.filter((one) => !one.forecast).length;
    console.log(
      `\nevery patch applies to ${String(releases)} release(s) of ${SUPPORTED_NEXT_RANGE}`,
    );
  }
  if (wrong > 0 || forecasts.length > 0) {
    process.exitCode = 1;
  }
}

await main();
