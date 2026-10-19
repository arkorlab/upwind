import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { describe, expect, it } from 'vitest';

import { type CheckedStack, type KeptMiddlewareResult, middlewareCovers } from '../src/answers.ts';
import { handedOnVerdict, rewriteStatusVerdict } from '../src/part-handoffs.ts';
import type { Part } from '../src/part-marks.ts';

const AT = '2026-10-19T00:00:00.000Z';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function dataRequest(): { readonly stack: CheckedStack; readonly part: Part } {
  const site = new URL('https://site.example');
  const route: RouteEntry = {
    pathname: '/about',
    status: 200,
    headers: {},
    shell: {
      sha256: EMPTY_SHA,
      byteLength: 0,
      contentType: 'text/html',
      encoding: 'identity',
    },
    pagesData: {
      artifact: {
        sha256: EMPTY_SHA,
        byteLength: 0,
        contentType: 'application/json',
        encoding: 'identity',
      },
    },
  };
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: AT,
    originHost: site.hostname,
    deployment: { assetSetHash: EMPTY_SHA, observedAt: AT },
    app: { deploymentId: 'dpl_site', scriptName: 'app', middlewareScriptName: 'app' },
    routes: [route],
    pagesDataUnder: { basePath: '', buildId: 'build' },
  });
  return {
    stack: {
      url: site,
      site,
      backstage: new URL('/_backstage/', site),
      functions: [],
      bundleDir: '.',
      deploymentId: 'dpl_site',
      manifest,
      app: manifest.app,
      policy: { ...DEFAULT_DELIVERY_POLICY, id: 'default' },
      cspNonce: undefined,
      dispose: () => Promise.resolve(),
      bundle: {
        v: 1,
        deploymentId: 'dpl_site',
        nextVersion: '16.4.2',
        buildId: 'build',
        projectDir: '.',
        generatedAt: AT,
        config: {
          basePath: '',
          trailingSlash: false,
          skipTrailingSlashRedirect: true,
          poweredByHeader: false,
        },
        routing: {
          beforeMiddleware: [],
          middlewareMatchers: [],
          beforeFiles: [],
          afterFiles: [],
          dynamicRoutes: [],
          onMatch: [],
          fallback: [],
          shouldNormalizeNextData: false,
          rsc: {
            header: 'rsc',
            varyHeader: 'rsc',
            prefetchHeader: 'next-router-prefetch',
            didPostponeHeader: 'x-nextjs-postponed',
            contentTypeHeader: 'text/x-component',
            suffix: '.rsc',
            prefetchSegmentHeader: 'next-router-segment-prefetch',
            prefetchSegmentSuffix: '.segment.rsc',
            prefetchSegmentDirSuffix: '.segments',
          },
        },
        entrypoints: [],
        prerenders: [],
        staticFiles: [],
        middleware: { matchers: [{ sourceRegex: '^.*$' }] },
        functions: {
          app: {
            mainModule: 'index.mjs',
            modules: [],
            compatibilityDate: AT.slice(0, 10),
            compatibilityFlags: [],
          },
        },
      },
    },
    part: {
      kind: 'data',
      what: 'props',
      url: new URL('/_next/data/build/about.json', site),
      headers: {},
      built: route.pagesData?.artifact,
      route,
      builtOn: (entry) => entry.pagesData?.artifact,
      exact: true,
    },
  };
}

function continued(rewriteStatus: number | undefined): KeptMiddlewareResult {
  return {
    kind: 'continue',
    url: new URL('https://site.example/about'),
    rewritten: false,
    requestHeaders: new Headers(),
    responseHeaders: new Headers(),
    setCookie: undefined,
    rewriteStatus,
  };
}

describe('a document or part handed on for a captured middleware rewrite status', () => {
  it.each([404, 418])(
    'accepts a captured %s rewrite even when the URL stays the same',
    (status) => {
      const decided = continued(status);

      expect(rewriteStatusVerdict(decided, true)).toStrictEqual({
        kind: 'skipped',
        reason: "the application's middleware gave its rewrite a status",
      });
    },
  );

  it('rejects the diagnostic reason when no rewrite status was captured', () => {
    const decided = continued(undefined);

    expect(rewriteStatusVerdict(decided, true).kind).toBe('failed');
  });

  it('rejects the diagnostic reason when no middleware answer was kept', () => {
    expect(rewriteStatusVerdict(undefined, true).kind).toBe('failed');
  });

  it('rejects a captured rewrite when the build has no applicable middleware', () => {
    const decided = continued(404);

    expect(rewriteStatusVerdict(decided, false).kind).toBe('failed');
  });

  it('rejects a Pages data rewrite-status handoff even with a captured applicable rewrite', () => {
    const { stack, part } = dataRequest();
    const decided = continued(404);
    const covered = middlewareCovers(stack, part.url, part.headers);
    const verdict = handedOnVerdict(stack, part, {
      answered: 'passthrough;reason=rewrite-status',
      decided,
      covered,
      asked: {},
    });

    expect(covered).toBe(true);
    expect(verdict).toStrictEqual({
      kind: 'failed',
      reason:
        "handed on for a reason the edge gives no request of the router's (x-arkor-edge: passthrough;reason=rewrite-status)",
    });
  });
});
