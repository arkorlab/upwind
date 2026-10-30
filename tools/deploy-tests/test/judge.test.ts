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
      'Jest reported an error of the file outside its cases (a hook, or the file itself)',
    );
  });

  it('does not list a case that passed where a reading covers its whole suite', () => {
    const verdict = judged([jestCase('feed native', 'passed')], ON_CLOUDFLARE);

    expect(verdict.passedAnyway).toStrictEqual([]);
  });

  it('fails a suite whose reviewed failure comes with an error of the file’s own', () => {
    const header = jestCase('feed header', 'failed', ['Received: null']);
    const verdict = judged([header], ON_NODE, { runtimeError: true });

    expect(verdict.cases.reviewed.vercel).toBe(1);
    expect(verdict.unexplained).toStrictEqual([
      {
        suite: SUITE,
        why: 'Jest reported an error of the file outside its cases (a hook, or the file itself)',
      },
    ]);
    expect(fails(verdict)).toBe(true);
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
    expect(indentationOnly(INDENTED.replace('+   2 |', '+   2 |\n-'))).toBe(false);
    expect(indentationOnly('Error: expect(received).toBe(expected)')).toBe(false);
  });
});

const NATIVE_CONTAINER =
  'Error: Custom deploy script failed: Progress: resolved 1\nthe server ended before it served:\n' +
  'Error: upwind-app requires a native Node Container, which this local stack does not run';
/** The App Router suite's, whose native route is split off into a Function of its own. */
const NATIVE_SPLIT_CONTAINER =
  'Error: Custom deploy script failed: Progress: resolved 1\nthe server ended before it served:\n' +
  'Error: upwind-app-2 requires a native Node Container, which this local stack does not run';
/** What the App Router suite failed with before #388: refused at build, with no stack to start. */
const NATIVE_REFUSED =
  'Error: Custom deploy script failed: Progress: resolved 1\n> Build error occurred\n' +
  'Error [AuditError]: Unproved Next.js Turbopack consumer graph uncertified duplicate module ' +
  'registration; refusing native publication';

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
  'test/e2e/app-dir/next-dist-client-esm-import/next-dist-client-esm-import.test.ts': [
    "Error: Custom deploy script failed: Progress: resolved 1\n  Creating an optimized production build ...\nFATAL: An unexpected Turbopack error occurred:\n  x Expected ';', got 'ident'\n\nCaused by:\n- failed to parse source code",
  ],
  'test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts': [
    "page.waitForSelector: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#loading-component') to be visible",
  ],
  'test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts': [
    `Error: Timed out waiting for a request to be initiated.\n    at act (${AT}/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts:104:11)`,
  ],
  'test/e2e/prerender-native-module.test.ts': [NATIVE_CONTAINER],
  'test/e2e/app-dir/turbopack-reports/turbopack-reports.test.ts': [NATIVE_SPLIT_CONTAINER],
};

/** An inline snapshot's failure in the trace suite, with these lines of its diff. */
function traceDiff(...lines: string[]): string {
  return [
    'Error: expect(received).toMatchInlineSnapshot(snapshot)',
    '',
    '- Snapshot  - 2',
    '+ Received  + 2',
    '',
    ...lines,
    `    at Object.toMatchInlineSnapshot (${AT}/otel-middleware-trace/otel-middleware-trace.test.ts:206:26)`,
  ].join('\n');
}

const IN_THE_ROUTE_HANDLER = [
  '- [trace A] [remote]',
  '- └─ GET /route-handler (BaseServer.handleRequest) {http.target=/route-handler, http.route=/route-handler, next.route=/route-handler, http.status_code=200}',
];

