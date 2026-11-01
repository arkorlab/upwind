import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import { resolveRoutes } from '@next/routing';
import { defaultConfig } from 'next/dist/server/config-shared.js';
import { stripInternalQueries } from 'next/dist/server/internal-utils.js';
import { type RequestMeta, setRequestMeta } from 'next/dist/server/request-meta.js';
import type { RouteKind } from 'next/dist/server/route-kind.js';
import { RouteModule } from 'next/dist/server/route-modules/route-module.js';
import { describe, expect, it, vi } from 'vitest';

import { renderQuery } from '../src/render-query.ts';
import { resolvedOf } from '../src/routing.ts';
import { baseRequestMeta, type RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

// These tests run the real Next.js preparation, without invoking the workerd-only HTTP bridge.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const ROUTE = '/[domain]/[...section]';
const ORIGIN = 'https://app.test';
const INTERNAL_QUERY = '&_rsc=flight&nextInternalLocale=internal&nxtP=visible';

/** Supply a build's manifests; Next.js's real prepare method handles params, rewrites and query. */
class PreparedRoute extends RouteModule {}

function routeModule(destination: string): PreparedRoute {
  const route = new PreparedRoute({
    definition: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- Next.js exposes this runtime value as an ambient const enum, unavailable under verbatimModuleSyntax.
      kind: 'APP_PAGE' as RouteKind,
      pathname: ROUTE,
      page: `${ROUTE}/page`,
      bundlePath: `app${ROUTE}/page`,
      filename: 'page.js',
    },
    userland: {},
    distDir: '.next',
    relativeProjectDir: '.',
  });
  Object.defineProperties(route, {
    ensureInstrumentation: {
      value: () => Promise.resolve({ absoluteProjectDir: undefined, instrumentation: undefined }),
    },
    loadManifests: {
      value: () => {
        return {
          routesManifest: {
            basePath: '',
            rewrites: {
              beforeFiles: [{ source: '/alias', destination }],
              afterFiles: [],
              fallback: [],
            },
          },
          previewProps: {
            previewModeId: 'probe',
            previewModeSigningKey: 'probe',
            previewModeEncryptionKey: 'probe',
          },
          serverFilesManifest: { config: defaultConfig },
          prerenderManifest: { routes: {}, dynamicRoutes: {}, notFoundRoutes: [] },
          buildId: 'probe',
        };
      },
    },
  });
  return route;
}

async function routed(path: string, search: string, extra = 'added=extra') {
  const destination = `/domain/${path}?${extra}`;
  const routes = {
    beforeMiddleware: [],
    middlewareMatchers: [],
    beforeFiles: [{ sourceRegex: '^/alias$', destination }],
    afterFiles: [],
    dynamicRoutes: [
      {
        sourceRegex: '^/(?<nxtPdomain>[^/]+?)/(?<nxtPsection>.+?)(?:/)?$',
        destination: `${ROUTE}?nxtPdomain=$nxtPdomain&nxtPsection=$nxtPsection`,
      },
    ],
    onMatch: [],
    fallback: [],
    shouldNormalizeNextData: false,
  };
  const url = new URL(`/alias?ref=one&ref=two${search}${INTERNAL_QUERY}`, ORIGIN);
  const result = await resolveRoutes({
    url,
    buildId: 'probe',
    basePath: '',
    headers: new Headers(),
    requestBody: new ReadableStream(),
    pathnames: [ROUTE],
    routes,
    invokeMiddleware: () => Promise.resolve({}),
  });
  if (result.resolvedPathname === undefined || result.invocationTarget === undefined) {
    throw new Error('the rewrite did not resolve');
  }
  const store = {
    manifest: {
      config: { basePath: '' },
      routing: routes,
      entrypoints: [{ id: ROUTE, kind: 'app-page', pathname: ROUTE }],
    },
    prerendersByPathname: new Map(),
    staticFiles: new Map(),
    slashSpellings: new Map(),
  } as unknown as Store;
  const resolved = resolvedOf(store, result.resolvedPathname, result.invocationTarget, {
    url,
    rewrite: undefined,
  });
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request: new Request(url),
    initURL: url.href,
    parameters: resolved.parameters,
    run: (work) => work(),
    waitUntil: () => {
      /* No work is scheduled. */
    },
  };
  return { input, resolved, next: routeModule(destination) };
}

async function prepare(test: Awaited<ReturnType<typeof routed>>) {
  const request = new IncomingMessage(new Socket());
  request.url = test.resolved.url;
  request.headers = { host: 'app.test' };
  setRequestMeta(request, baseRequestMeta(test.input));
  const result = await test.next.prepare(request, null, { srcPage: `${ROUTE}/page` });
  if (result === undefined) {
    throw new Error('Next.js did not prepare the route');
  }
  const query = { ...result.query };
  // App Router rendering performs this after prepare, independently of the metadata override.
  stripInternalQueries(query);
  request.destroy();
  return { params: result.params, query, url: request.url };
}

function mutateFirstInvocation(input: RoutedInput): void {
  const first = baseRequestMeta(input) as RequestMeta;
  const refs = first.query?.['ref'];
  const segments = first.params?.['section'];
  if (!Array.isArray(refs) || !Array.isArray(segments) || first.query === undefined) {
    throw new Error('the invocation has no array metadata');
  }
  refs.push('changed');
  segments.push('changed');
  delete first.query['added'];
}

