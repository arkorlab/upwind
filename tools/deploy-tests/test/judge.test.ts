import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fails, judge, type Measured, type Verdict } from '../src/judge.ts';
import type { JestCase, JestSuite } from '../src/results.ts';
import { indentationOnly, REVIEWED, type ReviewedCase } from '../src/reviewed.ts';
import type { ShardVerdict } from '../src/verdicts.ts';

const RELEASE = { version: '16.4.3', commit: '29bbeab09981148ade186e8599ecdede15abc281' };
const ON_NODE: Measured = { target: 'node', next: RELEASE };
const ON_CLOUDFLARE: Measured = { target: 'cloudflare', next: RELEASE };
const ANOTHER_COMMIT: Measured = { ...ON_NODE, next: { ...RELEASE, commit: 'c'.repeat(40) } };
const ANOTHER_VERSION: Measured = { ...ON_NODE, next: { ...RELEASE, version: '16.4.4' } };
const SUITE = 'test/e2e/app-dir/feed/feed.test.ts';

const GATE_PASSED =
  'Error: Failing test passed even though it was supposed to fail. Remove `.failing` to remove error.\n' +
  '    at Object.apply (/home/runner/work/upwind/upwind/nextjs/test/lib/e2e-utils/index.ts:66:30)';

function jestCase(fullName: string, status: string, failureMessages: string[] = []): JestCase {
  return {
    ancestorTitles: ['feed'],
    title: fullName,
    fullName,
    status,
    failureMessages: status === 'failed' ? failureMessages : [],
  };
}

function suiteOf(cases: JestCase[], extra: Partial<JestSuite> = {}, at = SUITE): JestSuite {
  return {
    path: at,
    status: cases.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
    interrupted: false,
    runtimeError: false,
    cases,
    ...extra,
  };
}

const READ_HERE: readonly ReviewedCase[] = [
  { next: RELEASE, suite: SUITE, fullName: 'feed gated', reading: 'deploy-gate', record: 'gate' },
  {
    next: RELEASE,
    suite: SUITE,
    fullName: 'feed header',
    reading: 'vercel',
    symptom: (message) => message.includes('Received: null'),
    record: 'header',
  },
  {
    next: RELEASE,
    suite: SUITE,
    fullName: '*',
    targets: ['cloudflare'],
    reading: 'environment',
    symptom: (message) => message.includes('would not run'),
    record: 'native',
  },
];

function judged(cases: JestCase[], measured = ON_NODE, extra: Partial<JestSuite> = {}): Verdict {
  return judge(measured, [SUITE], new Map([[SUITE, suiteOf(cases, extra)]]), READ_HERE);
}

const HEADER_READ = { suite: SUITE, fullName: 'feed header', reading: 'vercel', record: 'header' };