/** What a case failed with at 16.4.3 where its suite's cases each failed their own way. */
const RECORDED_CASES: Readonly<Record<string, readonly string[]>> = {
  'otel-middleware-trace - proxy (nodejs runtime) traces a page rendered after NextResponse.next()':
    [
      traceDiff(
        '@@ -1,10 +1,8 @@',
        '  [trace A] GET (Next.request) {http.target=/page}',
        '- │  ├─ load instrumentation module (Instrumentation.loadModule)',
        '- │  ├─ prepare route module (RouteModule.prepare)',
        '- │  ├─ register instrumentation (Instrumentation.register)',
        '+ │  ├─ prepare route module (RouteModule.prepare)',
        '  │  └─ render route (app) /page (AppRender.getBodyResult) {next.route=/page}',
      ),
    ],
  'otel-middleware-trace - proxy (nodejs runtime) traces instrumentation registration in the triggering request':
    [
      traceDiff(
        ...IN_THE_ROUTE_HANDLER,
        '+ [trace A] GET (Next.request) {http.target=/page}',
        '+ └─ middleware GET (Middleware.execute) {http.target=/page}',
        '     ├─ load instrumentation module (Instrumentation.loadModule)',
      ),
    ],
  'otel-middleware-trace - middleware (edge runtime) traces instrumentation registration in the triggering request':
    [
      traceDiff(
        ...IN_THE_ROUTE_HANDLER,
        '+ [trace A] GET (Next.request) {http.target=/page}',
        '+ └─ GET /page (BaseServer.handleRequest) {http.target=/page, http.route=/page, next.route=/page, http.status_code=200}',
        '     ├─ load instrumentation module (Instrumentation.loadModule)',
      ),
    ],
};

