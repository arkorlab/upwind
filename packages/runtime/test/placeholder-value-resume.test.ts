import type { Prerender } from '@stayingupwind/core/bundle';
import { CACHE_ROUTE_HEADER, RESUME_STATE_LENGTH_HEADER } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import {
  appRouteParameters,
  routingParameters,
  spelledParameters,
} from '../src/route-parameters.ts';
import { handleRuntimeResume } from '../src/runtime-resume.ts';
import { resume, type RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

/**
 * A visitor's value spelled as its own placeholder (`/shop/[id]`), on a page with a shell. Next.js
 * reads the spelling as a parameter the platform left unresolved and refuses to resume, so a
 * resume is handed the value escaped, and the rest of the page reaches the visitor.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const HOST = 'https://app.test';
const ROUTE = '/shop/[category]/[id]';
const CATCH_ALL = '/docs/[...slug]';
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));

/** A deployment whose only route is the App Router page `route`, as much of it as is read here. */
function storeOf(route: string, kind = 'app-page'): Store {
  const prerender: Prerender = {
    id: route,
    pathname: route,
    route,
    parentOutputId: route,
    groupId: 1,
  };
  return {
    manifest: {
      buildId: 'build',
      entrypoints: [{ pathname: route, kind }],
      config: { basePath: '', i18n: null },
    },
    prerendersByPathname: new Map([[route, prerender]]),
  } as unknown as Store;
}

function inputFor(request: Request, parameters?: RoutedInput['parameters']): RoutedInput {
  const cache = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: 'dpl_placeholderValueResume',
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.test',
      ARKOR_CACHE_TOKEN: 'test-token',
    },
    now: Date.now,
    fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
  });
  return {
    app: { entries: { [ROUTE]: () => ({ handler }) } },
    edge: { entries: {} },
    request,
    initURL: request.url,
    cache,
    run: (work) => work(),
    waitUntil: () => {
      // Nothing is left behind a resume here.
    },
    ...(parameters !== undefined && { parameters }),
  };
}

/** What the handler was handed for `params` by the only resume this test made. */
function handedParams(): unknown {
  return vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['params'];
}

describe('spelledParameters', () => {
  it.each([
    ['escaped', '/shop/tea/%5Bid%5D'],
    ['as a browser sends it', '/shop/tea/[id]'],
  ])('names every parameter of the route, %s', (_, pathname) => {
    expect(spelledParameters(storeOf(ROUTE), ROUTE, pathname)).toStrictEqual({
      category: 'tea',
      id: '[id]',
    });
  });

  it('keeps a catch-all’s array', () => {
    expect(spelledParameters(storeOf(CATCH_ALL), CATCH_ALL, '/docs/%5B...slug%5D')).toStrictEqual({
      slug: ['[...slug]'],
    });
  });

  it('keeps an optional catch-all’s array', () => {
    const route = '/guide/[[...slug]]';

    expect(spelledParameters(storeOf(route), route, '/guide/%5B%5B...slug%5D%5D')).toStrictEqual({
      slug: ['[[...slug]]'],
    });
  });

  it.each([
    ['another parameter’s spelling', ROUTE, '/shop/tea/%5Bcategory%5D'],
    ['a value that only holds a bracket', ROUTE, '/shop/tea/%5Bid'],
    ['a parameter’s name in a catch-all’s spelling', ROUTE, '/shop/tea/%5B...id%5D'],
    ['a parameter’s spelling beside a catch-all’s others', CATCH_ALL, '/docs/%5B...slug%5D/more'],
  ])('leaves %s to the path', (_, route, pathname) => {
    expect(spelledParameters(storeOf(route), route, pathname)).toBeUndefined();
  });

  it('leaves every other render to the path, as appRouteParameters says nothing of it', () => {
    expect(appRouteParameters(storeOf(ROUTE), ROUTE, '/shop/tea/%5Bid%5D')).toBeUndefined();
  });

  it('leaves a route of the Pages Router to its query', () => {
    const route = '/blog/[post]';

    expect(spelledParameters(storeOf(route, 'pages'), route, '/blog/%5Bpost%5D')).toBeUndefined();
    expect(routingParameters(storeOf(route, 'pages'), route, '/blog/%5Bpost%5D')).toBeUndefined();
  });
});

