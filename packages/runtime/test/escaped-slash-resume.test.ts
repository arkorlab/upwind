import type { Prerender } from '@stayingupwind/core/bundle';
import { CACHE_ROUTE_HEADER, RESUME_STATE_LENGTH_HEADER } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import {
  appRouteParameters,
  resumeUrlOf,
  routingParameters,
  withParameters,
} from '../src/route-parameters.ts';
import { handleRuntimeResume } from '../src/runtime-resume.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

/**
 * An escaped `/` in a catch-all value of an App Router page, read where the host renders the
 * page by its path as routing reads it for the router's own requests.
 *
 * Every render preserves the slash within its segment: routing supplies metadata arrays, and a
 * resume matches the same values from its pathname. Sending a decoded, joined query instead
 * would split `nested/value` into two params and make the document and router payloads disagree.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const HOST = 'https://app.test';
const ROUTE = '/catchall/[...slug]';
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));

interface Config {
  readonly basePath: string;
  readonly i18n: { readonly locales: readonly string[]; readonly defaultLocale: string } | null;
}

/** An application with no base path and no locales. */
const PLAIN: Config = { basePath: '', i18n: null };

/** A deployment whose only route is the App Router page `route`, as much of it as is read here. */
function storeOf(route: string, config: Config = PLAIN): Store {
  const prerender: Prerender = {
    id: route,
    pathname: route,
    route,
    parentOutputId: route,
    groupId: 1,
  };
  return {
    manifest: { buildId: 'build', entrypoints: [{ pathname: route, kind: 'app-page' }], config },
    prerendersByPathname: new Map([[route, prerender]]),
  } as unknown as Store;
}

describe('routingParameters, for an App Router page', () => {
  it('lets a render match its pathname without a query that splits the segment', () => {
    expect(
      routingParameters(storeOf(ROUTE), ROUTE, '/catchall/@alice/nested%2Fvalue'),
    ).toBeUndefined();
    expect(
      appRouteParameters(storeOf(ROUTE), ROUTE, '/catchall/@alice/nested%2Fvalue'),
    ).toStrictEqual({ slug: ['@alice', 'nested/value'] });
  });

  it('leaves the first segment in place in an application with locales, which put none there', () => {
    const route = '/[lang]/catchall/[...slug]';
    const locales: Config = { basePath: '', i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } };

    expect(appRouteParameters(storeOf(route, locales), route, '/en/catchall/a%2Fb')).toStrictEqual({
      lang: 'en',
      slug: ['a/b'],
    });
  });

  it('names nothing for the class shell itself, whose values are its placeholders', () => {
    expect(routingParameters(storeOf(ROUTE), ROUTE, ROUTE)).toBeUndefined();
  });
});

describe('resumeUrlOf', () => {
  it('keeps the pathname and strips parameters a client tried to name', () => {
    const request = new Request(`${HOST}/catchall/@alice/nested%2Fvalue?q=1&nxtPslug=elsewhere`);

    expect(resumeUrlOf(storeOf(ROUTE), ROUTE, request)).toBe('/catchall/@alice/nested%2Fvalue?q=1');
  });

  it('leaves any other path as the visitor asked for it', () => {
    const request = new Request(`${HOST}/catchall/@alice/plain?nxtPslug=elsewhere`);

    expect(resumeUrlOf(storeOf(ROUTE), ROUTE, request)).toBe('/catchall/@alice/plain');
  });

  it('starts a query where the path had none', () => {
    expect(withParameters('/a', { nxtPslug: 'b/c' })).toBe('/a?nxtPslug=b%2Fc');
    expect(withParameters('/a?q=1', undefined)).toBe('/a?q=1');
  });
});

function inputFor(request: Request): RoutedInput {
  const cache = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: 'dpl_escapedSlashResume',
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
  };
}

describe('a generation’s shell, resumed for the visitor', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('is handed the parameters as routing reads the path', async () => {
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('the rest of the page'));
    const state = 'postponed state';
    const request = new Request(`${HOST}/catchall/@alice/nested%2Fvalue`, {
      method: 'POST',
      headers: { [CACHE_ROUTE_HEADER]: ROUTE, [RESUME_STATE_LENGTH_HEADER]: String(state.length) },
      body: state,
    });

    const response = await handleRuntimeResume(inputFor(request), storeOf(ROUTE));

    expect(response.status).toBe(200);
    expect(vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => call.url)).toStrictEqual([
      '/catchall/@alice/nested%2Fvalue',
    ]);
  });
});
