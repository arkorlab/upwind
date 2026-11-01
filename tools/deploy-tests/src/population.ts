import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which suites a run takes (`population` in the workflow):
 * - `upstream`: what Next.js's deploy manifest (`test/deploy-tests-manifest.json`) selects, the suite
 *   as Next.js runs it against Vercel.
 * - `skipped`: what Next.js leaves out when deployed. The suites its manifest excludes whole, the
 *   suites in which it lists cases to leave out (run whole, since nothing selects a case by name),
 *   and the cases its suites register otherwise or not at all in deploy mode, copied beside them
 *   (`SUPPLEMENTS`).
 */
export type Population = 'upstream' | 'skipped';

/** The population a run names (`POPULATION`), `upstream` where it names none. */
export function populationOf(value: string | undefined): Population {
  if (value === undefined || value === '' || value === 'upstream') {
    return 'upstream';
  }
  if (value === 'skipped') {
    return 'skipped';
  }
  throw new Error(`the population is upstream or skipped, not ${value}`);
}

/** Next.js's deploy manifest, in the version its runner reads (`test/get-test-filter.js`). */
export interface DeployManifest {
  readonly version: 2;
  readonly suites: Readonly<
    Record<string, { readonly failed?: readonly string[]; readonly flakey?: readonly string[] }>
  >;
  readonly rules: { readonly include: readonly string[]; readonly exclude: readonly string[] };
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${what} is not a list of strings`);
  }
  return value as string[];
}

/** The manifest as Next.js's runner reads it; any other version is refused, not guessed at. */
export function parseManifest(raw: unknown): DeployManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('the deploy manifest is not an object');
  }
  const { version, suites, rules } = raw as Record<string, unknown>;
  if (version !== 2) {
    throw new TypeError(`the deploy manifest is version ${String(version)}, not 2`);
  }
  if (
    typeof suites !== 'object' ||
    suites === null ||
    typeof rules !== 'object' ||
    rules === null
  ) {
    throw new TypeError('the deploy manifest has no suites or no rules');
  }
  const own: Record<string, { failed: string[]; flakey: string[] }> = {};
  for (const [suite, entry] of Object.entries(suites)) {
    const { failed = [], flakey = [] } = (entry ?? {}) as Record<string, unknown>;
    own[suite] = {
      failed: strings(failed, `the failed cases of ${suite}`),
      flakey: strings(flakey, `the flakey cases of ${suite}`),
    };
  }
  const { include, exclude = [] } = rules as Record<string, unknown>;
  return {
    version: 2,
    suites: own,
    rules: {
      include: strings(include, "the manifest's include rules"),
      exclude: strings(exclude, "the manifest's exclude rules"),
    },
  };
}

/**
 * A case copied out of an upstream suite, as deploy mode would not run it: registered only where the
 * suite is not deployed, or with a branch that asks less of a deployment. The copy keeps the suite's
 * and the case's names, and resolves each such branch to the side the suite takes when it is not
 * deployed. It is written beside the upstream suite, so that `files: __dirname` builds the same
 * fixture. It holds for the upstream directory as it was copied (`tree`): one that changed is not
 * the code it was copied from.
 */
export interface Supplement {
  /** The Next.js release it was copied from. */
  readonly next: { readonly version: string; readonly commit: string };
  /** The upstream suite. */
  readonly upstream: string;
  /** The git tree of the upstream suite's directory at that commit. */
  readonly tree: string;
  /** The copy, under `tools/deploy-tests/supplements`. */
  readonly source: string;
  /** Where the copy is written in the checkout: beside the upstream suite, a `.test.ts` of its own. */
  readonly file: string;
  /** The full names of the cases it registers, as Jest gives them. */
  readonly cases: readonly string[];
}

/** The copies, by upstream suite. */
export const SUPPLEMENTS: readonly Supplement[] = [];

/** A supplement left out of a run, because its upstream directory is not the one it was copied from. */
export interface StaleSupplement {
  readonly file: string;
  readonly upstream: string;
  readonly expected: string;
  readonly actual: string;
}

/** What the skipped population is made of, as `population.json` keeps it beside a shard's results. */
export interface SkippedPopulation {
  readonly version: 1;
  /** The suites the deploy manifest excludes whole. */
  readonly excluded: readonly string[];
  /** The suites the deploy manifest lists cases of to leave out, and those cases. */
  readonly listed: Readonly<Record<string, readonly string[]>>;
  /** The copies written into the checkout. */
  readonly supplements: readonly Pick<Supplement, 'file' | 'upstream' | 'tree' | 'cases'>[];
  /** The copies left out, as of another directory than the one they were copied from. */
  readonly stale: readonly StaleSupplement[];
}

/**
 * The suites the skipped population runs, from the deploy manifest: those it excludes whole, out of
 * the suites its include rules select (`selected`, `excluded` resolved against the checkout), and
 * those it lists cases of. A suite both listed and excluded is excluded, as the runner has it.
 */
export function manifestPopulation(
  manifest: DeployManifest,
  selected: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): Pick<SkippedPopulation, 'excluded' | 'listed'> {
  const whole: string[] = [];
  for (const suite of excluded) {
    if (selected.has(suite)) {
      whole.push(suite);
    }
  }
  const listed: Record<string, readonly string[]> = {};
  for (const [suite, { failed = [], flakey = [] }] of Object.entries(manifest.suites)) {
    const cases = [...failed, ...flakey];
    if (cases.length > 0 && !excluded.has(suite)) {
      listed[suite] = cases;
    }
  }
  return { excluded: whole.toSorted((a, b) => a.localeCompare(b)), listed };
}

/**
 * The manifest a skipped run is given (`NEXT_EXTERNAL_TESTS_FILTERS`): every suite of the population
 * named in `suites`, which the runner selects as named, and no rule. A path in `rules` would be read
 * as a glob.
 */
export function populationManifest(population: SkippedPopulation): DeployManifest {
  const suites = [
    ...population.excluded,
    ...Object.keys(population.listed),
    ...population.supplements.map(({ file }) => file),
  ];
  return {
    version: 2,
    suites: Object.fromEntries(
      suites.toSorted((a, b) => a.localeCompare(b)).map((suite) => [suite, {}]),
    ),
    rules: { include: [], exclude: [] },
  };
}

function git(nextDir: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- the checkout's own Git, on a path the workflow made.
  return execFileSync('git', ['-C', nextDir, ...args], { encoding: 'utf8' }).trim();
}

/** The directory of the tool's copies. */
const SUPPLEMENTS_DIR = path.resolve(import.meta.dirname, '../supplements');

/**
 * Writes the copies of `supplements` into the checkout at `nextDir`, each beside its upstream suite,
 * where the upstream directory is the one it was copied from. One that is not is left out and said:
 * on the commit it was copied from that is a broken record, and refused instead.
 */
export function writeSupplements(
  nextDir: string,
  supplements: readonly Supplement[],
  from = SUPPLEMENTS_DIR,
): Pick<SkippedPopulation, 'supplements' | 'stale'> {
  const commit = git(nextDir, 'rev-parse', 'HEAD');
  const written: Pick<Supplement, 'file' | 'upstream' | 'tree' | 'cases'>[] = [];
  const stale: StaleSupplement[] = [];
  for (const supplement of supplements) {
    const { file, upstream, tree, cases, source } = supplement;
    if (path.posix.dirname(file) !== path.posix.dirname(upstream) || !file.endsWith('.test.ts')) {
      throw new Error(`the copy of ${upstream} must be a .test.ts beside it, not ${file}`);
    }
    const actual = git(nextDir, 'rev-parse', `HEAD:${path.posix.dirname(upstream)}`);
    if (actual !== tree) {
      if (commit === supplement.next.commit) {
        throw new Error(
          `${upstream}'s directory is ${actual} at ${commit}, the commit its copy was taken from, not ${tree}`,
        );
      }
      stale.push({ file, upstream, expected: tree, actual });
      continue;
    }
    const target = path.join(nextDir, file);
    if (existsSync(target)) {
      throw new Error(
        `${file} is already in the checkout: a copy never replaces a file of upstream`,
      );
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(from, source), target);
    written.push({ file, upstream, tree, cases });
  }
  return { supplements: written, stale };
}

/** Every path under `nextDir` that one of `patterns` matches, as the runner's globs would. */
export function matching(nextDir: string, patterns: readonly string[]): Set<string> {
  return new Set(
    patterns.flatMap((pattern) =>
      globSync(pattern, { cwd: nextDir }).map((file) => file.split(path.sep).join('/')),
    ),
  );
}

/** The skipped population of the checkout at `nextDir`, with its copies written into it. */
export function skippedPopulation(
  nextDir: string,
  supplements: readonly Supplement[] = SUPPLEMENTS,
  from = SUPPLEMENTS_DIR,
): SkippedPopulation {
  const file = path.join(nextDir, 'test/deploy-tests-manifest.json');
  const manifest = parseManifest(JSON.parse(readFileSync(file, 'utf8')));
  const fromManifest = manifestPopulation(
    manifest,
    matching(nextDir, manifest.rules.include),
    matching(nextDir, manifest.rules.exclude),
  );
  return { version: 1, ...fromManifest, ...writeSupplements(nextDir, supplements, from) };
}
