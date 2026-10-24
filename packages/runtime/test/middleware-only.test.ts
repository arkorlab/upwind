import { packPrerenders } from '@stayingupwind/core/bundle';
import { MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, WebHandler } from '../src/app-module.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

/**
 * A request for the middleware alone, which the edge makes before it serves a shell and which the
 * middleware Function exists to answer. It is answered from the head of the deployment's manifest —
 * which build it is, and its configuration — and never from the store the app Function builds over
 * every route, prerender and file: the middleware Function's manifest is the head and nothing more
 * (the adapter's `middlewareManifest`), so a store built there would fail, and a whole manifest is
 * what its first request would otherwise read and parse.
 */

const bundle = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), reads: [] as string[] }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    // The Function's own bundle, as its virtual file system serves it.
    readFileSync: ((path: string) => {
      bundle.reads.push(path);
      const bytes = bundle.files.get(path);
      if (bytes === undefined) {
        throw new Error(`no such file ${path}`);
      }
      return Buffer.from(bytes);
    }) as typeof original.readFileSync,
  };
});

// Nothing here renders: the middleware answers, or the Function answers without it.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

const RUNTIME_MANIFEST = '/bundle/runtime.json';
const MIDDLEWARE = '/_middleware';
const BUILD_ID = 'build';
const HEAD = {
  v: 1,
  deploymentId: 'dpl_middlewareOnly',
  nextVersion: '16.3.6',
  buildId: BUILD_ID,
  config: {
    basePath: '/docs',
    trailingSlash: false,
    skipTrailingSlashRedirect: false,
    poweredByHeader: true,
    i18n: null,
  },
};
/** The app Function's manifest: the head, and the tables its store is built from. */
const WHOLE = {
  ...HEAD,
  routing: {
    beforeMiddleware: [],
    middlewareMatchers: [],
    beforeFiles: [],
    afterFiles: [],
    dynamicRoutes: [],
    onMatch: [],
    fallback: [],
    shouldNormalizeNextData: true,
  },
  entrypoints: [],
  prerenders: packPrerenders([]),
  staticFiles: [],
};

/** A middleware that answers with what it was told of the request: a data request, or not. */
const middleware: WebHandler = (request) =>
  Promise.resolve(new Response(request.headers.get('x-nextjs-data') ?? 'absent'));
const app: AppModule = { entries: { [MIDDLEWARE]: () => ({ handler: middleware }) } };

/**
 * A new isolate of the Function `kind` names, over a bundle carrying `manifest`: the runtime's
 * modules are evaluated afresh, so what one test read of its bundle is not kept for the next.
 */
async function isolate(kind: 'app' | 'middleware', manifest: Record<string, unknown>) {
  vi.resetModules();
  vi.stubGlobal('__ARKOR_FUNCTION_KIND__', kind);
  bundle.files.set(RUNTIME_MANIFEST, new TextEncoder().encode(JSON.stringify(manifest)));
  bundle.reads.length = 0;
  const { handleRequest } = await import('../src/handle.ts');
  return (path: string, headers: Record<string, string> = {}) => {
    return handleRequest({
      app,
      edge: { entries: {} },
      request: new Request(`https://app.test${path}`, { headers }),
      waitUntil: () => {
        // Nothing here schedules background work.
      },
    });
  };
}

const ALONE = { [MIDDLEWARE_ONLY_HEADER]: '1' };

describe('a request for the middleware alone', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is answered in the middleware Function from its manifest's head", async () => {
    const ask = await isolate('middleware', HEAD);

    const response = await ask(`/docs/_next/data/${BUILD_ID}/page.json`, ALONE);

    // A data request beneath the base path the head names, as the middleware is told of it.
    await expect(response.text()).resolves.toBe('1');
    expect(bundle.reads).toStrictEqual([RUNTIME_MANIFEST]);
  });

  it('leaves the middleware Function to refuse anything else without reading its bundle', async () => {
    const ask = await isolate('middleware', HEAD);

    const response = await ask('/docs/page');

    expect(response.status).toBe(404);
    expect(bundle.reads).toStrictEqual([]);
  });

  /**
   * The app Function answers one too — the runtime is the same code in both — and reads its
   * manifest for it once: the store its next request builds is built from that same read.
   */
  it('is answered in the app Function from the manifest its store is then built from', async () => {
    const ask = await isolate('app', WHOLE);

    const alone = await ask(`/docs/_next/data/${BUILD_ID}/page.json`, ALONE);
    // A path with a repeated slash is redirected before it is routed, and after the store is built.
    const routed = await ask('/docs//page');

    await expect(alone.text()).resolves.toBe('1');
    expect(routed.status).toBe(308);
    expect(bundle.reads).toStrictEqual([RUNTIME_MANIFEST]);
  });
});
