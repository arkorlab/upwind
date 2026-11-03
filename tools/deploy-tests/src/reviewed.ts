/**
 * The cases of Next.js's deploy-mode suites whose failure on this machine's targets has been read,
 * and recorded in `REVIEWED.md`, as saying nothing against this adapter. A run's results are judged
 * against them (`judge.ts`): a case read here does not fail its shard, and every other failure does.
 *
 * Each entry holds for one release of Next.js, its version and its commit, and for the failure it
 * was read from: a case that fails in another way, or a run of another release, is read again
 * rather than taken for the same thing.
 */

import {
  anyOf,
  headerMissing,
  inAnotherDirectory,
  indentationOnly,
  inOrder,
  snapshotDiffers,
  type Symptom,
} from './symptoms.ts';

/** The targets on this machine (`target.ts`), which this record is for. */
export type RunnerTarget = 'cloudflare' | 'node';

/** The Node.js versions a run builds and serves the applications under (its lanes), by major. */
export type NodeLine = '24' | '26';

/** Whether `value` names one of the lanes' Node.js versions. */
export function isNodeLine(value: string): value is NodeLine {
  return value === '24' || value === '26';
}

/**
 * How a reviewed case reads:
 * - `deploy-gate`: upstream registers the case `test.failing` when deployed, for what Vercel does not
 *   do, and the body completing here is the case passing.
 * - `vercel`: the case asserts what Vercel's own infrastructure does, which is not the adapter's.
 * - `upstream`: a defect of Next.js or of the test, reproduced without this adapter.
 * - `environment`: the target's runtime cannot run the application, or no deployment can run it as it
 *   is written.
 */
export type Reading = 'deploy-gate' | 'vercel' | 'upstream' | 'environment';

export interface ReviewedCase {
  readonly next: { readonly version: string; readonly commit: string };
  readonly suite: string;
  /** The case's full name, as Jest gives it, or `*` for every case of the suite. */
  readonly fullName: string;
  /** Where the reading holds; on both targets where absent. */
  readonly targets?: readonly RunnerTarget[];
  /** Under which Node.js the reading holds; under every one where absent. */
  readonly nodes?: readonly NodeLine[];
  readonly reading: Reading;
  /** For every reading but `deploy-gate`, whose failure is Jest's own refusal and nothing else. */
  readonly symptom?: Symptom;
  /** The heading of `REVIEWED.md` that records it, as GitHub anchors it. */
  readonly record: string;
  /**
   * Cases of the same suite that must have passed in the same run for the reading to hold: they make
   * the requests the read case makes, so a failure of those requests fails them too, and the read
   * failure is the one recorded rather than one that only looks like it.
   */
  readonly beside?: readonly string[];
}

/** A record's cases: each suite, with the full names of the cases read, or `*` for all of them. */
interface Group extends Pick<
  ReviewedCase,
  'beside' | 'nodes' | 'reading' | 'record' | 'symptom' | 'targets'
> {
  readonly cases: Readonly<Record<string, readonly string[]>>;
}

const GATE: Reading = 'deploy-gate';
/** The lane that builds and serves the applications under Node.js 26. */
const ON_NODE_26: readonly NodeLine[] = ['26'];
/** Both lanes, where each was read: a run that names no lane reads nothing by these. */
const BOTH_LINES: readonly NodeLine[] = ['24', '26'];
/**
 * How a preview request fails where the server could not sign its cookie: the API route answers
 * 500 and sets no cookie, and the pages read without one render as no preview.
 */
const NO_PREVIEW_COOKIE: readonly string[] = [
  'Expected: 200\nReceived: 500',
  'Received has value: null',
  '-   "preview": true,',
  '-   "isPreview": true,',
  'Unexpected end of JSON input',
];
/** How Next.js's harness says the deploy hook failed, the build or the server it starts. */
const DEPLOY_FAILED = 'Custom deploy script failed';
const EVERY_CASE = ['*'];
const OTEL = 'test/e2e/app-dir/otel-middleware-trace/otel-middleware-trace.test.ts';
const TRACE_RECORD = 'instrumentation-registered-per-function';
const ENCODING_RECORD = 'prerender-encoding';
const PREVIEW_RECORD = 'preview-mode-on-nodejs-26';

