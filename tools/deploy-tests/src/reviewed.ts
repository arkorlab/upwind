/**
 * The cases of Next.js's deploy-mode suites whose failure on this machine's targets has been read,
 * and recorded in `REVIEWED.md`, as saying nothing against this adapter. A run's results are judged
 * against them (`judge.ts`): a case read here does not fail its shard, and every other failure does.
 *
 * Each entry holds for one release of Next.js, its version and its commit, and for the failure it
 * was read from: a case that fails in another way, or a run of another release, is read again
 * rather than taken for the same thing.
 */

/** The targets on this machine (`target.ts`), which this record is for. */
export type RunnerTarget = 'cloudflare' | 'node';

/**
 * How a reviewed case reads:
 * - `deploy-gate`: upstream registers the case `test.failing` when deployed, for what Vercel does not
 *   do, and the body completing here is the case passing.
 * - `vercel`: the case asserts what Vercel's own infrastructure does, which is not the adapter's.
 * - `upstream`: a defect of Next.js or of the test, reproduced without this adapter.
 * - `environment`: the target's runtime cannot run the application.
 */
export type Reading = 'deploy-gate' | 'vercel' | 'upstream' | 'environment';

/** What a reviewed failure looks like: each of the case's failure messages must answer to it. */
export type Symptom = (message: string) => boolean;

export interface ReviewedCase {
  readonly next: { readonly version: string; readonly commit: string };
  readonly suite: string;
  /** The case's full name, as Jest gives it, or `*` for every case of the suite. */
  readonly fullName: string;
  /** Where the reading holds; on both targets where absent. */
  readonly targets?: readonly RunnerTarget[];
  readonly reading: Reading;
  /** For every reading but `deploy-gate`, whose failure is Jest's own refusal and nothing else. */
  readonly symptom?: Symptom;
  /** The heading of `REVIEWED.md` that records it, as GitHub anchors it. */
  readonly record: string;
}

/** A message that holds each of `parts`, in that order. */
function inOrder(...parts: readonly string[]): Symptom {
  return (message) => {
    let from = 0;
    for (const part of parts) {
      const at = message.indexOf(part, from);
      if (at === -1) {
        return false;
      }
      from = at + part.length;
    }
    return true;
  };
}

const HEADER_NULL = /Expected: "(?:HIT|MISS|PRERENDER)"\nReceived: null\n/u;

/**
 * A response header the test reads, which is not there: `toBe(…)` given `null`, thrown at one of
 * `lines` of `file`.
 */
function headerMissing(file: string, lines: readonly string[]): Symptom {
  return (message) => {
    const thrownAt = message.split('\n').find((line) => line.trimStart().startsWith('at '));
    return (
      HEADER_NULL.test(message) &&
      thrownAt !== undefined &&
      lines.some((line) => thrownAt.includes(`${file}:${line}:`))
    );
  };
}

/**
 * An inline snapshot that differs from what was received in each line's leading whitespace and in
 * nothing else: the lines Jest marks removed and added, in order, are the same once that is taken
 * off.
 */
export function indentationOnly(message: string): boolean {
  const lines = message.split('\n');
  const start = lines.findIndex((line) => line.startsWith('+ Received'));
  if (
    start === -1 ||
    !message.includes('toMatchInlineSnapshot') ||
    lines[start - 1]?.startsWith('- Snapshot') !== true
  ) {
    return false;
  }
  const diff = lines.slice(start + 1);
  const end = diff.findIndex((line) => /^\s+at /u.test(line));
  const changed = end === -1 ? diff : diff.slice(0, end);
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of changed) {
    if (line.startsWith('- ')) {
      removed.push(line.slice(2).trimStart());
    } else if (line.startsWith('+ ')) {
      added.push(line.slice(2).trimStart());
    }
  }
  return removed.length > 0 && removed.join('\n') === added.join('\n');
}

/** A record's cases: each suite, with the full names of the cases read, or `*` for all of them. */
interface Group extends Pick<ReviewedCase, 'reading' | 'record' | 'symptom' | 'targets'> {
  readonly cases: Readonly<Record<string, readonly string[]>>;
}

const GATE: Reading = 'deploy-gate';
const EVERY_CASE = ['*'];