function withQuery(input: RoutedInput, query: Record<string, string | string[]>): RoutedInput {
  if (input.parameters === undefined) {
    throw new Error('the invocation has no separated params');
  }
  return { ...input, parameters: { params: input.parameters.params, query } };
}

const QUERY_CASES: readonly { search: string; query: Record<string, string | string[]> }[] = [
  { search: '', query: {} },
  { search: '&domain=&section=', query: { domain: '', section: '' } },
  {
    search: '&constructor=client&toString=client',
    query: { constructor: 'client', toString: 'client' },
  },
  { search: '&constructor=client&added=client', query: { constructor: 'client' } },
  {
    search: '&domain=a&domain=b&section=x&section=y',
    query: { domain: ['a', 'b'], section: ['x', 'y'] },
  },
];

const DESTINATION_QUERY_CASES: readonly {
  extra: string;
  search: string;
  query: Record<string, string | string[]>;
}[] = [
  {
    extra: 'added=extra&domain=business&section=explicit',
    search: '',
    query: { domain: 'business', section: 'explicit' },
  },
  {
    extra: 'added=extra&section=',
    search: '&section=client',
    query: { section: '' },
  },
  {
    extra: 'added=extra&section=first&section=second',
    search: '&section=client',
    query: { section: 'second' },
  },
  {
    extra: 'added=extra&section=explicit',
    search: '&section=client&section=second',
    query: { section: 'explicit' },
  },
];

describe('configured rewrites with an escaped catch-all segment', () => {
  it.each(QUERY_CASES)(
    'keeps the ordinary query $search separate from params in Next.js',
    async ({ search, query }) => {
      const test = await routed('with%2Fslash', search);

      const result = await prepare(test);

      expect(result.params).toStrictEqual({ domain: 'domain', section: ['with/slash'] });
      expect(result.query).toStrictEqual({
        ref: ['one', 'two'],
        added: 'extra',
        nxtP: 'visible',
        ...query,
      });
      expect(result.url).toBe(`/alias?ref=one&ref=two${search}&_rsc=flight&nxtP=visible`);
      expect(test.input.parameters?.query).toHaveProperty('nextInternalLocale', 'internal');
    },
  );

  it.each(DESTINATION_QUERY_CASES)(
    'keeps destination query $extra separate from route parameters',
    async ({ extra, search, query }) => {
      const test = await routed('with%2Fslash', search, extra);

      const result = await prepare(test);

      expect(result.params).toStrictEqual({ domain: 'domain', section: ['with/slash'] });
      expect(result.query).toStrictEqual({
        ref: ['one', 'two'],
        added: 'extra',
        nxtP: 'visible',
        ...query,
      });
      expect(result.url).toBe(`/alias?ref=one&ref=two${search}&_rsc=flight&nxtP=visible`);
    },
  );

  it('preserves literal percent escapes while a neighboring segment contains a slash', async () => {
    const test = await routed('literal%252Fslash/with%2Fslash', '');

    const result = await prepare(test);

    expect(result.params).toStrictEqual({
      domain: 'domain',
      section: ['literal%2Fslash', 'with/slash'],
    });
    expect(result.query).toStrictEqual({ ref: ['one', 'two'], added: 'extra', nxtP: 'visible' });
  });

  it('keeps a rewrite override for a prototype-like key in the resolved metadata', async () => {
    const test = await routed(
      'with%2Fslash',
      '&constructor=client',
      'added=extra&constructor=override',
    );

    expect(test.resolved.parameters?.query).toHaveProperty('constructor', 'override');
    expect(test.resolved.parameters?.query).toHaveProperty('added', 'extra');
    expect(test.resolved.parameters?.params).toStrictEqual({
      domain: 'domain',
      section: ['with/slash'],
    });
  });

  it('gives every invocation independent params and query arrays', async () => {
    const test = await routed('with%2Fslash', '');
    mutateFirstInvocation(test.input);

    const result = await prepare(test);

    expect(result.params).toStrictEqual({ domain: 'domain', section: ['with/slash'] });
    expect(result.query).toStrictEqual({ ref: ['one', 'two'], added: 'extra', nxtP: 'visible' });
  });

  it('copies prototype-like query names as own fields', async () => {
    const test = await routed('with%2Fslash', '');
    const query = Object.fromEntries([
      ['__proto__', 'client'],
      ['constructor', 'client'],
    ]);

    const metadata = baseRequestMeta(withQuery(test.input, query)) as RequestMeta;

    expect(metadata.query).toStrictEqual(query);
    expect(metadata.query).not.toBe(query);
  });

  it('preserves valid array cardinality while discarding non-URL values from the router', () => {
    const query = renderQuery({
      empty: [],
      one: ['only'],
      many: ['first', 'second'],
      inherited: [Object, 'own'],
      inheritedMany: [Object, 'first', 'second'],
      invalid: [Object],
      direct: Object,
    });

    expect(query).toStrictEqual({
      empty: [],
      one: ['only'],
      many: ['first', 'second'],
      inherited: 'own',
      inheritedMany: ['first', 'second'],
    });
  });
});
