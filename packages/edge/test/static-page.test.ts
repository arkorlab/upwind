import { RSC_VARY } from '@stayingupwind/core/request';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type PointerReads, serveFromPointer } from '../src/route.ts';
import { BODY, DATE, NOW, PATH, staticPageFixture as fixture } from './static-page-fixture.ts';

describe('trusted complete static Pages HTML', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shares unchanged build bytes through the existing warm record without another lookup', async () => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve();

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('content-length')).toBe(String(BODY.byteLength));
    expect(response.headers.get('vary')).toBe(RSC_VARY);
    expect(response.headers.get('x-arkor-edge')).toContain('static-page;src=memory');
    expect(get).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.fallback).not.toHaveBeenCalled();
  });

  it('uses the dispatcher for a bare GET and leaves HEAD before even reading delivery policy', async () => {
    const test = await fixture();
    const request = new Request<unknown, IncomingRequestCfProperties>(
      'https://site.example/something',
    );
    const pointer = {
      v: 1 as const,
      projectId: 'site',
      originHost: 'site.example',
      mode: 'edge' as const,
      manifestId: test.edge.manifestId,
      policyId: test.edge.policy.id,
      app: test.edge.app,
      updatedAt: DATE,
    };
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx: test.edge.ctx,
        runtime: test.edge.runtime,
        host: test.edge.host,
        pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: test.manifest }),
        policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: test.edge.policy }),
      },
    );

    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    await expect(response.text()).resolves.toContain('hello: world');

    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const policy = Promise.withResolvers<Awaited<PointerReads['policyLookup']>>();
    const headRequest = new Request<unknown, IncomingRequestCfProperties>(request.url, {
      method: 'HEAD',
    });

    test.dispatch.mockResolvedValueOnce(
      new Response(null, { headers: { 'cache-control': 'private, no-store' } }),
    );

    const pending = serveFromPointer(
      {
        request: headRequest,
        url: new URL(headRequest.url),
        env,
        ctx: test.edge.ctx,
        runtime: test.edge.runtime,
        host: test.edge.host,
        pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: test.manifest }),
        policyLookup: policy.promise,
      },
    );
    try {
      const head = await Promise.race([
        pending,
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('policy pending');
          }, 100);
        }),
      ]);

      expect(head).toHaveProperty('status', 200);

      if (typeof head === 'string') throw new TypeError('HEAD waited for delivery policy');

      expect(head.headers.get('cache-control')).toContain('private');
      expect(test.dispatch).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    } finally {
      policy.resolve({ kind: 'found', source: 'exact', policy: test.edge.policy });
      await pending;
    }
  });

  it('keeps legacy build records private even when a new manifest has a mapping', async () => {
    const test = await fixture({ legacy: true });

    expect(test.pack.header.staticPagePrivacy).toBeUndefined();

    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenLastCalledWith('static-page-record-unproved', undefined, {
      recordLookupMs: 0,
    });
  });

  it.each([{ privateDelivery: true }, { validated: true }, { cspNonce: true }])(
    'keeps project and validation privacy before storage: %j',
    async (options) => {
      const test = await fixture(options);
      const get = vi.spyOn(env.CACHE_STATE, 'get');
      const response = await test.serve();

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each(['?visitor=x', '?visitor=', '?visitor', '?dpl=other'])(
    'keeps query-bearing requests private before reading a record: %s',
    async (query) => {
      const test = await fixture();
      const get = vi.spyOn(env.CACHE_STATE, 'get');
      const response = await test.serve({}, `${PATH}${query}`);

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each([
    { cookie: 'session=visitor' },
    { authorization: 'Bearer visitor' },
    { range: 'bytes=0-1' },
    { 'if-none-match': '"known"' },
    { 'x-prerender-revalidate': 'token' },
    { 'x-matched-path': '/something' },
    { 'x-next-revalidated-tags': 'tag' },
    { 'x-next-revalidate-tag-token': 'token' },
    { rsc: '1' },
    { rsc: '1', 'next-router-segment-prefetch': '/_tree' },
    { rsc: '1', 'next-router-segment-prefetch': '0' },
    { rsc: '1', 'next-router-segment-prefetch': '' },
  ])('preserves request-specific handling without a record read: %j', async (headers) => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve({ headers });

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps an admitted middleware response private instead of publishing its visitor decision', async () => {
    const test = await fixture({ middleware: true });
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { 'set-cookie': 'session=visitor' },
    { 'cache-control': 'private' },
    { vary: '*' },
    { 'content-security-policy': "script-src 'nonce-visitor'" },
    { connection: 'cache-control' },
  ])('rejects configured privacy before transport filtering: %j', async (headers) => {
    const test = await fixture({ headerRules: [{ sourceRegex: '^/something$', headers }] });
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(get).not.toHaveBeenCalled();
  });

  it('retains no-transform from build and configured CDN policies through the public response', async () => {
    const test = await fixture({
      initialHeaders: { 'cdn-cache-control': 'no-transform' },
      headerRules: [
        {
          sourceRegex: '^/something$',
          headers: { 'cloudflare-cdn-cache-control': 'no-transform' },
        },
      ],
    });
    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate, no-transform',
    );
    expect(response.headers.has('cdn-cache-control')).toBe(false);
    expect(response.headers.has('cloudflare-cdn-cache-control')).toBe(false);
  });

  it.each([
    { source: 'runtime' as const },
    { seq: 2 },
    { staticPagePrivacy: undefined },
    { kind: 'app-page' as const },
    { scopeId: 'other-scope' },
    { entryId: 'other-entry' },
    { route: '/other' },
    { pathname: '/other' },
    { status: 201 },
  ])('rejects a substituted record identity or authority: %j', async (change) => {
    const test = await fixture();

    test.hold({ ...test.pack, header: { ...test.pack.header, ...change } });

    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a copied marker on a finite-expiry policy', async () => {
    const test = await fixture();

    test.hold({
      ...test.pack,
      header: {
        ...test.pack.header,
        policy: {
          ...test.pack.header.policy,
          expireAfter: { kind: 'finite', seconds: 86_400 },
        },
      },
    });

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects an expired invalidation instead of restoring a public build copy', async () => {
    const test = await fixture();

    test.hold({
      ...test.pack,
      header: {
        ...test.pack.header,
        invalidation: { revision: 2, staleAt: NOW - 1, hardExpireAt: NOW - 1 },
      },
    });

    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenLastCalledWith('static-page-not-fresh', undefined, {
      recordLookupMs: 0,
    });
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('does not reinterpret an ambiguous or replaced HTML artifact as the admitted build body', async () => {
    const test = await fixture();

    test.hold({
      ...test.pack,
      header: {
        ...test.pack.header,
        artifacts: [...test.pack.header.artifacts, ...test.pack.header.artifacts],
      },
    });

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');

    test.hold({
      ...test.pack,
      header: {
        ...test.pack.header,
        artifacts: test.pack.header.artifacts.map((artifact) => {
          return {
            ...artifact,
            sha256: 'b'.repeat(64),
          };
        }),
      },
    });

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
  });
});