/** What a reviewed case was read from: Jest's refusal for a deploy gate, else what was recorded. */
function recordedFor(entry: ReviewedCase): readonly string[] {
  if (entry.reading === 'deploy-gate') {
    return [GATE_PASSED];
  }
  return RECORDED_CASES[entry.fullName] ?? RECORDED[entry.suite] ?? [];
}

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

  it('read no other failure of the build-directory cases than the directory', () => {
    const entry = REVIEWED.find(({ record: anchor }) => anchor === 'vercels-build-directory');
    const expected =
      'Expected: "file:///vercel/path0/apps/web/app/import-meta-url-encoded-rsc/with%20space.ts"';

    expect(entry).toBeDefined();

    for (const received of [
      'Received: undefined',
      'Received: "file:///tmp/next-test-1/apps/web/app/import-meta-url-encoded-rsc/with space.ts"',
      'Received: "file:///tmp/next-test-1/apps/web/app/another-file.ts"',
    ]) {
      const { unexplained } = judgedAlone(entry!, 'node', `${expected}\n${received}`);

      expect(unexplained).toHaveLength(1);
    }
  });

  it('read no other change of a trace than where instrumentation was registered', () => {
    const entry = REVIEWED.find(({ fullName }) => fullName.endsWith('after NextResponse.next()'));
    const changed = traceDiff(
      '- │  ├─ load instrumentation module (Instrumentation.loadModule)',
      '- │  ├─ prepare route module (RouteModule.prepare)',
      '- │  ├─ register instrumentation (Instrumentation.register)',
      '- │  └─ render route (app) /page (AppRender.getBodyResult) {next.route=/page}',
      '+ │  ├─ prepare route module (RouteModule.prepare)',
    );

    expect(entry).toBeDefined();
    expect(judgedAlone(entry!, 'cloudflare', changed).unexplained).toHaveLength(1);
  });

  it('no longer read the App Router suite refused at build', () => {
    const entry = REVIEWED.find(({ suite }) => suite.endsWith('turbopack-reports.test.ts'));

    expect(entry).toBeDefined();
    expect(judgedAlone(entry!, 'cloudflare', NATIVE_REFUSED).unexplained).toHaveLength(1);
  });

  it('read the failures they were read from', () => {
    for (const entry of REVIEWED) {
      const messages = recordedFor(entry);
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
function gatedResult(cases: unknown[], runtimeErrors = 0) {
  return {
    numRuntimeErrorTestSuites: runtimeErrors,
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

  function shard(
    results: Record<string, unknown>,
    listed = Object.keys(results),
    runnerFinished = true,
    ended: readonly string[] = [],
  ) {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-judge-results-'));
    dirs.push(base);
    const nextDir = path.join(base, 'nextjs');
    const output = path.join(base, 'deploy-results');
    const summary = path.join(base, 'summary.md');
    mkdirSync(path.join(nextDir, 'packages/next'), { recursive: true });
    writeFileSync(path.join(nextDir, 'packages/next/package.json'), '{"version":"16.4.3"}');
    mkdirSync(output);
    writeFileSync(path.join(output, 'expected-tests.txt'), `${listed.join('\n')}\n`);
    if (runnerFinished) {
      writeFileSync(path.join(output, 'runner-exit-code.txt'), '1\n');
    }
    if (ended.length > 0) {
      writeFileSync(path.join(output, 'watchdog.json'), JSON.stringify({ ended }));
    }
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

  it('fails a shard whose read failure comes with an error of the file’s own', () => {
    // As Jest 29.7 writes an `afterAll` hook's error beside a failed case: the file's runtime error.
    const { run, summary } = shard({ [GATED]: gatedResult([GATED_CASE], 1) });

    expect(run.status).toBe(1);
    expect(readFileSync(summary, 'utf8')).toContain(
      `- \`${GATED}\`: Jest reported an error of the file outside its cases`,
    );
  });

  it('fails a shard whose runner did not finish, though every suite left a result', () => {
    // As on 2026-10-27: every suite's result written, and the runner stopped at its time limit.
    const { run, output, summary } = shard({ [GATED]: gatedResult([GATED_CASE]) }, [GATED], false);
    const verdict = JSON.parse(
      readFileSync(path.join(output, 'verdict.json'), 'utf8'),
    ) as ShardVerdict;

    expect(run.status).toBe(1);
    expect(verdict).toMatchObject({ runnerFinished: false, unexplained: [] });
    expect(readFileSync(summary, 'utf8')).toContain('**1 shard whose runner did not finish:** 3.');
  });

  it('names a suite whose Jest process the watchdog ended, without failing the shard for it', () => {
    const { run, output, summary } = shard({ [GATED]: gatedResult([GATED_CASE]) }, [GATED], true, [
      GATED,
    ]);
    const verdict = JSON.parse(
      readFileSync(path.join(output, 'verdict.json'), 'utf8'),
    ) as ShardVerdict;

    expect(run.status).toBe(0);
    expect(verdict.ended).toStrictEqual([GATED]);
    expect(readFileSync(summary, 'utf8')).toContain(
      `whose Jest process did not exit after its result, and was ended`,
    );
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

  /** A night's run has a lane for each Node.js: one target's shards under each are summed apart. */
  it('sums each lane apart, a target under each Node.js the run names', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-report-results-'));
    dirs.push(base);
    for (const [name, verdict] of [
      ['deploy-results-7-1-node-node24-1', { ...verdictOf(1, 10), node: '24' }],
      ['deploy-results-7-1-node-node26-1', { ...verdictOf(1, 3), node: '26' }],
    ] as const) {
      mkdirSync(path.join(base, name));
      writeFileSync(path.join(base, name, 'verdict.json'), JSON.stringify(verdict));
    }
    const matrix = {
      include: ['24', '26'].flatMap((node) =>
        [1, 2].map((shard) => ({ target: 'node', node, shard })),
      ),
    };
    const run = spawnSync(process.execPath, [script, '--dir', base], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], MATRIX: JSON.stringify(matrix) },
    });
    const [under24, under26] = run.stdout.split('### ').slice(1);

    expect(run.status).toBe(0);
    expect(under24).toContain('`node, Node.js 24`');
    expect(under24).toContain('| 2 | 10 | 1 | 2 | 0 | 0 | 1 | 0 |');
    expect(under24).toContain('**1 shard left no verdict:** 2.');
    expect(under26).toContain('`node, Node.js 26`');
    expect(under26).toContain('| 2 | 3 | 1 | 2 | 0 | 0 | 1 | 0 |');
    expect(under26).toContain('**1 shard left no verdict:** 2.');
  });

  it('finds the one artifact a run kept, unpacked without a directory of its own', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'upwind-report-results-'));
    dirs.push(base);
    mkdirSync(path.join(base, 'results'));
    writeFileSync(path.join(base, 'verdict.json'), JSON.stringify(verdictOf(1, 7)));
    writeFileSync(path.join(base, 'results', 'feed.test.ts.json'), '{}');
    const matrix = { include: [{ target: 'node', shard: 1 }] };
    const run = spawnSync(process.execPath, [script, '--dir', base], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], MATRIX: JSON.stringify(matrix) },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('| 2 | 7 | 1 | 2 | 0 | 0 | 1 | 0 |');
    expect(run.stdout).not.toContain('left no verdict');
  });
});
