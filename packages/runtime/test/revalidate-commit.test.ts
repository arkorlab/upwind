import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  IMPLICIT_TAG_PREFIX,
  policyFromBuild,
  sharedShellTagOf,
} from '@stayingupwind/core/cache';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import {
  type CurrentGeneration,
  currentGeneration,
  type CurrentLookup,
} from '../src/cache/current.ts';
import type { FetchLike } from '../src/cache/host.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';
import { fakeAuthority } from './authority.ts';

/**
 * What a Pages Router `res.revalidate(urlPath)` waits for, against an authority in memory, now
 * that a regeneration answers once its render is made and commits behind: the commit, all the
 * same. Its caller answers its own caller that the page has been revalidated once the call
 * resolves, and a call that resolved with the render said so of a page the host might then refuse.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_revalidateCommitTest00';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const ROUTE = '/posts/[slug]';
const PATH = '/posts/a';
/** How long a test lets a call it expects to wait go on waiting before it says it did. */
const PATIENCE_MS = 100;
const STILL_WAITING = 'still waiting';
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [ROUTE]: () => ({ handler: page }) } };

/** A Pages Router route the build left to its first request: the shell of its class, no body. */
function deployment(): Store {
  const prerender: Prerender = {
    id: ROUTE,
    pathname: ROUTE,
    route: ROUTE,
    parentOutputId: ROUTE,
    groupId: 1,
  };
  return {
    manifest: {
      buildId: 'build',
      entrypoints: [{ pathname: ROUTE, kind: 'pages' }],
      config: { basePath: '', i18n: null },
    },
    prerendersByPathname: new Map<string, Prerender>(),
    shellsByRoute: new Map([
      [ROUTE, { pages: new Map(), patterns: [{ pattern: /^\/posts\/[^/]+$/u, prerender }] }],
    ]),
  } as unknown as Store;
}

/** The commits the authority is sent, each answered once released, and as `answer` says. */
function heldCommits(
  inner: FetchLike,
  answer?: () => Response,
): { fetchImpl: FetchLike; arrived: Promise<unknown>; release: () => void } {
  const gate = Promise.withResolvers<true>();
  const arrived = Promise.withResolvers<true>();
  return {
    fetchImpl: async (request) => {
      const answered = await inner(request);
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/commit')) {
        return answered;
      }
      arrived.resolve(true);
      await gate.promise;
      return answer?.() ?? answered;
    },
    arrived: arrived.promise,
    release: () => {
      gate.resolve(true);
    },
  };
}

function runtimeFor(fetchImpl: FetchLike): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/** `res.revalidate(PATH)`, called from a request this runtime answers. */
function revalidate(
  runtime: CacheRuntime,
  invalidated = new InvalidatedTags(),
  pathname = PATH,
): Promise<void> {
  const request = new Request(`${HOST}/api/revalidate`);
  const context = {
    tables: { app, edge: { entries: {} } },
    runtime,
    request,
    startedAt: T0,
    fetchStarts: new Map<string, number>(),
    waitUntil: () => {
      // What the regeneration hands the runtime is what the call itself waits on.
    },
    run: <T>(work: () => Promise<T>) => work(),
    invalidated,
    writes: new RequestWrites(),
  };
  return withClock(T0, () =>
    withRequestContext(context, () => platformRevalidate({ urlPath: pathname })),
  );
}

/** What `promise` comes to within `PATIENCE_MS`, or that it is still waiting then. */
async function within<T>(promise: Promise<T>): Promise<T | typeof STILL_WAITING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Promise<typeof STILL_WAITING>((resolve) => {
    timer = setTimeout(() => {
      resolve(STILL_WAITING);
    }, PATIENCE_MS);
  });
  try {
    return await Promise.race([promise, waiting]);
  } finally {
    clearTimeout(timer);
  }
}

