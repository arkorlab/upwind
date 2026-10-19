import { resolveRoutes } from '@next/routing';
import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  IMPLICIT_TAG_PREFIX,
  MAX_TAG_LENGTH,
  sharedShellTagOf,
} from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { invalidateNow } from '../src/cache/handlers.ts';
import {
  type PublishOutcome,
  type RegenerationOutcome,
  regenerate,
} from '../src/cache/regenerate.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { escapedNameOf } from '../src/name-spellings.ts';
import { elsewhere } from '../src/placement.ts';
import { pathnamesFor } from '../src/routing.ts';
import { getStore, routerPathnames, type Store } from '../src/store.ts';

vi.mock(import('../src/entries.ts'), () => ({ nodeHandlerOf: vi.fn() }));
vi.mock(import('../src/cache/regenerate.ts'), () => ({ regenerate: vi.fn() }));
vi.mock(import('../src/cache/handlers.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, invalidateNow: vi.fn() };
});
vi.mock(import('../src/placement.ts'), () => ({ elsewhere: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    getStore: vi.fn(),
  };
});

const SCOPE = 'revalidate-routing';
const RENDER = {
  html: new Uint8Array(),
  postponed: undefined,
  rscData: undefined,
  segments: new Map<string, Uint8Array>(),
  headers: {},
  status: 200,
  cacheControl: { revalidate: 60, expire: undefined },
  data: undefined,
};

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
    pathnames: routes.map(({ route }) => route),
    slashSpellings: new Map(),
  } as unknown as Store;
}

/** Concrete output, and the two source routes that can answer it, shaped as the adapter emits. */
function seededDeployment(
  closed: boolean,
  trailingSlash: boolean,
  localized: boolean,
  seed = 'seed',
): Store {
  const basePath = localized ? '/base' : '';
  const prefix = localized ? '/base/en' : '';
  const catchAll = `${basePath}/[...rest]`;
  const specific = `${basePath}/[id]`;
  const page: Prerender = {
    id: `${prefix}/${seed}`,
    route: catchAll,
    pathname: `${prefix}/${seed}`,
    parentOutputId: catchAll,
    groupId: 1,
    parentFallbackMode: closed ? false : 'fallback.html',
    allowHeader: ['x-example'],
  };
  const specificShell: Prerender = {
    id: specific,
    route: specific,
    pathname: `${prefix}/[id]`,
    parentOutputId: specific,
    groupId: 2,
  };
  const catchAllShell: Prerender = {
    id: catchAll,
    route: catchAll,
    pathname: `${prefix}/[...rest]`,
    parentOutputId: catchAll,
    groupId: 3,
  };
  const dynamicRoutes = [
    { sourceRegex: `^${prefix}/([^/]+?)(?:/)?$`, destination: specific },
    { sourceRegex: `^${prefix}/(.+?)(?:/)?$`, destination: catchAll },
  ];
  const manifest = {
    buildId: 'build',
    config: {
      basePath,
      trailingSlash,
      i18n: localized ? { defaultLocale: 'en', locales: ['en'] } : null,
    },
    entrypoints: [catchAll, specific].map((route) => {
      return {
        id: route,
        pathname: route,
        kind: 'pages',
      };
    }),
    prerenders: [page, specificShell, ...(closed ? [] : [catchAllShell])],
    staticFiles: [],
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes,
      onMatch: [],
      fallback: [],
    },
  } as unknown as Store['manifest'];
  return {
    manifest,
    ...routerPathnames(manifest),
    staticFiles: new Map(),
    prerendersByPathname: new Map(manifest.prerenders.map((one) => [one.pathname, one])),
    shellsByRoute: new Map([
      [
        catchAll,
        {
          pages: new Map([[page.pathname, page]]),
          patterns: closed ? [] : [{ pattern: /^\/.+$/u, prerender: catchAllShell }],
        },
      ],
      [
        specific,
        {
          pages: new Map(),
          patterns: [{ pattern: /^\/(?:base\/en\/)?[^/]+\/?$/u, prerender: specificShell }],
        },
      ],
    ]),
    dynamicRoutes,
  } as unknown as Store;
}

/** What the installed Next.js router resolves, using this deployment's actual named pathnames. */
async function routedPage(store: Store, pathname: string): Promise<string | undefined> {
  const { config } = store.manifest;
  const result = await resolveRoutes({
    url: new URL(pathname, 'https://app.test'),
    headers: new Headers(),
    requestBody: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    buildId: store.manifest.buildId,
    basePath: config.basePath,
    pathnames: pathnamesFor(store, new URL(pathname, 'https://app.test')),
    routes: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: store.dynamicRoutes.map(({ sourceRegex, destination }) => {
        return {
          sourceRegex,
          ...(destination !== undefined && { destination }),
        };
      }),
      onMatch: [],
      fallback: [],
    },
    ...(config.i18n !== null &&
      config.i18n !== undefined && {
        i18n: { defaultLocale: config.i18n.defaultLocale, locales: config.i18n.locales },
      }),
    invokeMiddleware: () => Promise.resolve({}),
  });
  return result.resolvedPathname;
}

