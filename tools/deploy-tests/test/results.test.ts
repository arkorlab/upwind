import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { keptSuite, listedSuites } from '../src/results.ts';

const SUITE = 'test/e2e/app-dir/feed/feed.test.ts';
/** A JSON file the script wrote, read back. */
function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(path.join(...segments), 'utf8'));
}

const FAILING_PASSED =
  'Failing test passed even though it was supposed to fail. Remove `.failing` to remove error.';

/** What Jest says of a failure beside its message, which a kept case leaves out as well. */
const DETAIL = { matcherResult: { message: 'at https://app.test' } };

/** A case as Jest writes it, with what a kept one leaves out. */
function jestCase(title: string, status: string, failureMessages: string[] = []) {
  return {
    ancestorTitles: ['feed'],
    title,
    fullName: `feed ${title}`,
    status,
    duration: 12,
    failureMessages,
    failureDetails: failureMessages.map(() => DETAIL),
    invocations: 1,
    location: null,
    numPassingAsserts: 0,
    retryReasons: [],
  };
}

/** A suite's result as the run writes it (`<suite>.results.json`). */
function jestResult(cases: unknown[], extra: Record<string, unknown> = {}) {
  return {
    numRuntimeErrorTestSuites: 0,
    wasInterrupted: false,
    testResults: [
      {
        name: `/home/runner/work/nextjs/${SUITE}`,
        status: 'failed',
        message: 'feed failed at https://app.test/feed',
        assertionResults: cases,
      },
    ],
    ...extra,
  };
}

describe('the suites a shard was to run', () => {
  it('are the test paths its listing names, in its order, and nothing else it printed', () => {
    const listing = [
      'Running tests:',
      `  ${SUITE}`,
      'warning: no timings for this group',
      'test/e2e/app-dir/feed/other.test.tsx  ',
      '',
      'test/e2e/not-a-test.ts',
    ].join('\n');

    expect(listedSuites(listing)).toStrictEqual([SUITE, 'test/e2e/app-dir/feed/other.test.tsx']);
  });
});

describe('a suite kept for a record', () => {
  it('keeps every case’s names and status, and none of what it said', () => {
    const kept = keptSuite(
      SUITE,
      jestResult([
        jestCase('answers', 'passed'),
        jestCase('revalidates', 'failed', ['Error: expected a new value at https://app.test/feed']),
        jestCase('streams', 'pending'),
      ]),
    );

    expect(kept).toStrictEqual({
      path: SUITE,
      status: 'failed',
      interrupted: false,
      runtimeError: false,
      cases: [
        { ancestorTitles: ['feed'], title: 'answers', fullName: 'feed answers', status: 'passed' },
        {
          ancestorTitles: ['feed'],
          title: 'revalidates',
          fullName: 'feed revalidates',
          status: 'failed',
          failure: 'other',
        },
        { ancestorTitles: ['feed'], title: 'streams', fullName: 'feed streams', status: 'pending' },
      ],
    });
    expect(JSON.stringify(kept)).not.toContain('app.test');
  });

  it('says where a failed case failed only because its `test.failing` body completed', () => {
    const kept = keptSuite(
      SUITE,
      jestResult([
        jestCase('expires', 'failed', [FAILING_PASSED]),
        jestCase('expires twice', 'failed', [FAILING_PASSED, 'Error: and something else']),
      ]),
    );

    expect(kept.cases.map((entry) => entry.failure)).toStrictEqual([
      'failing-test-passed',
      'other',
    ]);
  });

  it('is read from the entry Jest wrote for that suite, and says where the run was cut short', () => {
    const raw = jestResult([jestCase('answers', 'passed')], {
      wasInterrupted: true,
      numRuntimeErrorTestSuites: 1,
    });
    raw.testResults.unshift({
      name: '/home/runner/work/nextjs/test/e2e/app-dir/feed/other.test.ts',
      status: 'passed',
      message: '',
      assertionResults: [],
    });

    const kept = keptSuite(SUITE, raw);

    expect(kept.cases).toHaveLength(1);
    expect(kept.interrupted).toBe(true);
    expect(kept.runtimeError).toBe(true);
  });

  it('is refused where the result holds no entry for the suite, or is not Jest’s', () => {
    expect(() => keptSuite('test/e2e/elsewhere.test.ts', jestResult([]))).toThrow(
      'holds no entry for it',
    );
    expect(() => keptSuite(SUITE, [])).toThrow('is not an object');
    expect(() => keptSuite(SUITE, jestResult([{ title: 'answers' }]))).toThrow(
      "a case's status is not a string",
    );
  });
});

