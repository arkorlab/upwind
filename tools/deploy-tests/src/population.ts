import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PRERENDER_MATRIX_CASES } from './population-matrix-cases.ts';

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

/**
 * The release every copy below is held to: the supported one (`NIGHTLY_NEXTJS_REF`). The copied
 * cases are as they were at 16.4.4, but for what 16.4.5 adds: avif-svg-signature-confusion, a suite of
 * its own, and cases beside those copied in app-root-params-getters and
 * partial-fallback-shell-upgrade.
 */
const NEXT_16_4_5 = { version: '16.4.5', commit: '4e5335a00314be7fbb2aace5e9be56a88e64e5a8' };

/**
 * The copies, by upstream suite: of the cases Next.js's suites register otherwise or not at all when
 * deployed, those whose source says a deployment answers otherwise than `next start` does, and that
 * a deployment can be asked — not those reading the server's own output or files. Not among them is
 * `not-found-non-document-dynamic`: it asks less of a deployment only with Cache Components on, which
 * these runs leave off, so the suite already asks it in full.
 */
export const SUPPLEMENTS: readonly Supplement[] = [
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/app-middleware/app-middleware.test.ts',
    tree: '10b3eddb8636de56dadd428c59a3b8dd1147ebdf',
    source: 'app-dir/app-middleware/app-middleware.supplement.ts',
    file: 'test/e2e/app-dir/app-middleware/app-middleware.skipped-in-deploy.test.ts',
    cases: ['app-dir with middleware should not incorrectly treat a Location header as a rewrite'],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy.test.ts',
    tree: 'c19f21219de2239b1526e7e60567225e10d74e92',
    source: 'app-dir/app-middleware-proxy/app-middleware-proxy.supplement.ts',
    file: 'test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy.skipped-in-deploy.test.ts',
    cases: ['app-dir with proxy should not incorrectly treat a Location header as a rewrite'],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts',
    tree: '4bdb98dbdbff15d86d6ce67a40aea256e4436e42',
    source: 'app-dir/segment-cache/cached-navigations/cached-navigations.supplement.ts',
    file: 'test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.skipped-in-deploy.test.ts',
    cases: [
      'cached navigations does not cache synchronous IO after a novel param resolves',
      'cached navigations finishes a full prefetch after synchronous IO interrupts its shell',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/not-found-non-document/not-found-non-document.test.ts',
    tree: 'd856230a3ffe36d621dd888731d0ed0ca67018cd',
    source: 'app-dir/not-found-non-document/not-found-non-document.supplement.ts',
    file: 'test/e2e/app-dir/not-found-non-document/not-found-non-document.skipped-in-deploy.test.ts',
    cases: [
      'not-found-non-document returns a plain text 404 for subresource requests to unknown paths',
      'not-found-non-document returns a plain text 404 for font and manifest requests to unknown paths',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/use-cache-route-handler-only/use-cache-route-handler-only.test.ts',
    tree: 'e740f6698efd3716d22e8e353b44fe02a1e1bd0b',
    source: 'app-dir/use-cache-route-handler-only/use-cache-route-handler-only.supplement.ts',
    file: 'test/e2e/app-dir/use-cache-route-handler-only/use-cache-route-handler-only.skipped-in-deploy.test.ts',
    cases: ['use-cache-route-handler-only refreshes cached data after tag revalidation'],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/app-root-params-getters/use-cache.test.ts',
    tree: '211e8b949abad1d3e6bcea16aa0235bed9ded02b',
    source: 'app-dir/app-root-params-getters/use-cache.supplement.ts',
    file: 'test/e2e/app-dir/app-root-params-getters/use-cache.skipped-in-deploy.test.ts',
    cases: [
      'app-root-param-getters - cache - at runtime should revalidate only the tagged root params',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts',
    tree: 'bc19b01fb3d8bfa2a6d2e0ddce693e940beb2ce2',
    source: 'app-dir/segment-cache/prefetch-runtime/prefetch-runtime.supplement.ts',
    file: 'test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.skipped-in-deploy.test.ts',
    cases: [
      'runtime prefetching in a page includes root params, but not dynamic content',
      'runtime prefetching in a private cache includes root params, but not dynamic content',
      'runtime prefetching passed to a public cache includes root params, but not dynamic content',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/segment-cache/prefetch-static-shell/prefetch-static-shell.test.ts',
    tree: '86d8a1a085c3b19f99c9eb8672204a4bd9c722ed',
    source: 'app-dir/segment-cache/prefetch-static-shell/prefetch-static-shell.supplement.ts',
    file: 'test/e2e/app-dir/segment-cache/prefetch-static-shell/prefetch-static-shell.skipped-in-deploy.test.ts',
    cases: [
      'static App Shell prefetch attempt ensureStatic ensureStatic = "navigation" uses a static request for a `prefetch={true}` link to a page that uses static params and was not prerendered',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream:
      'test/e2e/app-dir/cache-components-prerender-matrix/cache-components-prerender-matrix.test.ts',
    tree: 'c615f87fcbdbc5d61ab108aa64b38651d1ecfeab',
    source:
      'app-dir/cache-components-prerender-matrix/cache-components-prerender-matrix.supplement.ts',
    file: 'test/e2e/app-dir/cache-components-prerender-matrix/cache-components-prerender-matrix.skipped-in-deploy.test.ts',
    cases: PRERENDER_MATRIX_CASES,
  },
  {
    next: NEXT_16_4_5,
    upstream:
      'test/e2e/app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.test.ts',
    tree: 'bfd678e721b4221eb628a4283205870a6ffa0504',
    source: 'app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.supplement.ts',
    file: 'test/e2e/app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.skipped-in-deploy.test.ts',
    cases: [
      'partial-fallback-shell-upgrade - partialPrefetching disabled shares an on-demand shell across params without generateStaticParams',
      'partial-fallback-shell-upgrade - partialPrefetching disabled keeps params without generateStaticParams dynamic after explicit revalidation of an on-demand shell',
      'partial-fallback-shell-upgrade - partialPrefetching disabled reuses generated optional catch-all pages before and after explicit revalidation',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/non-root-project-monorepo/non-root-project-monorepo.test.ts',
    tree: '46914e999bfa4ad3adda300884775b7deeab707f',
    source: 'app-dir/non-root-project-monorepo/non-root-project-monorepo.supplement.ts',
    file: 'test/e2e/app-dir/non-root-project-monorepo/non-root-project-monorepo.skipped-in-deploy.test.ts',
    cases: [
      'non-root-project-monorepo import.meta.url should work during RSC',
      'non-root-project-monorepo import.meta.url should work during SSR',
      'non-root-project-monorepo import.meta.url non-url-safe characters should encode special chars during RSC',
      'non-root-project-monorepo import.meta.url non-url-safe characters should encode special chars during SSR',
    ],
  },
  {
    next: NEXT_16_4_5,
    upstream: 'test/e2e/app-dir/avif-svg-signature-confusion/avif-svg-signature-confusion.test.ts',
    tree: 'f0fcc5b59fdfb76506585aa1738023b79f10f67c',
    source: 'app-dir/avif-svg-signature-confusion/avif-svg-signature-confusion.supplement.ts',
    file: 'test/e2e/app-dir/avif-svg-signature-confusion/avif-svg-signature-confusion.skipped-in-deploy.test.ts',
    cases: [
      'avif-svg-signature-confusion rejects an ordinary SVG when dangerouslyAllowSVG is false',
      'avif-svg-signature-confusion rejects an SVG prefixed with <!--ftypavif-->',
    ],
  },
];

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
 * those it lists cases of. A suite both listed and excluded is excluded, as the runner has it. A
 * listed suite is not held to the include rules: the runner selects a suite named in `suites` by its
 * name, whatever the rules say (`test/get-test-filter.js`), so upstream runs it, less those cases.
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

/**
 * The Git tree of `dir` at the checkout's commit, or `none` where the commit has no such directory:
 * what `rev-parse --verify --quiet` says with its status 1 and nothing else. Any other failure of
 * Git is not an answer about the directory, and stops the step.
 */
function treeOf(nextDir: string, dir: string): string {
  try {
    return git(nextDir, 'rev-parse', '--verify', '--quiet', `HEAD:${dir}`);
  } catch (error) {
    if ((error as { readonly status?: unknown }).status === 1) {
      return 'none';
    }
    throw error;
  }
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
    const actual = treeOf(nextDir, path.posix.dirname(upstream));
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
