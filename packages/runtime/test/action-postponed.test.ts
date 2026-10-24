import type { Prerender } from '@stayingupwind/core/bundle';
import { policyFromCacheControl } from '@stayingupwind/core/cache';
import { NEXT_ACTION_HEADER } from '@stayingupwind/core/request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';
import { fakeAuthority } from './authority.ts';

/**
 * A server action posted to an App Router page that has a postponed state.
 *
 * Next.js re-renders the page once the action ran, and in minimal mode it takes what that render
 * reads from the page's own caches — a `use cache` result, a cached `fetch` — from the postponed
 * state the host hands it (`requestMeta.postponed`). Handed none, the re-render computed them
 * afresh, and a value the page had cached changed under an action that never touched it
 * (`app-dir/resume-data-cache`, "should use RDC for server action re-renders").
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// What the page's render is handed is the question here, not what it answers.
vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('re-rendered')));
  return { invokeNodeHandler: render };
});

const SCOPE = 'dpl_actionPostponedTest';
const T0 = 1_800_000_000_000;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const PAGE = '/server-action';
const encoder = new TextEncoder();
const BUILD_STATE = 'the postponed state the build wrote';
const blobs = new Map([
  ['postponed', encoder.encode(BUILD_STATE)],
  ['shell', encoder.encode('<html>shell</html>')],
]);
const shell: Prerender = {
  id: PAGE,
  route: PAGE,
  pathname: PAGE,
  parentOutputId: PAGE,
  groupId: 1,
  renderingMode: 'PARTIALLY_STATIC',
  body: { sha256: 'shell', byteLength: 18, contentType: 'text/html' },
  postponed: { sha256: 'postponed', byteLength: BUILD_STATE.length, contentType: 'text/plain' },
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
      entrypoints: [{ id: PAGE, kind: 'app-page', pathname: PAGE }],
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map([[PAGE, { pages: new Map([[PAGE, shell]]), patterns: [] }]]),
    prerendersById: new Map([[PAGE, shell]]),
    prerendersByPathname: new Map([[PAGE, shell]]),
    // An App Router page: none of the Pages Router's, which answer reads only.
    renderedPages: new Set(),
    readBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

const CLASS_ROUTE = '/posts/[slug]';
const MEMBER = '/posts/bar';
const CLASS_STATE = 'the postponed state the class shell was last regenerated with';
const MEMBER_STATE = "the postponed state the member's own entry was last regenerated with";
const postsShell: Prerender = {
  id: CLASS_ROUTE,
  route: CLASS_ROUTE,
  pathname: CLASS_ROUTE,
  parentOutputId: CLASS_ROUTE,
  groupId: 2,
  renderingMode: 'PARTIALLY_STATIC',
  body: { sha256: 'shell', byteLength: 18, contentType: 'text/html' },
  postponed: { sha256: 'postponed', byteLength: BUILD_STATE.length, contentType: 'text/plain' },
};

/** The same, with a route whose members the build left to one class shell. */
const POSTS_ROUTE = {
  sourceRegex: '^/posts/(?<nxtPslug>[^/]+?)(?:/)?$',
  destination: '/posts/[slug]?nxtPslug=$nxtPslug',
};