/** `app-static`'s cases that fetch the same URL with new tags, shared by its custom-handler suite. */
const NEW_TAGS = 'app-dir static/dynamic handling new tags have been specified on subsequent fetch';
/** A run of the two pages said to differ, which answered the same (`app-static.test.ts`). */
const SAME_VALUE = 'expect(received).not.toBe(expected)';
/** How `skip-trailing-slash-redirect`'s App Router half fails: its pages 404, or are never linked. */
const APP_PAGE_NOT_FOUND = inOrder(
  'Expected: 200',
  'Received: 404',
  'skip-trailing-slash-redirect/',
);
const APP_PAGE_NEVER_LINKED = inOrder(
  "waiting for locator('#to-another') to be visible",
  'skip-trailing-slash-redirect/',
);
/** How the `_rsc` request asked again fails the test, and the page it then waits for. */
const DUPLICATE_REQUEST = inOrder(
  'Error: Duplicate request',
  'searchparams-reuse-loading.test.ts:239:',
);
const PARAMS_NEVER_SHOWN = inOrder(
  "waiting for locator('#params') to be visible",
  'searchparams-reuse-loading.test.ts:287:',
);

/** `stream-cancel`'s cases, and the routes each is run on. */
const STREAM_CANCEL = 'streaming responses cancel inner stream after disconnect';
const STREAM_ROUTES = [
  'middleware',
  'edge app route handler',
  'node app route handler',
  'edge pages api',
  'node pages api',
] as const;

/** Where Vercel registers instrumentation for these cases: in the route handler's own Function. */
const REGISTERED_IN_THE_ROUTE_HANDLER = [
  '[trace A] [remote]',
  '└─ GET /route-handler (BaseServer.handleRequest) {http.target=/route-handler, http.route=/route-handler, next.route=/route-handler, http.status_code=200}',
];

