import type { Prerender } from '@stayingupwind/core/bundle';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/entries.ts'), () => ({ nodeHandlerOf: vi.fn() }));
vi.mock(import('../src/cache/regenerate.ts'), () => ({ regenerate: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    getStore: vi.fn(),
  };
});

/** One source route, with a concrete seed when the adapter writes one before its template. */
interface Route {
  readonly route: string;
  readonly pattern: RegExp;
  readonly seed?: string;
}

function deployment(routes: readonly Route[]): Store {
  const shells = routes.map(({ route, pattern, seed }) => {
    const prerender: Prerender = {
      id: route,
      route,
      pathname: route,
      parentOutputId: route,
      groupId: 1,
    };
    return [
      route,
      {
        pages: new Map(seed === undefined ? [] : [[seed, { ...prerender, pathname: seed }]]),
        patterns: [{ pattern, prerender }],
      },
    ] as const;
  });
  return {
    manifest: {
      buildId: 'build',
      entrypoints: routes.map(({ route }) => ({ id: route, pathname: route, kind: 'pages' })),
      config: { basePath: '', i18n: null },
    },
    shellsByRoute: new Map(shells),
    prerendersByPathname: new Map(),
  } as unknown as Store;
}

function revalidate(store: Store, urlPath: string): Promise<void> {
  vi.mocked(getStore).mockReturnValue(store);
  vi.mocked(nodeHandlerOf).mockResolvedValue(() => Promise.resolve());
  vi.mocked(regenerate).mockResolvedValue({
    kind: 'accepted',
    render: {
      html: new Uint8Array(),
      postponed: undefined,
      rscData: undefined,
      segments: new Map(),
      headers: {},
      status: 200,
      cacheControl: { revalidate: 60, expire: undefined },
      data: undefined,
    },
    published: Promise.resolve({ kind: 'published', generationId: 'new' }),
  });
  return withRequestContext(
    {
      request: new Request('https://app.test/api/revalidate'),
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime: {} as CacheRuntime,
      startedAt: 0,
      fetchStarts: new Map(),
      waitUntil: () => {
        // Regeneration is replaced; no background work is started.
      },
      run: (work) => work(),
      invalidated: new InvalidatedTags(),
      writes: new RequestWrites(),
    },
    () => platformRevalidate({ urlPath }),
  );
}

describe('manual revalidation route precedence', () => {
  afterEach(() => vi.clearAllMocks());

  it('regenerates an unbuilt specific page ahead of the catch-all whose seed was emitted first', async () => {
    const store = deployment([
      { route: '/[...rest]', pattern: /^\/.+$/u, seed: '/seed' },
      { route: '/blog/[id]', pattern: /^\/blog\/[^/]+$/u },
    ]);

    await revalidate(store, '/blog/new?webhook=1');

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
      kind: 'pages',
      route: '/blog/[id]',
      pathname: '/blog/new',
    });
  });

  it('compares specificity at the first differing segment rather than counting dynamic segments', async () => {
    const store = deployment([
      { route: '/[id]/edit', pattern: /^\/[^/]+\/edit$/u },
      { route: '/blog/[...all]', pattern: /^\/blog\/.+$/u },
    ]);

    await revalidate(store, '/blog/edit');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/blog/[...all]');
  });

  it('prefers a literal page, then a dynamic page, ahead of an optional catch-all', async () => {
    const store = deployment([
      { route: '/docs/[[...rest]]', pattern: /^\/docs(?:\/.*)?$/u },
      { route: '/docs/[id]', pattern: /^\/docs\/[^/]+$/u },
      { route: '/docs/fixed', pattern: /^\/docs\/fixed$/u },
    ]);

    await revalidate(store, '/docs/fixed');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/docs/fixed');

    await revalidate(store, '/docs/new');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/docs/[id]');

    await revalidate(store, '/docs');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/docs/[[...rest]]');
  });

  it('prepares route order once for each immutable store', async () => {
    const store = deployment([{ route: '/blog/[id]', pattern: /^\/blog\/[^/]+$/u }]);
    const keys = vi.spyOn(store.shellsByRoute, 'keys');

    await revalidate(store, '/blog/first');
    await revalidate(store, '/blog/second');

    expect(keys).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('treats an incomplete bracket segment as a literal ahead of a dynamic route', async () => {
    const store = deployment([
      { route: '/[id]', pattern: /^\/[^/]+$/u, seed: '/seed' },
      { route: '/[literal', pattern: /^\/\[literal$/u },
    ]);

    await revalidate(store, '/[literal');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/[literal');
  });
});