function deploymentWithMembers(): Store {
  const base = deployment();
  const { manifest } = base;
  return {
    ...base,
    dynamicRoutes: [POSTS_ROUTE],
    manifest: {
      ...manifest,
      routing: { ...manifest.routing, dynamicRoutes: [POSTS_ROUTE] },
      entrypoints: [
        ...manifest.entrypoints,
        { id: CLASS_ROUTE, kind: 'app-page', pathname: CLASS_ROUTE },
      ],
    },
    pathnames: [...base.pathnames, CLASS_ROUTE],
    shellsByRoute: new Map([
      ...base.shellsByRoute,
      [
        CLASS_ROUTE,
        { pages: new Map(), patterns: [{ pattern: /^\/posts\/[^/]+$/u, prerender: postsShell }] },
      ],
    ]),
    prerendersById: new Map([...base.prerendersById, [CLASS_ROUTE, postsShell]]),
    prerendersByPathname: new Map([...base.prerendersByPathname, [CLASS_ROUTE, postsShell]]),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();
const app: AppModule = {
  entries: { [PAGE]: () => ({ handler: page }), [CLASS_ROUTE]: () => ({ handler: page }) },
};

/** A generation of `pathname` under `route`, recorded with `postponed`: none, one rendered whole. */
async function recorded(
  authority: ReturnType<typeof fakeAuthority>,
  route: string,
  pathname: string,
  postponed: string | undefined,
): Promise<void> {
  await authority.record(
    { kind: 'app-page', route, pathname },
    {
      cacheTimestamp: T0,
      policy: policyFromCacheControl({ revalidate: 900, expire: 31_536_000 }),
      status: 200,
      headers: {},
      tags: [],
      postponed: postponed === undefined ? undefined : encoder.encode(postponed),
    },
    encoder.encode('<html>regenerated</html>'),
    'runtime',
  );
}

function post(headers: Record<string, string>): Request {
  return new Request(`https://app.test${PAGE}`, { method: 'POST', headers, body: '[]' });
}

/** A server action posted to `pathname`, answered with `cache` as the runtime cache. */
function act(pathname: string, cache: ReturnType<typeof createCacheRuntime>): Promise<Response> {
  return handleRequest({
    app,
    edge: { entries: {} },
    request: new Request(`https://app.test${pathname}`, {
      method: 'POST',
      headers: { [NEXT_ACTION_HEADER]: 'action-id' },
      body: '[]',
    }),
    waitUntil: () => {
      // Nothing is scheduled for an action this page answers.
    },
    cache,
    clock: T0 + 1000,
  });
}

/** A render of the page handed `postponed` to resume what it cached from. */
function handed(postponed: string): unknown {
  const requestMeta: unknown = expect.objectContaining({ postponed });
  return expect.objectContaining({ requestMeta });
}

/** A render of the page handed no postponed state at all. */
function handedNone(): unknown {
  const postponed: unknown = expect.anything();
  const requestMeta: unknown = expect.not.objectContaining({ postponed });
  return expect.objectContaining({ requestMeta });
}

describe('the postponed state a post to an App Router page is rendered with', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is the build's for a server action to a page the cache holds no generation of", async () => {
    const response = await handleRequest({
      app,
      edge: { entries: {} },
      request: post({ [NEXT_ACTION_HEADER]: 'action-id' }),
      waitUntil: () => {
        // Nothing is scheduled for an action this page answers.
      },
    });

    await expect(response.text()).resolves.toBe('re-rendered');
    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledExactlyOnceWith(handed(BUILD_STATE));
  });

  it("is the current generation's for a server action, over the build's", async () => {
    const authority = fakeAuthority(SCOPE);
    const regenerated = 'the postponed state the last regeneration wrote';
    await authority.record(
      { kind: 'app-page', route: PAGE, pathname: PAGE },
      {
        cacheTimestamp: T0,
        policy: policyFromCacheControl({ revalidate: 900, expire: 31_536_000 }),
        status: 200,
        headers: {},
        tags: [],
        postponed: encoder.encode(regenerated),
      },
      encoder.encode('<html>regenerated</html>'),
      'runtime',
    );
    const cache = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl: authority.fetchImpl });

    await handleRequest({
      app,
      edge: { entries: {} },
      request: post({ [NEXT_ACTION_HEADER]: 'action-id' }),
      waitUntil: () => {
        // Nothing is scheduled for an action this page answers.
      },
      cache,
      clock: T0 + 1000,
    });

    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledExactlyOnceWith(handed(regenerated));
  });

  /**
   * A member the edge had an entry of its own made for (`concreteUpgrade`) was answered from that
   * entry, not from its class shell's, and its action is re-rendered with what that entry cached.
   * One with no entry of its own was answered from the class shell's, and is re-rendered with its.
   */
  it("is a member's own generation's, over its class shell's", async () => {
    vi.mocked(getStore).mockReturnValue(deploymentWithMembers());
    const authority = fakeAuthority(SCOPE);
    await recorded(authority, CLASS_ROUTE, CLASS_ROUTE, CLASS_STATE);
    const cache = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl: authority.fetchImpl });

    await act('/posts/other', cache);
    await recorded(authority, CLASS_ROUTE, MEMBER, MEMBER_STATE);
    await act(MEMBER, cache);

    expect(vi.mocked(invokeNodeHandler).mock.calls).toStrictEqual([
      [handed(CLASS_STATE)],
      [handed(MEMBER_STATE)],
    ]);
  });

  /**
   * A generation that rendered whole holds no postponed state, and the page was answered from it
   * all the same: the build's state, or the class shell's, would hand the re-render what that
   * generation replaced.
   */
  it('is none where the generation the page was answered from rendered whole', async () => {
    vi.mocked(getStore).mockReturnValue(deploymentWithMembers());
    const authority = fakeAuthority(SCOPE);
    await recorded(authority, PAGE, PAGE, undefined);
    await recorded(authority, CLASS_ROUTE, CLASS_ROUTE, CLASS_STATE);
    await recorded(authority, CLASS_ROUTE, MEMBER, undefined);
    const cache = createCacheRuntime({ env: ENV, now: () => T0, fetchImpl: authority.fetchImpl });

    await act(PAGE, cache);
    await act(MEMBER, cache);

    expect(vi.mocked(invokeNodeHandler).mock.calls).toStrictEqual([[handedNone()], [handedNone()]]);
  });

  /** A draft's page was rendered as it is now, and so is the re-render after its action. */
  it('is none for a server action posted in draft mode', async () => {
    const store = deployment();
    vi.mocked(getStore).mockReturnValue({
      ...store,
      manifest: { ...store.manifest, bypassToken: 'the draft token' },
    });

    await handleRequest({
      app,
      edge: { entries: {} },
      request: post({
        [NEXT_ACTION_HEADER]: 'action-id',
        cookie: '__prerender_bypass=the draft token',
      }),
      waitUntil: () => {
        // Nothing is scheduled for an action this page answers.
      },
    });

    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledExactlyOnceWith(handedNone());
  });

  it('is none for a post that runs no action', async () => {
    await handleRequest({
      app,
      edge: { entries: {} },
      request: post({ 'content-type': 'text/plain' }),
      waitUntil: () => {
        // Nothing is scheduled for a post this page answers.
      },
    });

    expect(vi.mocked(invokeNodeHandler)).toHaveBeenCalledExactlyOnceWith(handedNone());
  });
});