describe('res.revalidate() with a regeneration that commits behind its render', () => {
  beforeEach(() => {
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      new Response('<html>post a</html>', {
        headers: { 'content-type': 'text/html', 'cache-control': 's-maxage=60' },
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is still waiting while the commit is unanswered, and resolves once it publishes', async () => {
    const authority = fakeAuthority(SCOPE);
    const commit = heldCommits(authority.fetchImpl);
    const runtime = runtimeFor(commit.fetchImpl);

    const revalidating = revalidate(runtime);
    await commit.arrived;
    const before = await within(revalidating);
    commit.release();

    expect(before).toBe(STILL_WAITING);
    await expect(revalidating).resolves.toBeUndefined();
    expect(authority.commits).toHaveLength(1);
  });

  it('is still waiting while the commit is unanswered, and throws once it is refused', async () => {
    const authority = fakeAuthority(SCOPE);
    const commit = heldCommits(authority.fetchImpl, () =>
      Response.json({ ok: true, result: { kind: 'lease-expired' } }),
    );
    const runtime = runtimeFor(commit.fetchImpl);
    vi.spyOn(runtime, 'log').mockImplementation(() => {
      /* The refusal is logged, which is not what this test reads. */
    });

    const revalidating = revalidate(runtime);
    await commit.arrived;
    const before = await within(revalidating);
    commit.release();

    expect(before).toBe(STILL_WAITING);
    await expect(revalidating).rejects.toThrow('was not regenerated (refused)');
  });
});

/** A built class which every slug resumes, rather than one generation per concrete slug. */
function sharedDeployment(): Store {
  const store = deployment();
  const prerender: Prerender = {
    id: ROUTE,
    route: ROUTE,
    pathname: ROUTE,
    parentOutputId: ROUTE,
    groupId: 1,
    routeType: 'shell',
    response: 'initial',
    compute: 'resuming',
    renderingMode: 'PARTIALLY_STATIC',
    body: { sha256: 'build-html', byteLength: 3, contentType: 'text/html' },
    postponed: { sha256: 'build-state', byteLength: 5, contentType: 'text/plain' },
    allowQuery: [],
  };
  return {
    ...store,
    manifest: {
      ...store.manifest,
      config: { ...store.manifest.config, cacheComponents: true },
      entrypoints: [{ id: ROUTE, pathname: ROUTE, kind: 'app-page' }],
    },
    pathnames: [ROUTE],
    slashSpellings: new Map(),
    shellsByRoute: new Map([
      [ROUTE, { pages: new Map(), patterns: [{ pattern: /^\/posts\/[^/]+$/u, prerender }] }],
    ]),
  };
}

async function captureShared(call: InvokeInput): Promise<Response> {
  const capture = call.requestMeta['onCacheEntryV2'] as (
    entry: unknown,
    meta: { url: string | undefined },
  ) => Promise<unknown>;
  await capture(
    {
      value: {
        kind: 'APP_PAGE',
        html: { toUnchunkedString: () => '<html>new shell</html>' },
        headers: { 'content-type': 'text/html' },
        status: 200,
        postponed: 'new dynamic state',
      },
      cacheControl: { revalidate: 60, expire: 3600 },
    },
    { url: call.url },
  );
  return new Response(null);
}

describe('manual regeneration of a concrete member whose value holds brackets', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { pathname: '/posts/[literal]', parentFallbackMode: null },
    { pathname: ROUTE, parentFallbackMode: null },
    { pathname: ROUTE, parentFallbackMode: false },
  ])(
    'keeps the exact tag of $pathname with parent fallback $parentFallbackMode',
    async (sample) => {
      const prerender: Prerender = {
        id: sample.pathname,
        pathname: sample.pathname,
        route: ROUTE,
        parentOutputId: ROUTE,
        groupId: 1,
        routeType: 'page',
        parentFallbackMode: sample.parentFallbackMode,
        body: { sha256: 'build-member', byteLength: 3, contentType: 'text/html' },
      };
      const store: Store = {
        ...sharedDeployment(),
        pathnames: [sample.pathname],
        prerendersByPathname: new Map([[sample.pathname, prerender]]),
        shellsByRoute: new Map([
          [ROUTE, { pages: new Map([[sample.pathname, prerender]]), patterns: [] }],
        ]),
      };
      vi.mocked(getStore).mockReturnValue(store);
      // No native cache-tag header: the runtime must supply its implicit identities itself.
      vi.mocked(invokeNodeHandler).mockImplementation(captureShared);
      const authority = fakeAuthority(SCOPE);
      const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: sample.pathname };
      const { entryId } = await deriveEntry(SCOPE, descriptor);

      await revalidate(runtimeFor(authority.fetchImpl), undefined, sample.pathname);

      const tags = authority.commits[0]?.generation.tags.map((tag) => tag.value);

      expect(authority.commits).toHaveLength(1);
      expect(tags).toContain(`${IMPLICIT_TAG_PREFIX}${sample.pathname}`);
      expect(tags).not.toContain(sharedShellTagOf(entryId));
    },
  );
});

type FailureStage = 'render' | 'upload' | 'commit';

/** Fail the selected publication stage and record whether regeneration reached it. */
function failedRegeneration(
  authority: ReturnType<typeof fakeAuthority>,
  stage: FailureStage,
): { fetchImpl: FetchLike; reached: () => boolean } {
  let reached = false;
  const fetchImpl: FetchLike = (request) => {
    const pathname = new URL(request.url).pathname;
    if (stage === 'upload' && request.method === 'POST' && pathname.includes('/artifacts')) {
      reached = true;
      return Promise.reject(new Error('upload failed'));
    }
    if (stage === 'commit' && pathname.endsWith('/commit')) {
      reached = true;
      return Promise.resolve(Response.json({ ok: true, result: { kind: 'lease-expired' } }));
    }
    return authority.fetchImpl(request);
  };
  if (stage === 'render') {
    vi.mocked(invokeNodeHandler).mockImplementationOnce(() => {
      reached = true;
      return Promise.reject(new Error('render failed'));
    });
  }
  return { fetchImpl, reached: () => reached };
}

