import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { INVALIDATED_TAGS_HEADER, invalidatedTagsValue } from '../../core/src/paas/protocol.ts';
import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { configureCacheHandlers, PlatformFetchCache } from '../src/cache/handlers.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

/**
 * A route handler that revalidates a tag. Next.js runs a route handler's revalidations behind its
 * response (`pendingWaitUntil`, in `app-route/module.ts`), and whoever made the request moves on
 * once the headers come — Next.js's own deploy suite does (`app-static`, "should not cache similar
 * iterable request bodies"). Answered before the host had recorded the invalidation, the request
 * after it was answered as though nothing had been invalidated, here or in any other isolate, and
 * what it fetched was written as made before the invalidation.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

/** Next.js's route module, as each test has it answer. */
function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const REVALIDATE = '/api/revalidate';
const HOST_DELAY_MS = 20;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};

/** The router runs for real; only its immutable deployment bundle is supplied by this test. */
function deployment(): Store {
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
      },
      entrypoints: [{ id: REVALIDATE, kind: 'app-route', pathname: REVALIDATE }],
    },
    pathnames: [REVALIDATE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    renderedPages: new Set(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

const route: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [REVALIDATE]: () => ({ handler: route }) } };

function ignore(): void {
  /* The invalidation is the request's to keep going; the test watches the host. */
}

/** The route handler: it answers, and revalidates `feed` behind its answer, as Next.js runs it. */
function revalidatingBehind(): Promise<Response> {
  void new PlatformFetchCache().revalidateTag(['feed'], { expire: 0 }).catch(ignore);
  return Promise.resolve(new Response('revalidated'));
}

/** What the host answers an invalidation of `tags` with: recorded at revision 2. */
function recorded(tags: readonly string[]): Response {
  return Response.json({
    ok: true,
    result: {
      revision: 2,
      affectedEntryIds: [],
      invalidations: tags.map((value, index) => {
        return {
          invalidationId: `invalidation-${String(index)}`,
          tagId: `tag-${String(index)}`,
          value,
          staleAt: Date.now(),
          hardExpireAt: Date.now(),
          meaning: 'immediate',
        };
      }),
    },
  });
}

/** A runtime whose host answers each invalidation as `answer` does, and has no tag on record. */
function hosted(answer: () => Promise<Response>): { runtime: CacheRuntime; asked: string[] } {
  const asked: string[] = [];
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => Date.now(),
    fetchImpl: (request) => {
      if (new URL(request.url).pathname.endsWith('/invalidations')) {
        asked.push(request.url);
        return answer();
      }
      return Promise.resolve(Response.json({ ok: true, result: { tags: [] } }));
    },
  });
  if (runtime === undefined) {
    throw new Error('no runtime');
  }
  configureCacheHandlers(runtime);
  return { runtime, asked };
}

function ask(runtime: CacheRuntime): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${REVALIDATE}`, { method: 'POST' }),
    cache: runtime,
    waitUntil: () => {
      // What goes on behind the answer is the host's to keep; the test watches the answer.
    },
  });
}

/** Whether `promise` has settled by the time the microtasks queued now have run. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  const state = { settled: false };
  const watch = async (): Promise<void> => {
    try {
      await promise;
    } finally {
      state.settled = true;
    }
  };
  void watch().catch(() => {
    // Settled all the same.
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return state.settled;
}

describe('a route handler that revalidates behind its answer', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockReset().mockImplementation(revalidatingBehind);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureCacheHandlers(undefined);
  });

  it('is answered once the host has recorded the invalidation, and not before', async () => {
    const answer = Promise.withResolvers<Response>();
    const host = hosted(() => answer.promise);

    const answering = ask(host.runtime);
    await vi.waitFor(() => {
      expect(host.asked).toHaveLength(1);
    });

    await expect(settledYet(answering)).resolves.toBe(false);

    answer.resolve(recorded(['feed']));
    const response = await answering;

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('revalidated');
  });

  /** Recorded while the answer waited, the invalidation is told to the edge on it. */
  it('tells the edge on its answer what it invalidated', async () => {
    // The host answers a little later than at once, as one across the network does.
    const host = hosted(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(recorded(['feed']));
        }, HOST_DELAY_MS);
      });
    });

    const response = await ask(host.runtime);

    expect(response.headers.get(INVALIDATED_TAGS_HEADER)).toBe(invalidatedTagsValue(['feed']));
  });
});
