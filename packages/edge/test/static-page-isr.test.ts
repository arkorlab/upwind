import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  policyFromCacheControl,
} from '@stayingupwind/core/cache';
import { CACHE_ENTRY_HEADER, REGENERATE_HEADER } from '@stayingupwind/core/paas';
import { RSC_VARY } from '@stayingupwind/core/request';
import { waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BODY, NOW, PATH, staticPageFixture } from './static-page-fixture.ts';

const STALE_AT = NOW + 3000;
const isr = () => staticPageFixture({ privacy: 2, initialRevalidate: 2 });

async function replacement(test: Awaited<ReturnType<typeof isr>>, marked = true) {
  const html = new TextEncoder().encode('<p>new generation</p>');
  const sha256 = await sha256Hex(html);
  const bytes = encodeGenerationPack(
    {
      ...test.pack.header,
      staticPagePrivacy: marked ? 2 : undefined,
      source: 'runtime',
      seq: 2,
      revision: 2,
      generationId: 'generation-runtime',
      cacheTimestamp: STALE_AT,
      producedAt: STALE_AT,
      policy: policyFromCacheControl({ revalidate: 2, expire: 60 }),
      htmlSha256: sha256,
      htmlLength: html.byteLength,
      artifacts: test.pack.header.artifacts.map((artifact) =>
        artifact.role === 'html' ? { ...artifact, sha256, byteLength: html.byteLength } : artifact,
      ),
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('replacement must decode');
  return { bytes, pack: decoded.pack };
}

describe('trusted current Pages ISR HTML', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves a fresh marked generation without another lookup or dispatch', async () => {
    const test = await isr();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve();

    expect(test.entry.staticPagePrivacy).toBe(2);
    expect(test.pack.header.staticPagePrivacy).toBe(2);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('vary')).toBe(RSC_VARY);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(get).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.fallback).not.toHaveBeenCalled();
  });

  it('keeps version one authority for a no-revalidate page in a version two bundle', async () => {
    const test = await staticPageFixture({ privacy: 2 });

    expect(test.entry.staticPagePrivacy).toBeUndefined();
    expect(test.pack.header.staticPagePrivacy).toBe(1);
    expect((await test.serve()).headers.get('cache-control')).toContain('public');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('answers an already time-stale generation while its one background render is pending', async () => {
    const test = await isr();

    test.setNow(STALE_AT);

    const render = Promise.withResolvers<Response>();

    test.dispatch.mockReturnValueOnce(render.promise);

    try {
      const response = await Promise.race([
        test.serve(),
        new Promise<undefined>((resolve) => {
          setTimeout(resolve, 100);
        }),
      ]);

      expect(response).toBeInstanceOf(Response);

      if (response === undefined) throw new Error('time-stale HTML waited for regeneration');

      expect(response.headers.get('cache-control')).toContain('public');
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect((await test.serve()).headers.get('cache-control')).toContain('public');
      expect(test.dispatch).toHaveBeenCalledTimes(1);

      const request = test.dispatch.mock.calls[0]?.[1];

      expect(request?.headers.get(REGENERATE_HEADER)).toBe('detached');
      expect(request?.headers.get(CACHE_ENTRY_HEADER)).toBe(test.entry.entryId);
    } finally {
      render.resolve(new Response(null));
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it.each([true, false])(
    'adopts the newer record without inheriting a prior marker: marked=%s',
    async (marked) => {
      const test = await isr();
      const next = await replacement(test, marked);
      await env.CACHE_STATE.put(test.key, next.bytes);
      await env.CACHE_STATE.put('unrelated-static-page', 'unrelated value');

      test.setNow(STALE_AT);

      test.dispatch.mockResolvedValue(new Response(null));

      expect(new Uint8Array(await (await test.serve()).arrayBuffer())).toStrictEqual(BODY);

      await waitOnExecutionContext(test.edge.ctx);
      const response = await test.serve();

      expect(response.headers.get('cache-control')).toBe(
        marked ? 'public, max-age=0, must-revalidate' : 'private, no-store',
      );
      await expect(response.text()).resolves.toBe(marked ? '<p>new generation</p>' : 'Function');
      await expect(env.CACHE_STATE.get('unrelated-static-page')).resolves.toBe('unrelated value');
    },
  );

  it('retains the prior safe generation when background rendering fails', async () => {
    const test = await isr();

    test.setNow(STALE_AT);

    test.dispatch.mockRejectedValueOnce(new Error('fixture regeneration failed'));

    expect(new Uint8Array(await (await test.serve()).arrayBuffer())).toStrictEqual(BODY);

    await waitOnExecutionContext(test.edge.ctx);

    expect(new Uint8Array(await (await test.serve()).arrayBuffer())).toStrictEqual(BODY);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['hard expiry', 'hard invalidation'])(
    'keeps %s private and asks the existing foreground regeneration path',
    async (reason) => {
      const test = await isr();

      test.setNow(NOW + 6000);

      test.hold({
        ...test.pack,
        header: {
          ...test.pack.header,
          ...(reason === 'hard expiry'
            ? {
                policy: { ...test.pack.header.policy, expireAfter: { kind: 'finite', seconds: 5 } },
              }
            : { invalidation: { revision: 2, staleAt: NOW - 1, hardExpireAt: NOW - 1 } }),
        },
      });

      test.dispatch.mockResolvedValue(
        new Response('foreground render', { headers: { 'content-type': 'text/html' } }),
      );

      const response = await test.serve();

      expect(response.headers.get('cache-control')).toContain('private');
      await expect(response.text()).resolves.toBe('foreground render');
      expect(test.dispatch).toHaveBeenCalledTimes(1);
      expect(test.dispatch.mock.calls[0]?.[1]?.headers.get(REGENERATE_HEADER)).toBe('foreground');
      expect(test.fallback).not.toHaveBeenCalled();

      await waitOnExecutionContext(test.edge.ctx);
    },
  );

  it('keeps a soft-invalidated record private before scheduling a background render', async () => {
    const test = await isr();

    test.hold({
      ...test.pack,
      header: {
        ...test.pack.header,
        invalidation: { revision: 2, staleAt: NOW - 1, hardExpireAt: NOW + 10_000 },
      },
    });

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { staticPagePrivacy: 1 as const },
    { staticPagePrivacy: undefined },
    { source: 'runtime' as const, seq: 1 },
    { seq: 2 },
    { scopeId: 'another-scope' },
    { entryId: 'another-entry' },
    { pathname: '/another' },
    { producedAt: null },
  ])('rejects an incompatible current authority: %j', async (change) => {
    const test = await isr();

    test.hold({ ...test.pack, header: { ...test.pack.header, ...change } });

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('keeps unknown freshness private even when the held record carries a marker', async () => {
    const test = await isr();

    test.hold({ ...test.pack, header: { ...test.pack.header, cacheTimestamp: null } });

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenCalledWith('static-page-not-fresh', undefined, {
      recordLookupMs: 0,
    });
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([{ kind: 'unknown' as const }, { kind: 'finite' as const, seconds: 0 }])(
    'keeps an unproved ISR lifetime private: %j',
    async (revalidateAfter) => {
      const test = await isr();

      test.hold({
        ...test.pack,
        header: { ...test.pack.header, policy: { ...test.pack.header.policy, revalidateAfter } },
      });

      expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
      expect(test.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { method: 'HEAD' },
    { headers: { cookie: 'session=visitor' } },
    { headers: { authorization: 'Bearer visitor' } },
    { headers: { rsc: '1', 'next-router-segment-prefetch': '' } },
  ])('keeps request privacy before lookup for version two: %j', async (request) => {
    const test = await isr();
    const get = vi.spyOn(env.CACHE_STATE, 'get');

    expect((await test.serve(request)).headers.get('cache-control')).toBe('private, no-store');
    expect(get).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('never uses a missing record as permission to restore public build HTML', async () => {
    const test = await isr();
    const memory = test.edge.runtime.memory;
    memory.generations.delete(test.key);
    await env.CACHE_STATE.delete(test.key);

    expect((await test.serve()).headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenCalledWith('static-page-not-fresh', undefined, {
      recordLookupMs: 0,
    });

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('keeps query variants private before reading an ISR generation', async () => {
    const test = await isr();
    const get = vi.spyOn(env.CACHE_STATE, 'get');

    expect((await test.serve({}, `${PATH}?visitor=x`)).headers.get('cache-control')).toBe(
      'private, no-store',
    );
    expect(get).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });
});