/** Narrow a lookup only after checking that it actually returned a generation. */
function requireGeneration(lookup: CurrentLookup): CurrentGeneration {
  if (lookup.kind !== 'generation') {
    throw new Error('the shared generation was lost');
  }
  return lookup.current;
}

describe('manual revalidation of a shared shell with a last good generation', () => {
  const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: ROUTE };
  const encoder = new TextEncoder();

  async function seed(authority: ReturnType<typeof fakeAuthority>): Promise<void> {
    const { entryId } = await deriveEntry(SCOPE, descriptor);
    await authority.record(
      descriptor,
      {
        cacheTimestamp: T0 - 1000,
        policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 3600 }),
        status: 200,
        headers: { 'content-type': 'text/html' },
        tags: [{ kind: 'next-implicit', value: sharedShellTagOf(entryId) }],
        postponed: encoder.encode('old dynamic state'),
      },
      encoder.encode('<html>old shell</html>'),
      'build',
    );
  }

  beforeEach(() => {
    vi.mocked(getStore).mockReturnValue(sharedDeployment());
    vi.mocked(invokeNodeHandler).mockReset().mockImplementation(captureShared);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['render', 'upload', 'commit'] as const)(
    'keeps the old shell fresh when the %s fails',
    async (stage) => {
      const authority = fakeAuthority(SCOPE, { keepOutputs: true, handsBackRecords: true });
      await seed(authority);
      const failure = failedRegeneration(authority, stage);
      const runtime = runtimeFor(failure.fetchImpl);
      vi.spyOn(runtime, 'log').mockImplementation(() => {
        // The expected failure is logged; this test checks the retained generation.
      });
      const invalidated = new InvalidatedTags();

      await expect(revalidate(runtime, invalidated)).rejects.toThrow('was not regenerated');

      const after = await currentGeneration(runtime, descriptor, T0, () => {
        // This fresh-record lookup does not schedule background work.
      });

      expect(after.kind).toBe('generation');

      const current = requireGeneration(after);

      expect(current.validity).toBe('fresh');
      expect(failure.reached()).toBe(true);
      expect(new TextDecoder().decode(current.pack.html)).toBe('<html>old shell</html>');
      expect(invalidated.tags.size).toBe(0);
      expect(authority.calls).not.toContain('POST /invalidations');
    },
  );

  it('publishes the shared replacement before invalidating only the concrete page', async () => {
    const authority = fakeAuthority(SCOPE, { keepOutputs: true, handsBackRecords: true });
    await seed(authority);
    const runtime = runtimeFor(authority.fetchImpl);
    const invalidated = new InvalidatedTags();
    const ownTag = `${IMPLICIT_TAG_PREFIX}${PATH}`;
    const invalidate = vi.spyOn(runtime.host, 'invalidate').mockImplementation(async () => {
      // The host sees the published shell before it is asked to invalidate the concrete page.
      const published = await currentGeneration(runtime, descriptor, T0, () => {
        // The commit has already supplied the fresh record.
      });

      expect(authority.commits).toHaveLength(1);
      expect(new TextDecoder().decode(requireGeneration(published).pack.html)).toBe(
        '<html>new shell</html>',
      );

      return {
        revision: 3,
        invalidations: [{ value: ownTag, staleAt: T0, hardExpireAt: T0, revision: 3 }],
      };
    });

    await revalidate(runtime, invalidated);
    const after = await currentGeneration(runtime, descriptor, T0, () => {
      // This fresh-record lookup does not schedule background work.
    });

    expect(after.kind).toBe('generation');

    const current = requireGeneration(after);

    expect(current.validity).toBe('fresh');
    expect(current.pack.header.pathname).toBe(ROUTE);
    expect(new TextDecoder().decode(current.pack.html)).toBe('<html>new shell</html>');
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      tags: [ownTag],
      api: 'updateTag',
      inForceAt: T0,
    });
    expect({ tags: [...invalidated.tags], revision: invalidated.revision }).toStrictEqual({
      tags: [ownTag],
      revision: 3,
    });
  });

  it("adopts a successful shared replacement, invalidating only the page's own entry", async () => {
    const authority = fakeAuthority(SCOPE, { keepOutputs: true, handsBackRecords: true });
    await seed(authority);
    const runtime = runtimeFor(authority.fetchImpl);
    const invalidated = new InvalidatedTags();

    await revalidate(runtime, invalidated);
    const after = await currentGeneration(runtime, descriptor, T0, () => {
      // This fresh-record lookup does not schedule background work.
    });

    expect(after.kind).toBe('generation');

    const current = requireGeneration(after);

    expect(current.validity).toBe('fresh');
    expect(current.pack.header.pathname).toBe(ROUTE);
    expect(new TextDecoder().decode(current.pack.html)).toBe('<html>new shell</html>');
    expect([...invalidated.tags]).toStrictEqual([`${IMPLICIT_TAG_PREFIX}${PATH}`]);
    expect(invalidated.revision).toBeGreaterThan(current.pack.header.revision);
    expect(authority.invalidations).toStrictEqual([[`${IMPLICIT_TAG_PREFIX}${PATH}`]]);
  });
});
