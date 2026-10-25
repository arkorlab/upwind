import {
  cacheablePrerenders,
  type DeploymentBundle,
  type Prerender,
} from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { type SeededRoute, seedRouteFor } from '../../host/src/bundle/index.ts';
import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * A terminal shell keyed by the parameters it leaves open — `client-params-shallow-routing`'s
 * `/page-params/[id]`, as Next.js 16.4.2 builds it: nothing postponed, and so every route key —
 * seeded as a deployment run seeds its cache, and answered by the Worker from that seed. The build's
 * generation is the one entry every member shares, its lifetime counted from the build, as
 * `next start` counts the shell's, and it is regenerated as the shell once that lifetime is out.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_terminalShellSeedTest0';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const SHELL = '/page-params/[id]';
/** The other shell, keyed by a query besides its parameter: no one entry stands for its members. */
const SEARCH = '/search/[id]';
const SHELL_ENTRY = { kind: 'app-page', route: SHELL, pathname: SHELL };
/** What the seed's record holds of the document, told apart from the bundle's copy of it. */
const SEEDED = '<html><body>the build, as seeded</body></html>';
const BUNDLED = '<html><body>the build, from the bundle</body></html>';
const REGENERATED = '<html><body>the shell, regenerated</body></html>';
const encoder = new TextEncoder();
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = { entries: { [SHELL]: () => ({ handler: page }) } };

function prerender(pathname: string, fields: Partial<Prerender> = {}): Prerender {
  return {
    id: pathname,
    pathname,
    route: pathname,
    parentOutputId: pathname,
    groupId: 1,
    ...fields,
  };
}

/** The shell, kept for a minute and served stale for an hour, as its `cacheLife` would have it. */
function shellOf(route: string, allowQuery: readonly string[]): Prerender {
  return prerender(route, {
    routeType: 'shell',
    response: 'initial',
    compute: 'static',
    renderingMode: 'PARTIALLY_STATIC',
    allowQuery: [...allowQuery],
    body: { sha256: 'shell', byteLength: BUNDLED.length, contentType: 'text/html' },
    initialStatus: 200,
    initialRevalidate: 60,
    initialExpiration: 3600,
    initialHeaders: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** Each class: its shell, the pattern its members match, and the route that hands them on. */
const CLASSES = [
  {
    shell: shellOf(SHELL, ['nxtPid']),
    pattern: /^\/page-params\/[^/]+\/?$/u,
    route: {
      sourceRegex: '^/page-params/(?<nxtPid>[^/]+?)(?:/)?$',
      destination: `${SHELL}?nxtPid=$nxtPid`,
    },
  },
  {
    shell: shellOf(SEARCH, ['nxtPid', 'q']),
    pattern: /^\/search\/[^/]+\/?$/u,
    route: {
      sourceRegex: '^/search/(?<nxtPid>[^/]+?)(?:/)?$',
      destination: `${SEARCH}?nxtPid=$nxtPid`,
    },
  },
];
const SHELLS = CLASSES.map(({ shell }) => shell);
/** The payload Next.js writes beside such a shell: unclassified, and with no body. */
const PAYLOADS = SHELLS.map((shell) => prerender(`${shell.route}.rsc`, { route: shell.route }));
const ROUTES = CLASSES.map(({ route }) => route);
const ROUTING = {
  beforeMiddleware: [],
  middlewareMatchers: [],
  beforeFiles: [],
  afterFiles: [],
  dynamicRoutes: ROUTES,
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
};
const ENTRYPOINTS = SHELLS.map(({ route }) => ({ id: route, kind: 'app-page', pathname: route }));

/** The build, as a deployment run reads it to seed the deployment's cache. */
const BUNDLE = {
  v: 1,
  deploymentId: SCOPE,
  nextVersion: '16.4.2',
  buildId: 'build',
  projectDir: '.',
  // T0, when the build ran.
  generatedAt: '2027-01-15T08:00:00.000Z',
  config: {
    basePath: '',
    trailingSlash: false,
    skipTrailingSlashRedirect: false,
    poweredByHeader: false,
    cacheComponents: true,
  },
  routing: ROUTING,
  entrypoints: ENTRYPOINTS,
  prerenders: [...SHELLS, ...PAYLOADS],
  staticFiles: [],
  functions: {
    app: {
      mainModule: 'index.mjs',
      modules: [],
      compatibilityDate: '2026-09-11',
      compatibilityFlags: [],
    },
  },
} as unknown as DeploymentBundle;

/** What the Worker's store files a class under: its shell, which the class's members match. */
function shellsOf(shell: Prerender, pattern: RegExp) {
  return { pages: new Map<string, Prerender>(), patterns: [{ pattern, prerender: shell }] };
}

/** The same build, as the Worker reads it from its own bundle. */
function deployment(): Store {
  const prerenders = [...SHELLS, ...PAYLOADS];
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', i18n: null, cacheComponents: true },
      routing: ROUTING,
      entrypoints: ENTRYPOINTS,
      prerenders,
    },
    pathnames: SHELLS.map((shell) => shell.route),
    slashSpellings: new Map(),
    dynamicRoutes: ROUTES,
    staticFiles: new Map(),
    shellsByRoute: new Map(
      CLASSES.map(({ shell, pattern }) => [shell.route, shellsOf(shell, pattern)]),
    ),
    prerendersById: new Map(prerenders.map((each) => [each.id, each])),
    prerendersByPathname: new Map(prerenders.map((each) => [each.pathname, each])),
    renderedPages: new Set(),
    readBlob: () => encoder.encode(BUNDLED),
    tryReadBlob: () => encoder.encode(BUNDLED),
  } as unknown as Store;
}

/** Next.js in minimal mode: a static render captured where one is asked for, nothing postponed. */
async function rendering(call: InvokeInput): Promise<Response> {
  type CacheEntryCallback = (entry: unknown, meta: { url: string | undefined }) => unknown;

  const onCacheEntry = call.requestMeta['onCacheEntry'] as CacheEntryCallback | undefined;
  if (onCacheEntry === undefined) {
    return new Response('rendered for the visitor');
  }
  await onCacheEntry(
    {
      value: {
        kind: 'APP_PAGE',
        html: { toUnchunkedString: () => REGENERATED },
        rscData: encoder.encode('0:["the shell"]'),
        headers: { 'content-type': 'text/html' },
        status: 200,
        postponed: undefined,
        segmentData: new Map(),
      },
      cacheControl: { revalidate: 60, expire: 3600 },
    },
    { url: call.url },
  );
  return new Response(null);
}

/** The pathnames each regeneration rendered the page at. */
function regenerated(): (string | undefined)[] {
  return vi
    .mocked(invokeNodeHandler)
    .mock.calls.filter(([call]) => call.requestMeta['onCacheEntry'] !== undefined)
    .map(([call]) => call.url);
}

async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

interface Cache {
  readonly authority: FakeAuthority;
  readonly runtime: CacheRuntime;
  /** What the clock says, for the runtime and for each request it is asked. */
  at: number;
}

function cache(): Cache {
  const authority = fakeAuthority(SCOPE, { keepOutputs: true });
  const clock = { at: T0 };
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => clock.at,
    fetchImpl: authority.fetchImpl,
  });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return Object.assign(clock, { authority, runtime });
}

