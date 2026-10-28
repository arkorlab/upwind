import type { Route } from '@stayingupwind/core/bundle';
import { BYPASS_QUERY_PREFIXES } from '@stayingupwind/core/request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { handleRequest } from '../src/handle.ts';
import { dropRouteParameterKeys, resumeUrl, withoutRouteParameterKeys } from '../src/incoming.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { getStore, routerDynamicRoutes, type Store } from '../src/store.ts';

/**
 * A query key a client sends that Next.js reads a route parameter from (`nxtPid`), or an
 * interception marker (`nxtI…`).
 *
 * Those keys are routing's to write. A handler Next.js's own server does not wrap takes its route
 * parameters from them wherever the URL it is handed holds them, over what its path matches
 * (`normalizeQueryParams`, in `RouteModule.prepare`): Next.js leaves it to whatever routes the
 * request to put them there, and fixed GHSA-492v-c6pp-mqqv only for the requests its own server
 * routes. A page of the Pages Router in an application with `i18n` was handed the query as the
 * client sent it, and read its parameter from the client's key rather than from its path; an App
 * Router page was handed the client's key beside routing's, and read both.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// What a page is handed is the test's to read; what it answers does not matter.
vi.mock(import('../src/node-bridge.ts'), () => {
  const render = vi.fn(() => Promise.resolve(new Response('page')));
  return { invokeNodeHandler: render };
});

const HOST = 'https://app.test';
/** `pages/admin/[id].js`, with `getServerSideProps`. */
const PAGE = '/admin/[id]';
/** `app/posts/[slug]/page.js`, beside it. */
const APP_PAGE = '/posts/[slug]';
const I18N = { defaultLocale: 'en', locales: ['en', 'fr'] };
/** What the router matches a document or a payload of either page by, after the parameter. */
const SUFFIX = String.raw`(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`;

/**
 * The two pages' routes as `next build` writes them for an application with both routers: with the
 * forms of their payloads in the same entry, and, with `i18n`, behind a locale.
 */
function dynamicRoutes(localized: boolean): Route[] {
  const locale = localized ? '(?<nextLocale>[^/]{1,})' : '';
  const prefix = localized ? '/$nextLocale' : '';
  const suffix = localized ? '$3' : '$2';
  return [
    {
      source: PAGE,
      sourceRegex: `^[/]?${locale}/admin/(?<nxtPid>[^/]+?)${SUFFIX}`,
      destination: `${prefix}${PAGE}${suffix}?nxtPid=$nxtPid`,
    },
    {
      source: APP_PAGE,
      sourceRegex: `^[/]?${locale}/posts/(?<nxtPslug>[^/]+?)${SUFFIX}`,
      destination: `${prefix}${APP_PAGE}${suffix}?nxtPslug=$nxtPslug`,
    },
  ];
}

/** The deployment, as much of it as routing a request to either page reads. */
function deployment(localized: boolean): Store {
  const manifest = {
    buildId: 'build',
    config: { basePath: '', i18n: localized ? I18N : null },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: dynamicRoutes(localized),
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
    },
    entrypoints: [
      { id: PAGE, kind: 'pages', pathname: PAGE },
      { id: APP_PAGE, kind: 'app-page', pathname: APP_PAGE },
    ],
  };
  return {
    manifest,
    pathnames: [PAGE, APP_PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: routerDynamicRoutes(manifest as unknown as Store['manifest']),
    staticFiles: new Map(),
    shellsByRoute: new Map(),
    prerendersById: new Map(),
    prerendersByPathname: new Map(),
    renderedPages: new Set(),
    readBlob: () => new Uint8Array(),
  } as unknown as Store;
}

const page: NodeHandler = () => Promise.resolve();
const APP: AppModule = {
  entries: { [PAGE]: () => ({ handler: page }), [APP_PAGE]: () => ({ handler: page }) },
};

