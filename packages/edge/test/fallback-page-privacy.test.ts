import { waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUILT_PATH,
  FALLBACK_ROUTE,
  LAZY_PATH,
  fallbackEdgeFixture,
  type FallbackServeOptions,
} from './fallback-page-fixture.ts';

const DATA = '/_next/data/build/fallback-true/first.json';

describe('pages fallback privacy and protocol fences', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: 'private project', edge: { privateDelivery: true } },
    { name: 'validation', edge: { validated: true } },
    { name: 'nonce project', edge: { cspNonce: true } },
    {
      name: 'raw cookie after classification',
      init: { headers: { cookie: 'session=visitor' } },
      classifiedHeaders: new Headers(),
    },
    {
      name: 'raw authentication after classification',
      init: { headers: { authorization: 'Bearer visitor' } },
      classifiedHeaders: new Headers(),
    },
    { name: 'classified cookie', classifiedHeaders: new Headers({ cookie: 'session=visitor' }) },
    {
      name: 'classified condition',
      classifiedHeaders: new Headers({ 'if-none-match': 'visitor' }),
    },
    { name: 'raw condition', init: { headers: { 'if-modified-since': 'yesterday' } } },
    {
      name: 'router protocol',
      classifiedHeaders: new Headers({ 'next-router-state-tree': 'visitor' }),
    },
    {
      name: 'revalidation control',
      classifiedHeaders: new Headers({ 'x-prerender-revalidate': 'visitor' }),
    },
  ] satisfies (FallbackServeOptions & { name: string })[])(
    'keeps $name private before reading any generation',
    async (options) => {
      const test = await fallbackEdgeFixture();
      const generation = vi.spyOn(test.edge.runtime.memory.generations, 'get');
      const response = await test.serve(options);

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.text()).resolves.toBe('Function');
      expect(generation).not.toHaveBeenCalled();
      expect(test.currentRecord).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([BUILT_PATH, LAZY_PATH, DATA])(
    'does not treat a visitor query as route parameters at %s',
    async (pathname) => {
      const test = await fallbackEdgeFixture();
      const generation = vi.spyOn(test.edge.runtime.memory.generations, 'get');

      const response = await test.serve({ pathname: `${pathname}?slug=other` });

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(generation).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { 'cache-control': 'private' },
    { 'set-cookie': 'session=visitor' },
    { vary: 'Cookie' },
    { 'content-security-policy': "script-src 'nonce-visitor'" },
  ])('keeps raw configured privacy vetoes before filters: %j', async (headers) => {
    const test = await fallbackEdgeFixture({ headerRules: [{ sourceRegex: '^/.*$', headers }] });
    const generation = vi.spyOn(test.edge.runtime.memory.generations, 'get');

    expect((await test.serve({ pathname: DATA })).headers.get('cache-control')).toBe(
      'private, no-store',
    );
    expect(generation).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('keeps conditioned configured headers private even when their field itself looks harmless', async () => {
    const test = await fallbackEdgeFixture({
      headerRules: [
        {
          sourceRegex: '^/.*$',
          has: [{ type: 'header', key: 'x-visitor', value: 'yes' }],
          headers: { 'x-display': 'visitor' },
        },
      ],
    });
    const generation = vi.spyOn(test.edge.runtime.memory.generations, 'get');

    expect(
      (await test.serve({ init: { headers: { 'x-visitor': 'yes' } } })).headers.get(
        'cache-control',
      ),
    ).toBe('private, no-store');
    expect(generation).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('keeps an actual middleware decision private without dispatching the application or reading a generation', async () => {
    const test = await fallbackEdgeFixture({ middleware: true });
    const generation = vi.spyOn(test.edge.runtime.memory.generations, 'get');

    test.dispatch.mockResolvedValueOnce(
      new Response(null, { headers: { 'x-middleware-next': '1' } }),
    );

    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(generation).not.toHaveBeenCalled();
    expect(test.dispatch.mock.calls.map(([script]) => script)).toStrictEqual([
      'fallback-middleware',
    ]);
    expect(test.currentRecord).not.toHaveBeenCalled();

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('leaves a bot to the Function before exposing an initial loading shell', async () => {
    const test = await fallbackEdgeFixture();
    const generation = vi.spyOn(test.edge.runtime.memory.generations, 'get');

    const response = await test.serve({
      pathname: LAZY_PATH,
      init: { headers: { 'user-agent': 'Googlebot' } },
    });

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe('Function');
    expect(generation).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([{ 'content-encoding': 'gzip' }, { 'content-range': 'bytes 0-3/99' }])(
    'keeps an incompatible loading entity private before normalization: %j',
    async (headers) => {
      const test = await fallbackEdgeFixture();
      const loading = test.manifest.pagesFallbacks![FALLBACK_ROUTE]!;
      const manifest = {
        ...test.manifest,
        pagesFallbacks: {
          ...test.manifest.pagesFallbacks,
          [FALLBACK_ROUTE]: { ...loading, headers: { ...loading.headers, ...headers } },
        },
      };

      const response = await test.serve({ pathname: LAZY_PATH, manifest });

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.text()).resolves.toBe('Function');
      expect(test.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { staticPagePrivacy: 2 as const },
    { staticPagePrivacy: undefined },
    { pathname: '/fallback-true/other' },
    { route: '/other/[slug]' },
    { scopeId: 'other-scope' },
    { entryId: 'other-entry' },
    { headers: { 'content-type': 'text/html', 'set-cookie': 'session=visitor' } },
    { artifacts: [] },
  ])(
    'does not inherit paired authority from a mismatched current generation: %j',
    async (change) => {
      const test = await fallbackEdgeFixture();

      test.hold({ ...test.built.pack, header: { ...test.built.pack.header, ...change } });

      const response = await test.serve({ pathname: DATA });

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(test.dispatch).not.toHaveBeenCalled();
      expect(test.currentRecord).not.toHaveBeenCalled();
    },
  );
});