describe('a shard judged against the reviewed cases', () => {
  it('counts what passed and what did not run, and fails on nothing', () => {
    const verdict = judged([jestCase('feed answers', 'passed'), jestCase('feed later', 'pending')]);

    expect(verdict.cases).toStrictEqual({
      passed: 1,
      gates: 0,
      reviewed: { vercel: 0, upstream: 0, environment: 0 },
      skipped: 1,
      failed: 0,
    });
    expect(fails(verdict)).toBe(false);
  });

  it('reads a reviewed failure that answers its symptom, and fails one that does not', () => {
    const read = judged([jestCase('feed header', 'failed', ['Expected: "HIT"\nReceived: null'])]);
    const otherwise = judged([jestCase('feed header', 'failed', ['Received: 500'])]);

    expect(read.cases.reviewed.vercel).toBe(1);
    expect(read.read).toStrictEqual([HEADER_READ]);
    expect(fails(read)).toBe(false);
    expect(otherwise.unexplained).toStrictEqual([
      {
        suite: SUITE,
        fullName: 'feed header',
        why: 'reviewed (header), but it failed otherwise than recorded',
      },
    ]);
    expect(fails(otherwise)).toBe(true);
  });

  it('reads a message without its colours', () => {
    const coloured = 'Expected: "HIT"\n\u{1B}[31mReceived: null\u{1B}[39m';

    expect(judged([jestCase('feed header', 'failed', [coloured])]).cases.reviewed.vercel).toBe(1);
  });

  it('counts a deploy gate failed by Jest’s refusal alone as passed, and fails it otherwise', () => {
    const refused = judged([jestCase('feed gated', 'failed', [GATE_PASSED])]);
    const bodyFailed = judged([jestCase('feed gated', 'passed')]);
    const failedOtherwise = judged([jestCase('feed gated', 'failed', [GATE_PASSED, 'a hook'])]);

    expect(refused.cases).toMatchObject({ passed: 0, gates: 1, failed: 0 });
    expect(fails(refused)).toBe(false);
    expect(bodyFailed.unexplained[0]?.why).toContain('its body failed');
    expect(failedOtherwise.unexplained[0]?.why).toContain("otherwise than by Jest's refusal");
  });

  it('fails a failure nobody reviewed', () => {
    const verdict = judged([jestCase('feed answers', 'failed', ['Expected: 200'])]);

    expect(verdict.unexplained).toStrictEqual([
      { suite: SUITE, fullName: 'feed answers', why: 'not reviewed' },
    ]);
    expect(verdict.cases.failed).toBe(1);
  });

  it('holds a reading to its release and to its targets', () => {
    const header = jestCase('feed header', 'failed', ['Received: null']);
    const native = jestCase('feed native', 'failed', ['the app Function would not run']);

    expect(judged([header], ANOTHER_COMMIT).unexplained[0]?.why).toBe('not reviewed');
    expect(judged([header], ANOTHER_VERSION).unexplained[0]?.why).toBe('not reviewed');
    expect(judged([native], ON_CLOUDFLARE).cases.reviewed.environment).toBe(1);
    expect(judged([native], ON_NODE).unexplained[0]?.why).toBe('not reviewed');
  });

  it('prefers a case’s own reading to its suite’s', () => {
    const header = jestCase('feed header', 'failed', ['Received: null']);

    expect(judged([header], ON_CLOUDFLARE).read).toStrictEqual([HEADER_READ]);
  });

  it('names a suite that left no result, or one that is not Jest’s', () => {
    const results = new Map<string, JestSuite | 'unreadable'>([
      ['test/e2e/broken.test.ts', 'unreadable'],
      [SUITE, suiteOf([jestCase('feed answers', 'passed')])],
    ]);
    const listed = [SUITE, 'test/e2e/never-started.test.ts', 'test/e2e/broken.test.ts'];
    const verdict = judge(ON_NODE, listed, results, READ_HERE);

    expect(verdict.suites).toStrictEqual({
      listed: 3,
      missing: ['test/e2e/never-started.test.ts'],
    });
    expect(verdict.unexplained).toStrictEqual([
      { suite: 'test/e2e/broken.test.ts', why: "its result could not be read as Jest's" },
    ]);
    expect(fails(verdict)).toBe(true);
  });

  it('fails a suite that failed outside its cases', () => {
    const passing = [jestCase('feed answers', 'passed')];

    expect(judged(passing, ON_NODE, { status: 'failed' }).unexplained).toStrictEqual([
      { suite: SUITE, why: 'the suite failed outside its cases' },
    ]);
    expect(judged(passing, ON_NODE, { interrupted: true }).unexplained[0]?.why).toBe(
      'Jest said the run was interrupted',
    );
    expect(judged(passing, ON_NODE, { runtimeError: true }).unexplained[0]?.why).toBe(
      'the file could not run',
    );
  });

  it('lists a case reviewed as failing that passed', () => {
    const verdict = judged([jestCase('feed header', 'passed')]);

    expect(verdict.passedAnyway).toStrictEqual([HEADER_READ]);
    expect(fails(verdict)).toBe(false);
  });
});

const AT = '/home/runner/work/upwind/upwind/nextjs/test/e2e/app-dir';