/** A visitor's document of `path` at `at`, read to its end, the work it left behind settled. */
async function ask(cached: Cache, path: string, at: number): Promise<string> {
  cached.at = at;
  const pending: Promise<unknown>[] = [];
  const response = await handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`${HOST}${path}`),
    waitUntil: (promise) => {
      pending.push(promise);
    },
    cache: cached.runtime,
    clock: at,
  });
  const body = await response.text();
  await settle(pending);
  return body;
}

/** The build's generations, as a deployment run seeds the deployment's cache with them. */
function seeds(): Promise<(SeededRoute | undefined)[]> {
  const context = { scopeId: SCOPE, generatedAt: T0 };
  return Promise.all(
    cacheablePrerenders(BUNDLE).map((each) => seedRouteFor(BUNDLE, each, context)),
  );
}

/** A cache whose authority holds the shell's entry as the deployment seeded it, and nothing else. */
async function seededCache(): Promise<Cache> {
  const seed = (await seeds()).find((each) => each?.input.descriptor.pathname === SHELL)?.input;
  if (seed === undefined) {
    throw new Error("the deployment seeded no entry of the shell's");
  }
  const cached = cache();
  await cached.authority.record(seed.descriptor, seed.generation, encoder.encode(SEEDED), 'build');
  return cached;
}

describe("a terminal shell's entry, as a deployment seeds it", () => {
  beforeEach(() => {
    // The app Function, the only one that answers a document.
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
    vi.mocked(invokeNodeHandler).mockImplementation(rendering);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("seeds the shell's own entry as its regeneration keys it, and none of a shell varying otherwise", async () => {
    const seeded = await seeds();

    // Under the shell's own pathname, without the keys; the shell that also varies on a query of
    // its own is no more seeded than it was.
    expect(seeded.map((seed) => seed?.input.descriptor)).toStrictEqual([SHELL_ENTRY]);
    expect(seeded[0]?.input).not.toHaveProperty('allowQuery');
  });

  it('answers every member from that seed, and regenerates it as the shell once it is stale', async () => {
    const cached = await seededCache();

    // Fresh: every member is answered from the seed, rendered nowhere.
    await expect(ask(cached, '/page-params/1', T0 + SECOND)).resolves.toBe(SEEDED);
    await expect(ask(cached, '/page-params/2', T0 + SECOND)).resolves.toBe(SEEDED);
    expect(invokeNodeHandler).not.toHaveBeenCalled();
    // Past the minute the build gave it: answered as it was, and regenerated behind the answer as
    // the shell, at the shell's own pathname, which defers what it leaves open.
    await expect(ask(cached, '/page-params/3', T0 + 2 * MINUTE)).resolves.toBe(SEEDED);
    expect(regenerated()).toStrictEqual([SHELL]);
    expect(cached.authority.commits).toHaveLength(1);
    // And every member is answered from what that published.
    await expect(ask(cached, '/page-params/4', T0 + 2 * MINUTE + SECOND)).resolves.toBe(
      REGENERATED,
    );
  });
});