describe('a resume of a value spelled as its placeholder', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it.each([
    ['a parameter', { category: 'tea', id: '[id]' }, { category: 'tea', id: '%5Bid%5D' }],
    ['a catch-all', { slug: ['[...slug]'] }, { slug: ['%5B...slug%5D'] }],
    ['an optional catch-all', { slug: ['[[...slug]]'] }, { slug: ['%5B%5B...slug%5D%5D'] }],
  ])('hands over %s escaped', async (_, params, expected) => {
    const input = inputFor(new Request(`${HOST}/any`), { params, query: {} });

    await resume({ input, handler, postponed: 'state', url: '/any' });

    expect(handedParams()).toStrictEqual(expected);
  });

  it.each([
    ['another parameter’s spelling', { id: '[category]' }],
    ['a catch-all’s spelling in a parameter', { slug: '[...slug]' }],
    ['a parameter’s spelling in a catch-all', { slug: ['[slug]'] }],
    ['one member of a catch-all among others', { slug: ['[...slug]', 'more'] }],
  ])('leaves %s as it is', async (_, params) => {
    const input = inputFor(new Request(`${HOST}/any`), { params, query: {} });

    await resume({ input, handler, postponed: 'state', url: '/any' });

    expect(handedParams()).toStrictEqual(params);
  });

  it('treats an empty state as any other, which Next.js refuses the same way', async () => {
    const input = inputFor(new Request(`${HOST}/any`), { params: { id: '[id]' }, query: {} });

    await resume({ input, handler, postponed: '', url: '/any' });

    expect(handedParams()).toStrictEqual({ id: '%5Bid%5D' });
  });

  it('hands the query over with them, for it to hold no route parameters', async () => {
    const parameters = { params: { id: '[id]' }, query: { q: 'tea' }, resumeOnly: true } as const;
    const input = inputFor(new Request(`${HOST}/any`), parameters);

    await resume({ input, handler, postponed: 'state', url: '/any?nxtPid=%5Bid%5D&q=tea' });

    expect(vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta).toMatchObject({
      params: { id: '%5Bid%5D' },
      query: { q: 'tea' },
    });
  });

  it('leaves a render with no state to read the url, as a capture must', async () => {
    const parameters = { params: { id: '[id]' }, query: {}, resumeOnly: true } as const;
    const input = inputFor(new Request(`${HOST}/any`), parameters);

    await resume({ input, handler, postponed: undefined, url: '/any?nxtPid=%5Bid%5D' });

    const { requestMeta } = vi.mocked(invokeNodeHandler).mock.calls[0]?.[0] ?? {};

    expect(requestMeta).not.toHaveProperty('params');
    expect(requestMeta).not.toHaveProperty('query');
  });

  it('keeps metadata every render takes on one with no state', async () => {
    const input = inputFor(new Request(`${HOST}/any`), { params: { id: '[id]' }, query: {} });

    await resume({ input, handler, postponed: undefined, url: '/any' });

    expect(handedParams()).toStrictEqual({ id: '[id]' });
  });

  it('is handed the parameters where the edge asked for the resume', async () => {
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('the rest of the page'));
    const state = 'postponed state';
    const request = new Request(`${HOST}/shop/tea/%5Bid%5D`, {
      method: 'POST',
      headers: { [CACHE_ROUTE_HEADER]: ROUTE, [RESUME_STATE_LENGTH_HEADER]: String(state.length) },
      body: state,
    });

    await handleRuntimeResume(inputFor(request), storeOf(ROUTE));

    expect(handedParams()).toStrictEqual({ category: 'tea', id: '%5Bid%5D' });
  });
});