/** A snapshot of Vercel's build log against Next.js's own (`use-cache-segment-configs`, 16.4.3). */
const INDENTED = [
  'Error: expect(received).toMatchInlineSnapshot(snapshot)',
  '',
  "Snapshot name: `use-cache-segment-configs it should error when using segment configs that aren't supported by useCache 1`",
  '',
  '- Snapshot  - 5',
  '+ Received  + 5',
  '',
  '  "Error: Turbopack build failed with 1 error:',
  '  ./app/runtime/page.tsx:1:14',
  "  > 1 | export const runtime = 'edge'",
  '- |              ^^^^^^^',
  '+     |              ^^^^^^^',
  '- 2 |',
  '+   2 |',
  '  Ecmascript file had an error',
  '- at ignore-listed frames"',
  '+     at ignore-listed frames"',
  `    at Object.toMatchInlineSnapshot (${AT}/use-cache-segment-configs/use-cache-segment-configs.test.ts:83:11)`,
].join('\n');

describe('a snapshot that differs in indentation alone', () => {
  it('is one whose removed and added lines are the same without their leading whitespace', () => {
    expect(indentationOnly(INDENTED)).toBe(true);
  });

  it('is not one whose words differ, nor a message that is not a snapshot’s', () => {
    expect(indentationOnly(INDENTED.replace('+   2 |', '+   3 |'))).toBe(false);
    expect(indentationOnly('Error: expect(received).toBe(expected)')).toBe(false);
  });
});

const NATIVE_ADDON =
  'Error: Custom deploy script failed: Progress: resolved 1\n> Build error occurred\n' +
  'Error [AuditError]: @stayingupwind/adapter: the app Function would not run:\n' +
  '  - a load the bundler could not follow: bindings/index.js:30: require(binary)\n\n' +
  'This Function also traces native Node.js addons from these server entries:';

/** What each reviewed suite failed with at 16.4.3, cut short: the parts its symptom reads. */
const RECORDED: Readonly<Record<string, readonly string[]>> = {
  'test/e2e/app-dir/cache-components-prerender-matrix/cache-components-prerender-matrix.test.ts': [
    `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "HIT"\nReceived: null\n    at toBe (${AT}/cache-components-prerender-matrix/cache-components-prerender-matrix.test.ts:565:63)`,
    `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "MISS"\nReceived: null\n    at Object.toBe (${AT}/cache-components-prerender-matrix/cache-components-prerender-matrix.test.ts:697:66)`,
  ],
  'test/e2e/app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.test.ts': [
    `Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "HIT"\nReceived: null\n    at toBe (${AT}/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.test.ts:300:69)`,
  ],
  'test/e2e/app-dir/empty-generate-static-params/empty-generate-static-params.test.ts': [INDENTED],
  'test/e2e/app-dir/use-cache-segment-configs/use-cache-segment-configs.test.ts': [INDENTED],
  'test/e2e/app-dir/non-root-project-monorepo/non-root-project-monorepo.test.ts': [
    'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "file:///vercel/path0/apps/web/app/import-meta-url-rsc/page.tsx"\nReceived: "file:///tmp/next-test-1/apps/web/app/import-meta-url-rsc/page.tsx"',
  ],
  'test/e2e/app-dir/not-found-non-document/not-found-non-document.test.ts': [
    'Error: expect(received).toContain(expected) // indexOf\n\nExpected substring: "text/html"\nReceived string:    "text/plain; charset=utf-8"',
  ],
  'test/e2e/app-dir/otel-middleware-trace/otel-middleware-trace.test.ts': [
    `Error: expect(received).toMatchInlineSnapshot(snapshot)\n\n- Snapshot  - 3\n+ Received  + 1\n\n- │  ├─ register instrumentation (Instrumentation.register)\n    at Object.toMatchInlineSnapshot (${AT}/otel-middleware-trace/otel-middleware-trace.test.ts:206:26)`,
  ],
  'test/e2e/app-dir/next-dist-client-esm-import/next-dist-client-esm-import.test.ts': [
    "Error: Custom deploy script failed: Progress: resolved 1\n  Creating an optimized production build ...\nFATAL: An unexpected Turbopack error occurred:\n  x Expected ';', got 'ident'\n\nCaused by:\n- failed to parse source code",
  ],
  'test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts': [
    "page.waitForSelector: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#loading-component') to be visible",
  ],
  'test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts': [
    `Error: Timed out waiting for a request to be initiated.\n    at act (${AT}/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts:104:11)`,
  ],
  'test/e2e/prerender-native-module.test.ts': [NATIVE_ADDON],
  'test/e2e/app-dir/turbopack-reports/turbopack-reports.test.ts': [NATIVE_ADDON],
};