/** The URL the page `path` routes to is handed, in an application with `i18n` or without. */
async function handedFor(path: string, localized: boolean): Promise<string | undefined> {
  vi.mocked(invokeNodeHandler).mockClear();
  vi.mocked(getStore).mockReturnValue(deployment(localized));
  const response = await handleRequest({
    app: APP,
    edge: { entries: {} },
    request: new Request(`${HOST}${path}`),
    waitUntil: () => {
      // Nothing is scheduled for these renders.
    },
  });
  await response.body?.cancel();
  const urls = vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => call.url);

  expect(urls).toHaveLength(1);

  return urls[0];
}

/**
 * The parameter `name` of the page, as it reads it off the URL it is handed where Next.js's own
 * server does not wrap it (`normalizeQueryParams`, in `RouteModule.prepare`): from the query's keys
 * for it, `nxtP…` and `nxtI…` alike — the last of them over the others, and a key named twice as both
 * of its values — and from the path where the query names none.
 */
function parameterOf(url: string | undefined, name: string): string | readonly string[] {
  const { pathname, searchParams } = new URL(url ?? '/', HOST);
  // In the order the query first names each, as Next.js reads it into an object (`parseReqUrl`).
  const keys = new Set(searchParams.keys());
  let named: string | readonly string[] | undefined;
  for (const key of keys) {
    if (key === `nxtP${name}` || key === `nxtI${name}`) {
      const values = searchParams.getAll(key);
      named = values.length === 1 ? values[0] : values;
    }
  }
  return named ?? decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
}

describe('a query key a client sends that Next.js reads a route parameter from', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    {
      label: 'is not a parameter of a Pages Router page in an application with i18n',
      path: '/admin/123?nxtPid=456',
      localized: true,
      handed: '/admin/123?nxtPid=123',
      name: 'id',
      value: '123',
    },
    {
      label: 'is not one spelled escaped either, which Next.js reads back as the same key',
      path: '/admin/123?%6ExtPid=456',
      localized: true,
      handed: '/admin/123?nxtPid=123',
      name: 'id',
      value: '123',
    },
    {
      label: 'is not handed to an App Router page beside it with routing’s own',
      path: '/posts/hello?nxtPslug=other',
      localized: true,
      handed: '/posts/hello?nxtPslug=hello',
      name: 'slug',
      value: 'hello',
    },
    {
      label: 'is not read after routing’s own where it names an interception marker',
      path: '/admin/123?nxtPid=1&nxtIid=456',
      localized: false,
      handed: '/admin/123?nxtPid=123',
      name: 'id',
      value: '123',
    },
    {
      // `nxtP` itself names no parameter: Next.js reads a key only for what follows the prefix.
      label: 'is taken out alone, every other key left as the client spelled it',
      path: '/admin/123?id=456&nxtPid=456&q=a%20b&nxtP=x',
      localized: true,
      handed: '/admin/123?id=456&q=a%20b&nxtP=x&nxtPid=123',
      name: 'id',
      value: '123',
    },
    {
      // `?nxtPid` is a key of its own after the query's `?`, and stays one once the first goes.
      label: 'leaves a key after it that begins with a `?` that key, though it reads like one',
      path: '/admin/123?nxtPdiscard=x&?nxtPid=456',
      localized: true,
      handed: '/admin/123??nxtPid=456&nxtPid=123',
      name: 'id',
      value: '123',
    },
    {
      label: 'leaves an ordinary key after it that begins with a `?` as it was spelled',
      path: '/admin/123?nxtPdiscard=x&?q=1',
      localized: true,
      handed: '/admin/123??q=1&nxtPid=123',
      name: 'id',
      value: '123',
    },
  ] as const)('$label', async ({ path, localized, handed, name, value }) => {
    const url = await handedFor(path, localized);

    expect(url).toBe(handed);
    expect(parameterOf(url, name)).toBe(value);
  });
});

describe('a query that names no route parameter', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is handed on as routing hands it, in an application without i18n', async () => {
    await expect(handedFor('/admin/123?q=1', false)).resolves.toBe('/admin/123?q=1&nxtPid=123');
    await expect(handedFor('/posts/hello?q=1', false)).resolves.toBe(
      '/posts/hello?q=1&nxtPslug=hello',
    );
  });
});