const AT_16_4_3: readonly Group[] = [
  {
    reading: GATE,
    record: ENCODING_RECORD,
    cases: {
      'test/e2e/app-dir/prerender-encoding/prerender-encoding.test.ts': [
        'prerender-encoding should preserve an encoded slash in an exact closed catch-all path',
      ],
    },
  },
  {
    reading: GATE,
    record: ENCODING_RECORD,
    targets: ['cloudflare'],
    cases: {
      'test/e2e/app-dir/prerender-encoding/prerender-encoding.test.ts': [
        'prerender-encoding should preserve an encoded slash in an open catch-all fallback',
      ],
    },
  },
  {
    reading: GATE,
    record: ENCODING_RECORD,
    targets: ['node'],
    nodes: BOTH_LINES,
    cases: {
      'test/e2e/app-dir/prerender-encoding/prerender-encoding.test.ts': [
        'prerender-encoding should preserve an encoded slash in an open catch-all fallback',
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
    record: 'segment-cache-metadata',
    targets: ['cloudflare'],
    cases: {
      'test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts': [
        'segment cache (metadata) requests only the head when the page segments are cached',
      ],
    },
  },
  {
    reading: GATE,
    record: 'segment-cache-metadata',
    targets: ['node'],
    nodes: BOTH_LINES,
    cases: {
      'test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts': [
        'segment cache (metadata) requests only the head when the page segments are cached',
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
    symptom: inAnotherDirectory,
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
    record: TRACE_RECORD,
    symptom: snapshotDiffers(
      [
        '│  ├─ load instrumentation module (Instrumentation.loadModule)',
        '│  ├─ prepare route module (RouteModule.prepare)',
        '│  ├─ register instrumentation (Instrumentation.register)',
      ],
      ['│  ├─ prepare route module (RouteModule.prepare)'],
    ),
    cases: {
      [OTEL]: [
        'otel-middleware-trace - proxy (nodejs runtime) traces a page rendered after NextResponse.next()',
      ],
    },
  },
  {
    reading: 'vercel',
    record: TRACE_RECORD,
    symptom: snapshotDiffers(REGISTERED_IN_THE_ROUTE_HANDLER, [
      '[trace A] GET (Next.request) {http.target=/page}',
      '└─ middleware GET (Middleware.execute) {http.target=/page}',
    ]),
    cases: {
      [OTEL]: [
        'otel-middleware-trace - proxy (nodejs runtime) traces instrumentation registration in the triggering request',
      ],
    },
  },
  {
    reading: 'vercel',
    record: TRACE_RECORD,
    symptom: snapshotDiffers(REGISTERED_IN_THE_ROUTE_HANDLER, [
      '[trace A] GET (Next.request) {http.target=/page}',
      '└─ GET /page (BaseServer.handleRequest) {http.target=/page, http.route=/page, next.route=/page, http.status_code=200}',
    ]),
    cases: {
      [OTEL]: [
        'otel-middleware-trace - middleware (edge runtime) traces instrumentation registration in the triggering request',
      ],
    },
  },
  {
    reading: 'upstream',
    record: 'next-dist-client-esm-import',
    symptom: inOrder(DEPLOY_FAILED, "Expected ';', got 'ident'", 'failed to parse source code'),
    cases: {
      'test/e2e/app-dir/next-dist-client-esm-import/next-dist-client-esm-import.test.ts':
        EVERY_CASE,
    },
  },
  {
    reading: 'upstream',
    record: 'app-client-cache',
    // The second wait for the loading state, after the clock moves on: the first follows a wait the
    // document's own load answers, which leaves no prefetch out.
    symptom: inOrder(
      "waiting for locator('#loading') to be visible",
      'client-cache.original.test.ts:386:',
    ),
    // A failed prefetch of this link skips the loading state too. So a failure is read only where the
    // suite's cases that prefetch again after five minutes, and that prefetch a dynamic page in part,
    // passed in the same run.
    beside: [
      'app dir client cache semantics (30s/5min) prefetch={true} should prefetch again after 5 mins if the link is visible again',
      'app dir client cache semantics (30s/5min) prefetch={undefined} - default should prefetch partially a dynamic page',
    ],
    cases: {
      'test/e2e/app-dir/app-client-cache/client-cache.original.test.ts': [
        'app dir client cache semantics (30s/5min) prefetch={undefined} - default should refetch the full page after 5 mins',
      ],
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
    reading: 'upstream',
    record: PREVIEW_RECORD,
    targets: ['node'],
    nodes: ON_NODE_26,
    symptom: (message) => NO_PREVIEW_COOKIE.some((part) => message.includes(part)),
    cases: {
      'test/e2e/prerender-preview/prerender-preview.test.ts': [
        'Prerender Preview Mode should enable preview mode',
        'Prerender Preview Mode should expire cookies with a maxAge',
        'Prerender Preview Mode should set custom path cookies',
        'Prerender Preview Mode should not return fallback page on preview request',
        'Prerender Preview Mode should pass the preview data to API routes',
      ],
      'test/e2e/preview-fallback/preview-fallback.test.ts': [
        'Preview mode with fallback pages should get preview cookie correctly',
        'Preview mode with fallback pages should not write preview index SSG page to cache',
        'Preview mode with fallback pages should not write preview dynamic prerendered SSG page to cache no fallback',
        'Preview mode with fallback pages should not write preview dynamic SSG page to cache no fallback',
        'Preview mode with fallback pages should not write preview dynamic prerendered SSG page to cache with fallback',
        'Preview mode with fallback pages should not write preview dynamic non-prerendered SSG page to cache with fallback',
      ],
      'test/e2e/prerender.test.ts': [
        'Prerender should revalidate on-demand revalidate with preview cookie',
      ],
    },
  },
  {
    reading: 'environment',
    record: 'native-addons-on-nodejs-26',
    nodes: ON_NODE_26,
    symptom: inOrder(DEPLOY_FAILED, 'has no member named', 'GetIsolate'),
    cases: {
      'test/e2e/prerender-native-module.test.ts': EVERY_CASE,
      'test/e2e/app-dir/turbopack-reports/turbopack-reports.test.ts': EVERY_CASE,
    },
  },
  {
    reading: 'environment',
    record: 'slowbuffer-on-nodejs-26',
    targets: ['node'],
    nodes: ON_NODE_26,
    symptom: inOrder('"exposedKeys": ArrayContaining [', '-     "SlowBuffer",'),
    cases: {
      'test/e2e/app-dir/edge-runtime-node-compatibility/edge-runtime-node-compatibility.test.ts': [
        'edge runtime node compatibility [app] supports node:buffer',
        'edge runtime node compatibility [pages/api] supports node:buffer',
      ],
    },
  },
  {
    reading: 'environment',
    record: 'native-addons-on-cloudflare',
    targets: ['cloudflare'],
    symptom: inOrder(
      DEPLOY_FAILED,
      'requires a native Node Container, which this local stack does not run',
    ),
    cases: {
      'test/e2e/prerender-native-module.test.ts': EVERY_CASE,
      'test/e2e/app-dir/turbopack-reports/turbopack-reports.test.ts': EVERY_CASE,
    },
  },
  // What Next.js skips in deploy mode (`population: skipped`).
  {
    reading: 'vercel',
    record: 'a-manifests-crossorigin',
    symptom: inOrder(
      '- Expected  - 1',
      '+ Received  + 1',
      '-   "crossOrigin": "use-credentials",',
      '+   "crossOrigin": null,',
    ),
    cases: {
      'test/e2e/app-dir/metadata/metadata.test.ts': [
        'app dir - metadata basic should support other basic tags',
        'app dir - metadata basic should support other basic tags (edge)',
      ],
    },
  },
  {
    reading: 'vercel',
    record: 'a-fetch-keyed-by-its-tags',
    symptom: inOrder(SAME_VALUE, 'app-static.test.ts:167:'),
    cases: {
      'test/e2e/app-dir/app-static/app-static.test.ts': [
        `${NEW_TAGS} should not fetch from memory cache`,
      ],
      'test/e2e/app-dir/app-static/app-static-custom-handler.test.ts': [
        `${NEW_TAGS} should not fetch from memory cache`,
      ],
    },
  },
  {
    reading: 'vercel',
    record: 'the-_rsc-redirect-outside-minimal-mode',
    symptom: anyOf(DUPLICATE_REQUEST, PARAMS_NEVER_SHOWN),
    cases: {
      'test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts': [
        'searchparams-reuse-loading With Middleware should correctly return different RSC data for full prefetches with different searchParam values',
      ],
    },
  },
  {
    reading: 'upstream',
    record: 'app-router-pages-under-i18n',
    symptom: inOrder('Expected: 404', 'Received: 200', 'i18n-hybrid.test.ts:71:'),
    cases: {
      'test/e2e/app-dir/i18n-hybrid/i18n-hybrid.test.ts': [
        'i18n-hybrid does not resolve /en-CA/blog/first-post',
        'i18n-hybrid does not resolve /en-US/blog/first-post',
        'i18n-hybrid does not resolve /fr-CA/blog/first-post',
        'i18n-hybrid does not resolve /fr-FR/blog/first-post',
      ],
    },
  },
  {
    reading: 'upstream',
    record: 'app-router-pages-under-i18n',
    symptom: anyOf(APP_PAGE_NOT_FOUND, APP_PAGE_NEVER_LINKED),
    cases: {
      'test/e2e/skip-trailing-slash-redirect/index.test.ts': [
        'skip-trailing-slash-redirect app dir - skip trailing slash redirect should not apply trailing slash redirect (with slash)',
        'skip-trailing-slash-redirect app dir - skip trailing slash redirect should not apply trailing slash redirect (without slash)',
        'skip-trailing-slash-redirect app dir - skip trailing slash redirect should preserve original trailing slashes to links on client',
        'skip-trailing-slash-redirect app dir - skip trailing slash redirect should respond to index correctly',
        'skip-trailing-slash-redirect app dir - skip trailing slash redirect should navigate client side correctly',
      ],
    },
  },
  // A stalled stream on each route, read only where the same route's progressing stream passed.
  ...STREAM_ROUTES.map((route): Group => {
    return {
      reading: 'environment',
      record: 'a-disconnect-on-cloudflare',
      targets: ['cloudflare'],
      symptom: inOrder('Exceeded timeout of 2500 ms for a test.', 'stream-cancel.test.ts:'),
      beside: [`${STREAM_CANCEL} ${route} cancels stream making progress`],
      cases: {
        'test/e2e/cancel-request/stream-cancel.test.ts': [
          `${STREAM_CANCEL} ${route} cancels stalled stream`,
          `${STREAM_CANCEL} ${route} cancels stream that never sent data`,
        ],
      },
    };
  }),
  {
    reading: 'environment',
    record: 'a-cache-handler-of-the-applications-own',
    symptom: inOrder(SAME_VALUE, 'app-static.test.ts:189:'),
    cases: {
      'test/e2e/app-dir/app-static/app-static-custom-handler.test.ts': [
        `${NEW_TAGS} should not fetch from memory cache after revalidateTag is used`,
      ],
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

/**
 * The readings above, read again at 16.4.4 (`REVIEWED.md`): their suites are the same at both
 * releases, and the judge holds each to the failure recorded. All but Node.js 26's preview mode,
 * which 16.4.4 signs with fast-jwt, needing no `SlowBuffer`, in suites that changed with it.
 */
const AT_16_4_4: readonly Group[] = AT_16_4_3.filter(({ record }) => record !== PREVIEW_RECORD);

export const REVIEWED: readonly ReviewedCase[] = [
  ...entriesOf(
    { version: '16.4.3', commit: '29bbeab09981148ade186e8599ecdede15abc281' },
    AT_16_4_3,
  ),
  ...entriesOf(
    { version: '16.4.4', commit: 'b175f52b05a5f6c6c39ca72565ea178542be323b' },
    AT_16_4_4,
  ),
];