/** A heading's anchor, as GitHub makes it. */
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .replaceAll(/\s/gu, '-');
}

/** A reviewed case judged on its own, failed with `message`. */
function judgedAlone(entry: ReviewedCase, target: Measured['target'], message: string): Verdict {
  const name = entry.fullName === '*' ? 'any case' : entry.fullName;
  const result = suiteOf([jestCase(name, 'failed', [message])], {}, entry.suite);
  return judge(
    { target, next: entry.next },
    [entry.suite],
    new Map([[entry.suite, result]]),
    REVIEWED,
  );
}

describe('the reviewed cases', () => {
  const record = readFileSync(path.resolve(import.meta.dirname, '../REVIEWED.md'), 'utf8');
  const headings = record.split('\n').filter((line) => line.startsWith('#'));
  const anchors = new Set(headings.map((line) => anchorOf(line.replace(/^#+\s*/u, ''))));

  it('each have a heading of REVIEWED.md', () => {
    const unrecorded = REVIEWED.filter(({ record: anchor }) => !anchors.has(anchor));

    expect(unrecorded).toStrictEqual([]);
  });

  it('read a deploy gate by Jest’s refusal alone, and every other case by a symptom', () => {
    const misread = REVIEWED.filter(
      ({ reading, symptom }) => (reading === 'deploy-gate') === (symptom !== undefined),
    );

    expect(misread).toStrictEqual([]);
  });

  it('read no case twice on one target', () => {
    const keys = REVIEWED.flatMap((entry) => {
      return (entry.targets ?? ['cloudflare', 'node']).map(
        (target) => `${entry.next.commit} ${target} ${entry.suite} ${entry.fullName}`,
      );
    });

    expect(keys).toHaveLength(new Set(keys).size);
  });

  it('read the failures they were read from', () => {
    for (const entry of REVIEWED) {
      const messages =
        entry.reading === 'deploy-gate' ? [GATE_PASSED] : (RECORDED[entry.suite] ?? []);
      const targets = entry.targets ?? (['cloudflare', 'node'] as const);

      expect(messages).not.toHaveLength(0);

      for (const target of targets) {
        for (const message of messages) {
          const { unexplained } = judgedAlone(entry, target, message);

          expect({ suite: entry.suite, unexplained }).toStrictEqual({
            suite: entry.suite,
            unexplained: [],
          });
        }
      }
    }
  });
});

const GATED = 'test/e2e/app-dir/expire-time/expire-time.test.ts';
const GATED_CASE = {
  ancestorTitles: ['expire-time'],
  title: 'should do a blocking revalidation when the cache entry has expired',
  fullName: 'expire-time should do a blocking revalidation when the cache entry has expired',
  status: 'failed',
  failureMessages: [GATE_PASSED],
};

/** The gated suite's result as the run writes it (`<suite>.results.json`). */
function gatedResult(cases: unknown[]) {
  return {
    numRuntimeErrorTestSuites: 0,
    wasInterrupted: false,
    testResults: [
      { name: `/home/runner/work/nextjs/${GATED}`, status: 'failed', assertionResults: cases },
    ],
  };
}

describe('a shard judged by the workflow', () => {
  const dirs: string[] = [];
  const script = path.resolve(import.meta.dirname, '../src/judge-results.ts');

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function shard(results: Record<string, unknown>, listed = Object.keys(results)) {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-judge-results-'));
    dirs.push(base);
    const nextDir = path.join(base, 'nextjs');
    const output = path.join(base, 'deploy-results');
    const summary = path.join(base, 'summary.md');
    mkdirSync(path.join(nextDir, 'packages/next'), { recursive: true });
    writeFileSync(path.join(nextDir, 'packages/next/package.json'), '{"version":"16.4.3"}');
    mkdirSync(output);
    writeFileSync(path.join(output, 'expected-tests.txt'), `${listed.join('\n')}\n`);
    for (const [suite, body] of Object.entries(results)) {
      mkdirSync(path.join(nextDir, path.dirname(suite)), { recursive: true });
      writeFileSync(path.join(nextDir, `${suite}.results.json`), JSON.stringify(body));
    }
    const run = spawnSync(process.execPath, [script, '--next-dir', nextDir, '--results', output], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        TARGET: 'node',
        SHARD: '3',
        NEXT_COMMIT: RELEASE.commit,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return { run, output, summary };
  }

  it('passes a shard whose failures are all read, and keeps its verdict beside its results', () => {
    const { run, output, summary } = shard({ [GATED]: gatedResult([GATED_CASE]) });
    const verdict = JSON.parse(
      readFileSync(path.join(output, 'verdict.json'), 'utf8'),
    ) as ShardVerdict;

    expect(run.status).toBe(0);
    expect(verdict).toMatchObject({
      target: 'node',
      shard: 3,
      next: RELEASE,
      cases: { passed: 0, gates: 1, failed: 0 },
      read: [{ suite: GATED, reading: 'deploy-gate', record: 'expire-time' }],
    });
    expect(JSON.stringify(verdict)).not.toContain('Failing test passed');
    expect(readFileSync(summary, 'utf8')).toContain('### `node`, Next.js 16.4.3 (29bbeab09981)');
  });

  it('fails a shard with a failure nobody reviewed, or a suite that left no result', () => {
    const unread = {
      ...GATED_CASE,
      fullName: 'expire-time something else',
      failureMessages: ['Error: 500'],
    };
    const listed = [GATED, 'test/e2e/never-started.test.ts'];
    const { run, summary } = shard({ [GATED]: gatedResult([unread]) }, listed);
    const text = readFileSync(summary, 'utf8');

    expect(run.status).toBe(1);
    expect(text).toContain(`- \`${GATED}\` › expire-time something else: not reviewed (shard 3)`);
    expect(text).toContain('- `test/e2e/never-started.test.ts`: left no result (shard 3)');
  });
});

function verdictOf(shard: number, passed: number): ShardVerdict {
  return {
    version: 1,
    target: 'node',
    next: RELEASE,
    shard,
    suites: { listed: 2, missing: [] },
    cases: {
      passed,
      gates: 1,
      reviewed: { vercel: 2, upstream: 0, environment: 0 },
      skipped: 1,
      failed: 0,
    },
    unexplained: [],
    read: [],
    passedAnyway: [],
  };
}

describe('a run’s verdicts summed for its report', () => {
  const dirs: string[] = [];
  const script = path.resolve(import.meta.dirname, '../src/report-results.ts');

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('sums each target’s shards and names those that left no verdict', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-report-results-'));
    dirs.push(base);
    for (const [name, verdict] of [
      ['deploy-results-7-1-node-1', verdictOf(1, 10)],
      ['deploy-results-7-1-node-3', verdictOf(3, 5)],
    ] as const) {
      mkdirSync(path.join(base, name));
      writeFileSync(path.join(base, name, 'verdict.json'), JSON.stringify(verdict));
    }
    const matrix = { include: [1, 2, 3].map((shard) => ({ target: 'node', shard })) };
    const run = spawnSync(process.execPath, [script, '--dir', base], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], MATRIX: JSON.stringify(matrix) },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('| 4 | 15 | 2 | 4 | 0 | 0 | 2 | 0 |');
    expect(run.stdout).toContain('**1 shard left no verdict:** 2.');
  });
});