describe('dropRouteParameterKeys', () => {
  it('takes out the keys Next.js reads as its own, and says it did', () => {
    const url = new URL(`${HOST}/a?nxtPslug=b&q=1&nxtIid=2&%6ExtPid=3&n%78t%50name=4`);

    expect(dropRouteParameterKeys(url)).toBe(true);
    expect(url.href).toBe(`${HOST}/a?q=1`);
  });

  it.each(BYPASS_QUERY_PREFIXES)('finds a key under %s, however it is spelled', (prefix) => {
    const escaped = prefix.replaceAll(
      /./gu,
      (letter) => `%${(letter.codePointAt(0) ?? 0).toString(16)}`,
    );

    for (const spelled of [prefix, escaped, escaped.toUpperCase()]) {
      const url = new URL(`${HOST}/a?q=1&${spelled}id=2`);

      expect(dropRouteParameterKeys(url)).toBe(true);
      expect(url.href).toBe(`${HOST}/a?q=1`);
    }
  });

  it('leaves a query without one as it was spelled', () => {
    // A key that only begins with a `?`, after the query's own, is another key to Next.js too.
    const url = new URL(`${HOST}/a?q=a+b&r=%E2%9C%93&nxtP=1&nxtI&NXTPid=2&?nxtPid=3`);

    expect(dropRouteParameterKeys(url)).toBe(false);
    expect(url.href).toBe(`${HOST}/a?q=a+b&r=%E2%9C%93&nxtP=1&nxtI&NXTPid=2&?nxtPid=3`);
  });

  it('leaves no query behind where it held nothing else', () => {
    const url = new URL(`${HOST}/a?nxtPslug=b`);

    expect(dropRouteParameterKeys(url)).toBe(true);
    expect(url.href).toBe(`${HOST}/a`);
  });

  /**
   * A URL takes one leading `?` off what its query is set to. Set to the pairs that are left alone,
   * it took the one the first of them began with, and a key of its own (`?nxtPid`) became one Next.js
   * reads a parameter from (`nxtPid`).
   */
  it.each([
    ['one that reads like a parameter', '?nxtPslug=b&?nxtPid=2', '??nxtPid=2', ['?nxtPid']],
    ['an ordinary one', '?nxtPslug=b&?q=1', '??q=1', ['?q']],
    ['every one left', '?nxtPslug=b&?x=1&?y=2', '??x=1&?y=2', ['?x', '?y']],
  ])('keeps the `?` a key left after it begins with: %s', (_label, query, left, keys) => {
    const url = new URL(`${HOST}/a${query}`);

    expect(dropRouteParameterKeys(url)).toBe(true);
    expect(url.search).toBe(left);
    expect([...url.searchParams.keys()]).toStrictEqual(keys);
  });

  it('leaves a query whose every pair begins with a `?` as it was', () => {
    const url = new URL(`${HOST}/a??x=1&?nxtPid=2`);

    expect(dropRouteParameterKeys(url)).toBe(false);
    expect(url.href).toBe(`${HOST}/a??x=1&?nxtPid=2`);
  });

  it('is what a resume of a shell renders for', () => {
    expect(resumeUrl(new Request(`${HOST}/a?q=a%20b&nxtPslug=b`))).toBe('/a?q=a%20b');
  });
});

describe('withoutRouteParameterKeys', () => {
  it('hands back what it was handed where the request’s query holds no such key', () => {
    const input = { request: new Request(`${HOST}/a?q=%E2%9C%93&nxtP=1&?nxtPid=2`), other: 1 };

    expect(withoutRouteParameterKeys(input)).toBe(input);
  });

  it('hands back a copy whose request is without them, the same request otherwise', async () => {
    const request = new Request(`${HOST}/a?nxtPslug=b&q=1`, {
      method: 'POST',
      headers: { 'x-asked': '1' },
      body: 'sent',
    });
    const input = { request, other: 1 };

    const copy = withoutRouteParameterKeys(input);

    expect(copy).not.toBe(input);
    expect(copy.other).toBe(1);
    expect(copy.request.url).toBe(`${HOST}/a?q=1`);
    expect(copy.request.method).toBe('POST');
    expect(copy.request.headers.get('x-asked')).toBe('1');
    await expect(copy.request.text()).resolves.toBe('sent');
  });
});