const AT_16_4_3: readonly Group[] = [
  {
    reading: GATE,
    record: 'prerender-encoding',
    cases: {
      'test/e2e/app-dir/prerender-encoding/prerender-encoding.test.ts': [
        'prerender-encoding should preserve an encoded slash in an exact closed catch-all path',
      ],
    },
  },
  {
    reading: GATE,
    record: 'metadata-streaming-parallel-routes',
    cases: {
      'test/e2e/app-dir/metadata-streaming-parallel-routes/metadata-streaming-parallel-routes.test.ts':
        [
          'app-dir - metadata-streaming (parallelRouteMetadata: false) should only bundle the selected metadata resolution implementation',
          'app-dir - metadata-streaming (parallelRouteMetadata: true) should only bundle the selected metadata resolution implementation',
        ],
    },
  },
  {
    reading: GATE,
    record: 'expire-time',
    cases: {
      'test/e2e/app-dir/expire-time/expire-time.test.ts': [
        'expire-time should do a blocking revalidation when the cache entry has expired',
      ],
    },
  },
  {
    reading: 'vercel',
    record: 'x-vercel-cache',
    symptom: headerMissing('cache-components-prerender-matrix.test.ts', [
      '565',
      '578',
      '641',
      '697',
    ]),
    cases: {
      'test/e2e/app-dir/cache-components-prerender-matrix/cache-components-prerender-matrix.test.ts':
        EVERY_CASE,
    },
  },
  {
    reading: 'vercel',
    record: 'x-vercel-cache',
    symptom: headerMissing('partial-fallback-shell-upgrade.test.ts', [
      '300',
      '316',
      '329',
      '371',
      '428',
    ]),
    cases: {
      'test/e2e/app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.test.ts':
        EVERY_CASE,
    },
  },
  {
    reading: 'vercel',
    record: 'build-log-indentation',
    symptom: indentationOnly,
    cases: {
      'test/e2e/app-dir/empty-generate-static-params/empty-generate-static-params.test.ts': [
        'empty-generate-static-params literal empty array points the literal empty array build error at the array',
        'empty-generate-static-params computed empty array points the computed empty array build error at the declaration',
      ],
      'test/e2e/app-dir/use-cache-segment-configs/use-cache-segment-configs.test.ts': [
        "use-cache-segment-configs it should error when using segment configs that aren't supported by useCache",
      ],
    },
  },
  {
    reading: 'vercel',
    record: 'vercels-build-directory',
    symptom: inOrder('Expected: "file:///vercel/path0/'),
    cases: {
      'test/e2e/app-dir/non-root-project-monorepo/non-root-project-monorepo.test.ts': [
        'non-root-project-monorepo import.meta.url should work during RSC',
        'non-root-project-monorepo import.meta.url should work during SSR',
        'non-root-project-monorepo import.meta.url non-url-safe characters should encode special chars during RSC',
        'non-root-project-monorepo import.meta.url non-url-safe characters should encode special chars during SSR',
      ],
    },
  },
  {
    reading: 'vercel',
    record: 'an-html-404-for-a-subresource',
    symptom: inOrder('Expected substring: "text/html"', 'Received string:', '"text/plain'),
    cases: {
      'test/e2e/app-dir/not-found-non-document/not-found-non-document.test.ts': [
        'not-found-non-document returns a plain text 404 for font and manifest requests to unknown paths',
        'not-found-non-document returns a plain text 404 for subresource requests to unknown paths',
      ],
    },
  },
  {
    reading: 'vercel',
    record: 'instrumentation-registered-per-function',
    symptom: inOrder('toMatchInlineSnapshot', 'otel-middleware-trace.test.ts:'),
    cases: {
      'test/e2e/app-dir/otel-middleware-trace/otel-middleware-trace.test.ts': [
        'otel-middleware-trace - proxy (nodejs runtime) traces a page rendered after NextResponse.next()',
        'otel-middleware-trace - proxy (nodejs runtime) traces instrumentation registration in the triggering request',
        'otel-middleware-trace - middleware (edge runtime) traces instrumentation registration in the triggering request',
      ],
    },
  },
  {
    reading: 'upstream',
    record: 'next-dist-client-esm-import',
    symptom: inOrder(
      'Custom deploy script failed',
      "Expected ';', got 'ident'",
      'failed to parse source code',
    ),
    cases: {
      'test/e2e/app-dir/next-dist-client-esm-import/next-dist-client-esm-import.test.ts':
        EVERY_CASE,
    },
  },
  {
    reading: 'upstream',
    record: 'router-autoscroll',
    symptom: inOrder("waiting for locator('#loading-component') to be visible"),
    cases: {
      'test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts': [
        'router autoscrolling on navigation bugs Should apply scroll when loading.js is used',
      ],
    },
  },
  {
    reading: 'upstream',
    record: 'vary-params-base-dynamic',
    symptom: inOrder('Timed out waiting for a request to be initiated.', '    at act ('),
    cases: {
      'test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts':
        EVERY_CASE,
    },
  },
  {
    reading: 'environment',
    record: 'native-addons-on-cloudflare',
    targets: ['cloudflare'],
    symptom: inOrder(
      'Custom deploy script failed',
      '[AuditError]: @stayingupwind/adapter: the app Function would not run:',
      'native Node.js addons',
    ),
    cases: {
      'test/e2e/prerender-native-module.test.ts': EVERY_CASE,
      'test/e2e/app-dir/turbopack-reports/turbopack-reports.test.ts': EVERY_CASE,
    },
  },
];

function entriesOf(next: ReviewedCase['next'], groups: readonly Group[]): readonly ReviewedCase[] {
  const entries: ReviewedCase[] = [];
  for (const { cases, ...reading } of groups) {
    for (const [suite, names] of Object.entries(cases)) {
      for (const fullName of names) {
        entries.push({ next, suite, fullName, ...reading });
      }
    }
  }
  return entries;
}

export const REVIEWED: readonly ReviewedCase[] = entriesOf(
  { version: '16.4.3', commit: '29bbeab09981148ade186e8599ecdede15abc281' },
  AT_16_4_3,
);