describe('a shard’s results kept by the workflow', () => {
  const dirs: string[] = [];
  const script = path.resolve(import.meta.dirname, '../src/keep-results.ts');

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function shard(results: Record<string, string>) {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-keep-results-'));
    dirs.push(base);
    const nextDir = path.join(base, 'nextjs');
    const output = path.join(base, 'deploy-results');
    mkdirSync(path.join(nextDir, 'packages/next'), { recursive: true });
    writeFileSync(path.join(nextDir, 'packages/next/package.json'), '{"version":"16.4.3"}');
    mkdirSync(output);
    writeFileSync(
      path.join(output, 'expected-tests.txt'),
      `${Object.keys(results).join('\n')}\ntest/e2e/never-started.test.ts\n`,
    );
    for (const [suite, body] of Object.entries(results)) {
      mkdirSync(path.join(nextDir, path.dirname(suite)), { recursive: true });
      writeFileSync(path.join(nextDir, `${suite}.results.json`), body);
    }
    const run = spawnSync(process.execPath, [script, '--next-dir', nextDir, '--output', output], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        TARGET: 'host',
        CACHE: 'hosted',
        NEXT_COMMIT: 'n'.repeat(40),
        ADAPTER_COMMIT: 'a'.repeat(40),
        RUN_ID: '7',
        RUN_ATTEMPT: '1',
        STARTED_AT: '2026-10-27T00:00:00Z',
        FINISHED_AT: '2026-10-27T01:00:00Z',
        TESTS: 'all',
        TOTAL: '16',
        SHARD: '3',
      },
    });
    return { run, output };
  }

  it('are who measured what, and each result the shard left, kept', () => {
    const answered = jestResult([jestCase('answers', 'passed')]);
    const { run, output } = shard({
      [SUITE]: JSON.stringify(answered),
      'test/e2e/app-dir/broken/broken.test.ts': '{ not json',
    });

    const metadata = readJson(output, 'metadata.json');
    const feed = readJson(output, 'results', `${SUITE}.json`);
    const broken = path.join(output, 'results/test/e2e/app-dir/broken/broken.test.ts.json');
    const neverStarted = path.join(output, 'results/test/e2e/never-started.test.ts.json');

    expect(run.status).toBe(0);
    expect(metadata).toMatchObject({
      version: 1,
      target: 'host',
      cache: 'hosted',
      next: { version: '16.4.3', commit: 'n'.repeat(40) },
      adapterCommit: 'a'.repeat(40),
      run: {
        id: 7,
        attempt: 1,
        startedAt: '2026-10-27T00:00:00Z',
        finishedAt: '2026-10-27T01:00:00Z',
        selection: 'all',
        shards: 16,
      },
      shard: 3,
    });
    expect(feed).toMatchObject({ path: SUITE, cases: [{ title: 'answers', status: 'passed' }] });
    // A result that cannot be read, and a suite that never started, leave no file.
    expect(existsSync(broken)).toBe(false);
    expect(existsSync(neverStarted)).toBe(false);
    expect(run.stderr).toContain('the result of test/e2e/app-dir/broken/broken.test.ts could not');
    expect(run.stdout).toContain('1 of 3 suite(s) left a result');
  });

  it('refuse to run without the identity of the run they belong to', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-keep-results-'));
    dirs.push(base);
    const run = spawnSync(process.execPath, [script, '--next-dir', base, '--output', base], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] },
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('TESTS is required');
  });
});
