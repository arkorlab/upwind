import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type DeployManifest,
  manifestPopulation,
  matching,
  parseManifest,
  populationManifest,
  populationOf,
  skippedPopulation,
  type Supplement,
  SUPPLEMENTS,
  writeSupplements,
} from '../src/population.ts';

/* eslint-disable sonarjs/no-os-command-from-path -- fixtures are private temporary Git repositories. */

const dirs: string[] = [];

/** Removes every directory the test made. */
function cleanUp(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function temporary(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'upwind-population-'));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function write(dir: string, file: string, body: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
}

/** A checkout of `files`, committed: its commit, and the tree of each directory asked for. */
function checkout(files: Readonly<Record<string, string>>): { dir: string; commit: string } {
  const dir = temporary();
  for (const [file, body] of Object.entries(files)) write(dir, file, body);
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '.');
  git(
    dir,
    '-c',
    'user.name=Population Test',
    '-c',
    'user.email=population@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

const MANIFEST: DeployManifest = {
  version: 2,
  suites: {
    'test/e2e/listed/listed.test.ts': { failed: ['listed fails'], flakey: ['listed wavers'] },
    'test/e2e/both/both.test.ts': { failed: ['both fails'] },
    'test/e2e/clean/clean.test.ts': { failed: [], flakey: [] },
  },
  rules: {
    include: ['test/e2e/**/*.test.{t,j}s{,x}'],
    exclude: ['test/e2e/excluded/excluded.test.ts', 'test/e2e/both/both.test.ts'],
  },
};

const SUITE = 'test/e2e/app-dir/routes/routes.test.ts';

/** A copy of a case of `SUITE`, for the checkout `commit` whose directory is `tree`. */
function supplementOf(commit: string, tree: string, overrides: Partial<Supplement> = {}) {
  return {
    next: { version: '16.4.3', commit },
    upstream: SUITE,
    tree,
    source: 'app-dir/routes.supplement.ts',
    file: 'test/e2e/app-dir/routes/routes.skipped-in-deploy.test.ts',
    cases: ['routes answers what deploy mode skips'],
    ...overrides,
  } satisfies Supplement;
}

/** The tool's copies, with the one `supplementOf` names. */
function copies(): string {
  const from = temporary();
  write(from, 'app-dir/routes.supplement.ts', "it('answers what deploy mode skips', () => {})\n");
  return from;
}

describe('the population a run names', () => {
  it('is the deploy manifest’s where it names none', () => {
    expect(populationOf(undefined)).toBe('upstream');
    expect(populationOf('')).toBe('upstream');
    expect(populationOf('upstream')).toBe('upstream');
    expect(populationOf('skipped')).toBe('skipped');
  });

  it('is refused where it is neither', () => {
    expect(() => populationOf('everything')).toThrow('upstream or skipped, not everything');
  });
});

describe('the deploy manifest', () => {
  it('is read in the version Next.js’s runner reads', () => {
    expect(parseManifest(MANIFEST)).toStrictEqual({
      version: 2,
      suites: {
        'test/e2e/listed/listed.test.ts': { failed: ['listed fails'], flakey: ['listed wavers'] },
        'test/e2e/both/both.test.ts': { failed: ['both fails'], flakey: [] },
        'test/e2e/clean/clean.test.ts': { failed: [], flakey: [] },
      },
      rules: MANIFEST.rules,
    });
  });

  it('is refused in any other version, rather than guessed at', () => {
    expect(() => parseManifest({ ...MANIFEST, version: 1 })).toThrow('version 1, not 2');
    expect(() => parseManifest({ ...MANIFEST, rules: { include: 'test/e2e' } })).toThrow(
      'not a list of strings',
    );
  });
});

describe('what the deploy manifest skips', () => {
  afterEach(cleanUp);

  const selected = new Set([
    'test/e2e/both/both.test.ts',
    'test/e2e/excluded/excluded.test.ts',
    'test/e2e/listed/listed.test.ts',
  ]);

  it('is every suite it excludes, and every suite it lists cases of, with those cases', () => {
    const population = manifestPopulation(
      MANIFEST,
      selected,
      new Set(['test/e2e/both/both.test.ts', 'test/e2e/excluded/excluded.test.ts']),
    );

    expect(population).toStrictEqual({
      excluded: ['test/e2e/both/both.test.ts', 'test/e2e/excluded/excluded.test.ts'],
      // A suite both listed and excluded is excluded, as the runner has it; one that lists nothing
      // runs in the manifest's own population.
      listed: { 'test/e2e/listed/listed.test.ts': ['listed fails', 'listed wavers'] },
    });
  });

  it('is not an excluded path the include rules never selected', () => {
    const population = manifestPopulation(
      MANIFEST,
      selected,
      new Set(['test/production/elsewhere.test.ts']),
    );

    expect(population.excluded).toStrictEqual([]);
  });

  it('is resolved against the checkout as the runner’s globs are, braces and all', () => {
    const dir = temporary();
    for (const file of ['a/one.test.ts', 'a/two.test.tsx', 'a/three.test.js', 'a/four.ts']) {
      write(dir, `test/e2e/${file}`, '');
    }

    expect(
      [...matching(dir, ['test/e2e/**/*.test.{t,j}s{,x}'])].toSorted((a, b) => a.localeCompare(b)),
    ).toStrictEqual([
      'test/e2e/a/one.test.ts',
      'test/e2e/a/three.test.js',
      'test/e2e/a/two.test.tsx',
    ]);
  });
});

describe('the manifest a skipped run is given', () => {
  it('names every suite of the population, and no rule a path would be read as a glob in', () => {
    const manifest = populationManifest({
      version: 1,
      excluded: ['test/e2e/excluded/excluded.test.ts'],
      listed: { 'test/e2e/listed/listed.test.ts': ['listed fails'] },
      supplements: [
        {
          file: 'test/e2e/a/a.skipped-in-deploy.test.ts',
          upstream: 'test/e2e/a/a.test.ts',
          tree: 't',
          cases: ['a'],
        },
      ],
      stale: [],
    });

    expect(manifest).toStrictEqual({
      version: 2,
      suites: {
        'test/e2e/a/a.skipped-in-deploy.test.ts': {},
        'test/e2e/excluded/excluded.test.ts': {},
        'test/e2e/listed/listed.test.ts': {},
      },
      rules: { include: [], exclude: [] },
    });
  });
});

/** What a copy says as code, without its comments: what it runs. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The gates a copy's comments set (`@gate`, `@force-gate`), a line each. */
function gates(source: string): string[] {
  return source.split('\n').filter((line) => /@(?:force-)?gate\b/u.test(line));
}

describe('the copies of cases deploy mode skips', () => {
  afterEach(cleanUp);

  const kept = path.resolve(import.meta.dirname, '../supplements');
  const workflow = readFileSync(
    path.resolve(import.meta.dirname, '../../../.github/workflows/deploy-tests.yaml'),
    'utf8',
  );

  it.each(SUPPLEMENTS.map((supplement) => [supplement.upstream, supplement]))(
    'hold a copy of %s, beside it, as of the release the nights run',
    (_, { next, upstream, source, file, cases }) => {
      const copy = readFileSync(path.join(kept, source), 'utf8');
      const titles = [...copy.matchAll(/\bit\('((?:[^'\\]|\\.)*)'/gu)].map(([, title]) => title);

      expect(workflow).toContain(`  NIGHTLY_NEXTJS_REF: 'v${next.version}'`);
      expect(path.posix.dirname(file)).toBe(path.posix.dirname(upstream));
      expect(file.endsWith('.skipped-in-deploy.test.ts')).toBe(true);
      // Said where it came from, under which license.
      expect(copy).toContain(`// From ${upstream}\n// at ${next.commit} (v${next.version}).`);
      expect(copy).toContain('// Copyright (c) 2025 Vercel, Inc.');
      // Nothing of it asks whether it is deployed, in code or by a gate.
      expect(code(copy)).not.toMatch(/isNextDeploy/u);

      for (const gate of gates(copy)) {
        expect(gate).not.toMatch(/deploy|adapter/u);
      }

      // Every case it is recorded to register, it registers.
      for (const fullName of cases) {
        expect(titles.some((title) => fullName.endsWith(` ${title}`))).toBe(true);
      }
    },
  );

  it('are each written to a file of their own', () => {
    const files = SUPPLEMENTS.map(({ file }) => file);

    expect(new Set(files).size).toBe(files.length);
    expect(SUPPLEMENTS.length).toBeGreaterThan(0);
  });

  it('are written beside their suite where its directory is the one they were copied from', () => {
    const { dir, commit } = checkout({
      [SUITE]: 'upstream\n',
      'test/e2e/app-dir/routes/app/page.js': '',
    });
    const tree = git(dir, 'rev-parse', `HEAD:${path.posix.dirname(SUITE)}`);
    const supplement = supplementOf(commit, tree);

    const written = writeSupplements(dir, [supplement], copies());

    expect(written).toStrictEqual({
      supplements: [{ file: supplement.file, upstream: SUITE, tree, cases: supplement.cases }],
      stale: [],
    });
    expect(readFileSync(path.join(dir, supplement.file), 'utf8')).toContain(
      'answers what deploy mode skips',
    );
    // Upstream's own suite is left as it was.
    expect(readFileSync(path.join(dir, SUITE), 'utf8')).toBe('upstream\n');
  });

  it('are left out and said on another commit, where the directory changed', () => {
    const { dir, commit } = checkout({ [SUITE]: 'upstream\n' });
    const supplement = supplementOf('c'.repeat(40), 'f'.repeat(40));

    const written = writeSupplements(dir, [supplement], copies());

    expect(commit).not.toBe(supplement.next.commit);
    expect(written.supplements).toStrictEqual([]);
    expect(written.stale).toStrictEqual([
      {
        file: supplement.file,
        upstream: SUITE,
        expected: 'f'.repeat(40),
        actual: git(dir, 'rev-parse', `HEAD:${path.posix.dirname(SUITE)}`),
      },
    ]);
    expect(existsSync(path.join(dir, supplement.file))).toBe(false);
  });

  it('are refused on the commit they were copied from, where the directory does not match', () => {
    const { dir, commit } = checkout({ [SUITE]: 'upstream\n' });

    expect(() => writeSupplements(dir, [supplementOf(commit, 'f'.repeat(40))], copies())).toThrow(
      'the commit its copy was taken from',
    );
  });

  it('never replace a file of upstream, nor go anywhere but beside their suite', () => {
    const file = 'test/e2e/app-dir/routes/routes.skipped-in-deploy.test.ts';
    const { dir, commit } = checkout({ [SUITE]: 'upstream\n', [file]: 'upstream too\n' });
    const tree = git(dir, 'rev-parse', `HEAD:${path.posix.dirname(SUITE)}`);

    expect(() => writeSupplements(dir, [supplementOf(commit, tree)], copies())).toThrow(
      'a copy never replaces a file of upstream',
    );
    expect(() => {
      return writeSupplements(
        dir,
        [supplementOf(commit, tree, { file: 'test/e2e/elsewhere/routes.test.ts' })],
        copies(),
      );
    }).toThrow('must be a .test.ts beside it');
  });
});

/** A checkout of Next.js with `MANIFEST`, the suites it names and `SUITE`. */
function nextCheckout() {
  return checkout({
    'test/deploy-tests-manifest.json': JSON.stringify(MANIFEST),
    'test/e2e/excluded/excluded.test.ts': '',
    'test/e2e/both/both.test.ts': '',
    'test/e2e/listed/listed.test.ts': '',
    'test/e2e/clean/clean.test.ts': '',
    [SUITE]: 'upstream\n',
  });
}

describe('the skipped population of a checkout', () => {
  afterEach(cleanUp);

  it('is the manifest’s exclusions and lists, and the copies written into it', () => {
    const { dir, commit } = nextCheckout();
    const tree = git(dir, 'rev-parse', `HEAD:${path.posix.dirname(SUITE)}`);
    const supplement = supplementOf(commit, tree);

    const population = skippedPopulation(dir, [supplement], copies());

    expect(population).toMatchObject({
      version: 1,
      excluded: ['test/e2e/both/both.test.ts', 'test/e2e/excluded/excluded.test.ts'],
      listed: { 'test/e2e/listed/listed.test.ts': ['listed fails', 'listed wavers'] },
      stale: [],
    });
    expect(population.supplements.map(({ file }) => file)).toStrictEqual([supplement.file]);
  });

  it('is written by the workflow’s step, with the manifest the runner is given', () => {
    const { dir } = nextCheckout();
    const output = path.join(temporary(), 'deploy-results');
    const summary = path.join(temporary(), 'summary.md');
    const script = path.resolve(import.meta.dirname, '../src/write-population.ts');

    const run = spawnSync(process.execPath, [script, '--next-dir', dir, '--output', output], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], GITHUB_STEP_SUMMARY: summary },
    });
    const manifest = JSON.parse(
      readFileSync(path.join(output, 'skipped-manifest.json'), 'utf8'),
    ) as DeployManifest;
    const population = JSON.parse(readFileSync(path.join(output, 'population.json'), 'utf8')) as {
      readonly excluded: readonly string[];
      readonly stale: readonly unknown[];
    };

    expect(run.status).toBe(0);
    expect(Object.keys(manifest.suites)).toStrictEqual([
      'test/e2e/both/both.test.ts',
      'test/e2e/excluded/excluded.test.ts',
      'test/e2e/listed/listed.test.ts',
    ]);
    expect(population.excluded).toHaveLength(2);
    // A checkout of another commit, without the copies' directories: every copy is left out, and said.
    expect(population.stale).toHaveLength(SUPPLEMENTS.length);
    expect(readFileSync(summary, 'utf8')).toContain('2 suite(s) the deploy manifest excludes');
  });
});