function revalidate(
  store: Store,
  urlPath: string,
  remote = false,
  options: { readonly invalidated?: InvalidatedTags; readonly outcome?: RegenerationOutcome } = {},
): Promise<void> {
  vi.mocked(getStore).mockReturnValue(store);
  vi.mocked(nodeHandlerOf).mockResolvedValue(remote ? undefined : () => Promise.resolve());
  vi.mocked(regenerate).mockResolvedValue(
    options.outcome ?? {
      kind: 'accepted',
      render: RENDER,
      published: Promise.resolve({ kind: 'published', generationId: 'new' }),
    },
  );
  return withRequestContext(
    {
      request: new Request('https://app.test/api/revalidate'),
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime: { scopeId: SCOPE } as CacheRuntime,
      startedAt: 0,
      fetchStarts: new Map(),
      waitUntil: () => {
        // Regeneration is replaced; no background work is started.
      },
      run: (work) => work(),
      invalidated: options.invalidated ?? new InvalidatedTags(),
      writes: new RequestWrites(),
    },
    () => platformRevalidate({ urlPath }),
  );
}

/** The same deployment, of an application that keeps its pages at a trailing slash. */
function withTrailingSlash(store: Store): Store {
  return {
    ...store,
    manifest: { ...store.manifest, config: { ...store.manifest.config, trailingSlash: true } },
  };
}

/** Two independently reusable shells of one page; the final parameter is resumed per visitor. */
function terminalDeployment(
  overrides: Partial<Prerender> = {},
  cacheComponents = true,
  classes: readonly string[] = ['b', 'c'],
): Store {
  const route = '/prefix/[one]/[two]';
  const shells: Prerender[] = classes.map((one) => {
    return {
      id: one,
      route,
      pathname: `/prefix/${one}/[two]`,
      parentOutputId: route,
      groupId: 1,
      routeType: 'shell',
      response: 'initial',
      compute: 'resuming',
      renderingMode: 'PARTIALLY_STATIC',
      body: { sha256: 'html', byteLength: 10, contentType: 'text/html' },
      postponed: { sha256: 'state', byteLength: 5, contentType: 'application/json' },
      ...overrides,
    };
  });
  return {
    manifest: {
      config: { basePath: '', i18n: null, cacheComponents, partialPrefetching: false },
      entrypoints: [{ id: route, pathname: route, kind: 'app-page' }],
    },
    prerendersByPathname: new Map(shells.map((shell) => [shell.pathname, shell])),
    shellsByRoute: new Map([
      [
        route,
        {
          pages: new Map(),
          patterns: shells.map((prerender) => {
            return {
              // eslint-disable-next-line security/detect-non-literal-regexp -- Test-owned literal class values.
              pattern: new RegExp(`^/prefix/${prerender.id}/[^/]+$`, 'u'),
              prerender,
            };
          }),
        },
      ],
    ]),
    pathnames: shells.map((shell) => shell.pathname),
    slashSpellings: new Map(),
  } as unknown as Store;
}

describe('manual revalidation of a shared terminal shell', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(invalidateNow).mockReset();
  });

  it('regenerates the shared entry without expiring the previous generation', async () => {
    const store = terminalDeployment();
    const descriptor = {
      kind: 'app-page' as const,
      route: '/prefix/[one]/[two]',
      pathname: '/prefix/b/[two]',
    };
    await revalidate(store, '/prefix/b/foo');

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual(descriptor);
    expect(invalidateNow).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo`,
    ]);
  });

  it('invalidates only the selected class when its page belongs to another Function', async () => {
    const store = terminalDeployment();
    vi.mocked(elsewhere).mockReturnValue('app-other');
    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: '/prefix/[one]/[two]',
      pathname: '/prefix/b/[two]',
    });

    await revalidate(store, '/prefix/b/foo', true);

    expect(invalidateNow).toHaveBeenCalledWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo`,
      sharedShellTagOf(entryId),
    ]);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('leaves the previous class untouched when its manual render fails', async () => {
    const invalidated = new InvalidatedTags();

    await expect(
      revalidate(terminalDeployment(), '/prefix/b/foo', false, {
        invalidated,
        outcome: { kind: 'failed', render: undefined, error: 'render failed' },
      }),
    ).rejects.toThrow('was not regenerated (failed)');

    expect(invalidateNow).not.toHaveBeenCalled();
    expect(invalidated.tags.size).toBe(0);
  });

  it('preserves another invalidation while publishing the shared shell', async () => {
    const publishing = Promise.withResolvers<PublishOutcome>();
    const invalidated = new InvalidatedTags();
    invalidated.add(['another-change'], 17);
    const manual = revalidate(terminalDeployment(), '/prefix/b/foo', false, {
      invalidated,
      outcome: { kind: 'accepted', render: RENDER, published: publishing.promise },
    });

    try {
      await vi.waitFor(() => {
        expect(regenerate).toHaveBeenCalledTimes(1);
      });

      expect([...invalidated.tags]).toStrictEqual(['another-change']);
      expect(invalidated.revision).toBe(17);
    } finally {
      publishing.resolve({ kind: 'published', generationId: 'new' });
      await manual;
    }

    expect(invalidateNow).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo`,
    ]);
  });

  it.each([
    { stage: 'upload', result: { kind: 'failed', error: 'upload failed' } },
    { stage: 'commit', result: { kind: 'refused', reason: 'commit refused' } },
  ] as const)('leaves the previous class untouched when $stage fails', async ({ result }) => {
    const invalidated = new InvalidatedTags();

    await expect(
      revalidate(terminalDeployment(), '/prefix/b/foo', false, {
        invalidated,
        outcome: { kind: 'accepted', render: RENDER, published: Promise.resolve(result) },
      }),
    ).rejects.toThrow(`was not regenerated (${result.kind})`);

    expect(invalidateNow).not.toHaveBeenCalled();
    expect(invalidated.tags.size).toBe(0);
  });

  it('keeps fresh visitors unmarked while the manual publication is pending', async () => {
    const publishing = Promise.withResolvers<PublishOutcome>();
    const invalidated = new InvalidatedTags();
    const manual = revalidate(terminalDeployment(), '/prefix/b/foo', false, {
      invalidated,
      outcome: { kind: 'accepted', render: RENDER, published: publishing.promise },
    });

    try {
      await vi.waitFor(() => {
        expect(regenerate).toHaveBeenCalledTimes(1);
      });

      expect(invalidateNow).not.toHaveBeenCalled();
      expect(invalidated.tags.size).toBe(0);
    } finally {
      publishing.resolve({ kind: 'published', generationId: 'new' });
      await manual;
    }

    expect(invalidateNow).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo`,
    ]);
  });

  it('invalidates the page at its trailing-slash spelling where the application keeps one', async () => {
    await revalidate(withTrailingSlash(terminalDeployment()), '/prefix/b/foo/');

    expect(invalidateNow).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo`,
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo/`,
    ]);
  });

  it('names both spellings for a page in another Function where the application keeps a slash', async () => {
    vi.mocked(elsewhere).mockReturnValue('app-other');
    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: '/prefix/[one]/[two]',
      pathname: '/prefix/b/[two]',
    });

    await revalidate(withTrailingSlash(terminalDeployment()), '/prefix/b/foo/', true);

    expect(invalidateNow).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo`,
      `${IMPLICIT_TAG_PREFIX}/prefix/b/foo/`,
      sharedShellTagOf(entryId),
    ]);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it.each([
    ['an oversized tag of its own', `/prefix/${'b'.repeat(500)}/foo`, ['b'.repeat(500), 'c']],
    ['the shared shell named itself', '/prefix/b/[two]', ['b', 'c']],
  ] as const)(
    'invalidates nothing more after publishing a shared shell for %s',
    async (_label, urlPath, classes) => {
      await revalidate(terminalDeployment({}, true, classes), urlPath);

      expect(regenerate).toHaveBeenCalledTimes(1);
      expect(invalidateNow).not.toHaveBeenCalled();
    },
  );

  it('invalidates a long shared class through its bounded identity without an oversized pathname tag', async () => {
    const prefix = 'b'.repeat(500);
    const store = terminalDeployment({}, true, [prefix, 'c']);
    vi.mocked(elsewhere).mockReturnValue('app-other');
    const descriptor = {
      kind: 'app-page' as const,
      route: '/prefix/[one]/[two]',
      pathname: `/prefix/${prefix}/[two]`,
    };
    const { entryId } = await deriveEntry(SCOPE, descriptor);

    await revalidate(store, `/prefix/${prefix}/foo`, true);

    expect(invalidateNow).toHaveBeenCalledWith(expect.anything(), [sharedShellTagOf(entryId)]);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it.each([
    { overrides: { postponed: undefined }, cacheComponents: true },
    { overrides: {}, cacheComponents: false },
    { overrides: { partialFallback: true }, cacheComponents: true },
  ])(
    'preserves concrete manual regeneration for an incompatible build: %j',
    async ({ overrides, cacheComponents }) => {
      await revalidate(terminalDeployment(overrides, cacheComponents), '/prefix/b/foo');

      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor.pathname).toBe(
        '/prefix/b/foo',
      );
      expect(invalidateNow).not.toHaveBeenCalled();
    },
  );
});

describe('manual revalidation route precedence', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(
    [false, true].flatMap((closed) => {
      return [false, true].flatMap((trailingSlash) =>
        [false, true].map((localized) => ({ closed, trailingSlash, localized })),
      );
    }),
  )(
    'matches real routing for a seed with closed=$closed, trailingSlash=$trailingSlash, localized=$localized',
    async ({ closed, trailingSlash, localized }) => {
      const store = seededDeployment(closed, trailingSlash, localized);
      const prefix = localized ? '/base/en' : '';
      const sourcePrefix = localized ? '/base' : '';
      const concrete = `${prefix}/seed`;
      const path = `${concrete}${trailingSlash ? '/' : ''}`;
      const selected = await routedPage(store, path);
      const named =
        selected === undefined ? undefined : (store.slashSpellings.get(selected) ?? selected);
      const routed = named === undefined ? undefined : store.prerendersByPathname.get(named)?.route;
      const expected = `${sourcePrefix}/${closed ? '[...rest]' : '[id]'}`;

      expect(routed ?? selected).toBe(expected);

      await revalidate(store, path);

      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
        kind: 'pages',
        route: expected,
        pathname: concrete,
      });
      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.allowHeader).toStrictEqual(
        closed ? ['x-example'] : undefined,
      );
      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.dataPathname).toBe(
        `${sourcePrefix}/_next/data/build/${localized ? 'en/' : ''}seed.json`,
      );
    },
  );

  it.each([false, true])(
    'invalidates the canonical concrete path in another Function, localized=%s',
    async (localized) => {
      const seeded = seededDeployment(true, true, localized);
      const store = {
        ...seeded,
        manifest: {
          ...seeded.manifest,
          entrypoints: seeded.manifest.entrypoints.map((entry) => {
            return {
              ...entry,
              kind: 'app-page' as const,
            };
          }),
        },
      };
      vi.mocked(elsewhere).mockReturnValue('app-other');
      const canonical = `${localized ? '/base/en' : ''}/seed`;

      await revalidate(store, `${canonical}/`, true);

      expect(invalidateNow).toHaveBeenCalledWith(expect.anything(), [
        `${IMPLICIT_TAG_PREFIX}${canonical}`,
        `${IMPLICIT_TAG_PREFIX}${canonical}/`,
      ]);
      expect(regenerate).not.toHaveBeenCalled();
    },
  );

  it('names no slash spelling past the tag bound for a page in another Function', async () => {
    const seed = 's'.repeat(MAX_TAG_LENGTH - IMPLICIT_TAG_PREFIX.length - 1);
    const seeded = seededDeployment(true, true, false, seed);
    const store = {
      ...seeded,
      manifest: {
        ...seeded.manifest,
        entrypoints: seeded.manifest.entrypoints.map((entry) => {
          return {
            ...entry,
            kind: 'app-page' as const,
          };
        }),
      },
    };
    vi.mocked(elsewhere).mockReturnValue('app-other');

    await revalidate(store, `/${seed}/`, true);

    expect(invalidateNow).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
      `${IMPLICIT_TAG_PREFIX}/${seed}`,
    ]);
  });

  it.each([
    { seed: 'seed', asked: '/s%65ed/', canonical: '/seed', closed: true, route: '/[...rest]' },
    {
      seed: 'hello world',
      asked: '/hello%20world/',
      canonical: '/hello world',
      closed: true,
      route: '/[...rest]',
    },
    {
      seed: 'hello world',
      asked: '/hello%20world/',
      canonical: '/hello%20world',
      closed: false,
      route: '/[id]',
    },
    { seed: 'a/b', asked: '/a%2Fb/', canonical: '/a%2Fb', closed: true, route: '/[id]' },
  ])(
    'revalidates the router-selected page for $asked with closed=$closed',
    async ({ seed, asked, canonical, closed, route }) => {
      const store = seededDeployment(closed, true, false, seed);
      const selected = await routedPage(store, asked);
      const name =
        selected === undefined ? undefined : (escapedNameOf(store, selected) ?? selected);
      const named = name === undefined ? undefined : (store.slashSpellings.get(name) ?? name);
      const routed = named === undefined ? undefined : store.prerendersByPathname.get(named)?.route;

      expect(routed ?? selected).toBe(route);

      await revalidate(store, asked);

      const target = vi.mocked(regenerate).mock.calls[0]?.[0].target;

      expect(target?.descriptor).toStrictEqual({ kind: 'pages', route, pathname: canonical });
      expect(target?.dataPathname).toBe(`/_next/data/build${canonical}.json`);
    },
  );

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
