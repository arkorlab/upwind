// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- CI checks wire bytes with independent native decoders; production serving stays runtime-neutral.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { r2ArtifactKey, sha256Hex } from '@stayingupwind/core/artifact';
import { encodeGenerationPack } from '@stayingupwind/core/cache';
import {
  CACHE_ENTRY_HEADER,
  CACHE_ROUTE_HEADER,
  GENERATION_HEADER,
  REGENERATE_HEADER,
} from '@stayingupwind/core/paas';
import { crc32, withDeadline } from '@stayingupwind/core/util';
import { brotliStoredHead, gzipStoredHead } from '@stayingupwind/host/splice';
import { waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUILT_PATH,
  FALLBACK_NOW,
  FALLBACK_ROUTE,
  FALLBACK_SCOPE,
  LAZY_PATH,
  fallbackEdgeFixture,
} from './fallback-page-fixture.ts';

const BUILT_DATA = '/_next/data/build/fallback-true/first.json';
const LAZY_DATA = '/_next/data/build/fallback-true/second.json';
const PUBLIC = 'public, max-age=0, must-revalidate';

/** Stored unfinished renderings, read through the actual R2 loader and finalized by delivery. */
async function preparedLoading(test: Awaited<ReturnType<typeof fallbackEdgeFixture>>) {
  const loading = test.manifest.pagesFallbacks![FALLBACK_ROUTE]!;
  const brHead = brotliStoredHead(test.native.loading);
  const gzipHead = gzipStoredHead(test.native.loading);
  const br = {
    ...loading.shell.artifact,
    sha256: await sha256Hex(brHead),
    byteLength: brHead.byteLength,
    encoding: 'br' as const,
  };
  const gzip = {
    ...loading.shell.artifact,
    sha256: await sha256Hex(gzipHead),
    byteLength: gzipHead.byteLength,
    encoding: 'gzip' as const,
    crc32: crc32(test.native.loading),
  };
  await env.ARTIFACTS.put(r2ArtifactKey(br.sha256), brHead);
  await env.ARTIFACTS.put(r2ArtifactKey(gzip.sha256), gzipHead);
  return {
    br,
    gzip,
    manifest: {
      ...test.manifest,
      pagesFallbacks: {
        ...test.manifest.pagesFallbacks,
        [FALLBACK_ROUTE]: { ...loading, shell: { ...loading.shell, encodings: { br, gzip } } },
      },
    },
  };
}

describe('paired Pages fallback delivery at the Edge boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('publishes the native member and loading table, then serves built HTML and matching JSON without a Function or current RPC', async () => {
    const test = await fallbackEdgeFixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const html = await test.serve();
    const data = await test.serve({
      pathname: BUILT_DATA,
      init: { headers: { 'x-nextjs-data': '1' } },
    });

    expect(test.manifest.staticPages?.[BUILT_PATH]).toMatchObject({
      staticPagePrivacy: 3,
      route: FALLBACK_ROUTE,
      parameters: { slug: 'first' },
      dataPathname: BUILT_DATA,
    });
    expect(test.manifest.pagesFallbacks?.[FALLBACK_ROUTE]).not.toHaveProperty('entryId');
    expect({
      html: html.headers.get('cache-control'),
      data: data.headers.get('cache-control'),
      type: data.headers.get('content-type'),
    }).toStrictEqual({ html: PUBLIC, data: PUBLIC, type: 'application/json' });
    expect(new Uint8Array(await html.arrayBuffer())).toStrictEqual(test.native.html);
    expect(new Uint8Array(await data.arrayBuffer())).toStrictEqual(test.native.data);
    expect({
      get: get.mock.calls,
      current: test.currentRecord.mock.calls,
      dispatch: test.dispatch.mock.calls,
      fallback: test.fallback.mock.calls,
    }).toStrictEqual({ get: [], current: [], dispatch: [], fallback: [] });
  });

  it('returns loading HTML while the detached concrete render is pending, then adopts it without any JSON request', async () => {
    const test = await fallbackEdgeFixture();
    const render = Promise.withResolvers<Response>();

    test.dispatch.mockReturnValueOnce(render.promise);

    try {
      const response = await withDeadline(
        test.serve({ pathname: LAZY_PATH }),
        1000,
        'loading shell waited for its concrete render',
      );

      expect({
        policy: response.headers.get('cache-control'),
        dispatches: test.dispatch.mock.calls.length,
        passthrough: test.fallback.mock.calls,
      }).toStrictEqual({ policy: PUBLIC, dispatches: 1, passthrough: [] });
      await expect(response.text()).resolves.toContain('hi fallback');

      const request = test.dispatch.mock.calls[0]?.[1];

      const member = await test.runtimeMember();

      expect({
        pathname: new URL(request!.url).pathname,
        route: request?.headers.get(CACHE_ROUTE_HEADER),
        mode: request?.headers.get(REGENERATE_HEADER),
        generation: request?.headers.get(GENERATION_HEADER),
        entry: request?.headers.get(CACHE_ENTRY_HEADER),
      }).toStrictEqual({
        pathname: LAZY_PATH,
        route: FALLBACK_ROUTE,
        mode: 'detached',
        generation: null,
        entry: member.entryId,
      });

      render.resolve(new Response(null));
      await waitOnExecutionContext(test.edge.ctx);

      expect({
        generation: test.edge.runtime.memory.generations.get(member.key),
        absent: test.edge.runtime.memory.absentRecords.peek(member.key) !== undefined,
      }).toStrictEqual({ generation: undefined, absent: true });

      test.currentRecord.mockResolvedValueOnce(member.bytes.buffer as ArrayBuffer);

      test.setNow(FALLBACK_NOW + 1000);

      const pending = await test.serve({ pathname: LAZY_PATH });

      await expect(pending.text()).resolves.toContain('hi fallback');

      await waitOnExecutionContext(test.edge.ctx);

      const warm = await test.serve({ pathname: LAZY_PATH });

      expect(warm.headers.get('cache-control')).toBe(PUBLIC);
      expect(new Uint8Array(await warm.arrayBuffer())).toStrictEqual(member.html);
      expect({
        dispatch: test.dispatch.mock.calls.length,
        current: test.currentRecord.mock.calls,
      }).toStrictEqual({
        dispatch: 1,
        current: [
          [FALLBACK_SCOPE, member.entryId, 0],
          [FALLBACK_SCOPE, member.entryId, 0],
        ],
      });
    } finally {
      render.resolve(new Response(null));
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('normalizes stored entity metadata for the exact identity loading bytes', async () => {
    const test = await fallbackEdgeFixture();
    const loading = test.manifest.pagesFallbacks![FALLBACK_ROUTE]!;
    const manifest = {
      ...test.manifest,
      pagesFallbacks: {
        ...test.manifest.pagesFallbacks,
        [FALLBACK_ROUTE]: {
          ...loading,
          headers: {
            ...loading.headers,
            'content-encoding': 'identity',
            'content-length': '99999',
            'accept-ranges': 'bytes',
            etag: '"stale-loading-entity"',
          },
        },
      },
    };

    const response = await test.serve({ pathname: LAZY_PATH, manifest });

    expect(test.fallback).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(response.headers.get('content-type')).toBe(test.native.fallback.body!.contentType);
    expect(response.headers.get('content-length')).toBe(String(test.native.loading.byteLength));

    for (const name of ['content-encoding', 'content-range', 'accept-ranges', 'etag'])
      expect(response.headers.has(name)).toBe(false);

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(test.native.loading);

    await waitOnExecutionContext(test.edge.ctx);
  });

  it.each([
    { accept: 'br, gzip', original: 'br, gzip', encoding: 'br', decode: brotliDecompressSync },
    { accept: 'gzip', original: 'gzip', encoding: 'gzip', decode: gunzipSync },
    { accept: 'br, gzip', original: 'gzip', encoding: 'gzip', decode: gunzipSync },
  ])(
    'serves a complete prepared $encoding stream for the original offer $original',
    async (each) => {
      const test = await fallbackEdgeFixture();
      const prepared = await preparedLoading(test);
      const render = Promise.withResolvers<Response>();

      test.dispatch.mockReturnValueOnce(render.promise);

      try {
        const response = await withDeadline(
          test.serve({
            pathname: LAZY_PATH,
            manifest: prepared.manifest,
            init: {
              headers: { 'accept-encoding': each.accept },
              cf: { clientAcceptEncoding: each.original },
            },
          }),
          1000,
          'prepared loading stream waited for its concrete render',
        );
        const wire = new Uint8Array(await response.arrayBuffer());

        expect(response.headers.get('content-encoding')).toBe(each.encoding);
        expect(response.headers.get('content-length')).toBe(String(wire.byteLength));
        expect(response.headers.get('vary')).toBe('accept-encoding');
        expect(response.headers.get('cache-control')).toBe(PUBLIC);
        expect(new Uint8Array(each.decode(wire))).toStrictEqual(test.native.loading);
        expect(test.fallback).not.toHaveBeenCalled();
        expect(test.dispatch).toHaveBeenCalledTimes(1);
      } finally {
        render.resolve(new Response(null));
        await waitOnExecutionContext(test.edge.ctx);
      }
    },
  );

  it.each(['missing', 'corrupt'] as const)(
    'falls back to identity bytes when the selected rendering is %s',
    async (failure) => {
      const test = await fallbackEdgeFixture();
      const prepared = await preparedLoading(test);
      const key = r2ArtifactKey(prepared.br.sha256);
      const operations = {
        missing: () => env.ARTIFACTS.delete(key),
        corrupt: () => env.ARTIFACTS.put(key, new Uint8Array(prepared.br.byteLength)),
      };

      await operations[failure]();

      const response = await test.serve({
        pathname: LAZY_PATH,
        manifest: prepared.manifest,
        init: { headers: { 'accept-encoding': 'br' } },
      });

      expect(response.headers.has('content-encoding')).toBe(false);
      expect(response.headers.get('content-length')).toBe(String(test.native.loading.byteLength));
      expect(response.headers.get('vary')).toBe('accept-encoding');
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(test.native.loading);
      expect(test.fallback).not.toHaveBeenCalled();

      await waitOnExecutionContext(test.edge.ctx);
    },
  );

  it('keeps identity when all prepared codings are refused', async () => {
    const test = await fallbackEdgeFixture();
    const prepared = await preparedLoading(test);
    const response = await test.serve({
      pathname: LAZY_PATH,
      manifest: prepared.manifest,
      init: { headers: { 'accept-encoding': 'br;q=0, gzip;q=0' } },
    });

    expect(response.headers.has('content-encoding')).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(test.native.loading);
    expect(test.fallback).not.toHaveBeenCalled();

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('keeps HEAD on the private passthrough even with prepared renderings', async () => {
    const test = await fallbackEdgeFixture();
    const prepared = await preparedLoading(test);
    const response = await test.serve({
      pathname: LAZY_PATH,
      manifest: prepared.manifest,
      init: { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } },
    });

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(test.fallback).toHaveBeenCalledWith('static-page-head');
    expect(test.dispatch).not.toHaveBeenCalled();

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('keeps loading delivery independent of a pending authority read and bounds repeated checks', async () => {
    const test = await fallbackEdgeFixture();
    const record = Promise.withResolvers<ArrayBuffer | undefined>();

    test.currentRecord.mockReturnValueOnce(record.promise);

    try {
      const first = await withDeadline(
        test.serve({ pathname: LAZY_PATH }),
        1000,
        'loading shell waited for the authority',
      );

      expect(test.fallback).not.toHaveBeenCalled();
      await expect(first.text()).resolves.toContain('hi fallback');

      const repeated = await test.serve({ pathname: LAZY_PATH });

      await expect(repeated.text()).resolves.toContain('hi fallback');
      expect(test.currentRecord).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      record.resolve(undefined);
      await waitOnExecutionContext(test.edge.ctx);
    }
  });

  it('waits only for the cold data request to publish its own first concrete pair', async () => {
    const test = await fallbackEdgeFixture();
    const member = await test.runtimeMember();
    const privateBody = '{"private":"capture response"}';

    test.dispatch.mockResolvedValueOnce(
      new Response(privateBody, { headers: { 'content-type': 'application/json' } }),
    );

    test.currentRecord.mockResolvedValueOnce(member.bytes.buffer as ArrayBuffer);

    const response = await test.serve({
      pathname: LAZY_DATA,
      init: { headers: { 'x-nextjs-data': '1' } },
    });

    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(member.data);
    expect(test.currentRecord.mock.calls).toStrictEqual([[FALLBACK_SCOPE, member.entryId, 0]]);
    expect(test.dispatch).toHaveBeenCalledTimes(1);

    const request = test.dispatch.mock.calls[0]?.[1];

    expect({
      pathname: new URL(request!.url).pathname,
      route: request?.headers.get(CACHE_ROUTE_HEADER),
      mode: request?.headers.get(REGENERATE_HEADER),
      generation: request?.headers.get(GENERATION_HEADER),
    }).toStrictEqual({
      pathname: LAZY_DATA,
      route: FALLBACK_ROUTE,
      mode: 'foreground',
      generation: null,
    });

    const html = await test.serve({ pathname: LAZY_PATH });

    expect(new Uint8Array(await html.arrayBuffer())).toStrictEqual(member.html);
    expect(test.dispatch).toHaveBeenCalledTimes(1);

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('keeps a cold JSON body intact and private when no independently proved publication appears', async () => {
    const test = await fallbackEdgeFixture();
    const privateBody = '{"pageProps":{"complete":"private JSON"}}';

    test.dispatch.mockResolvedValueOnce(
      new Response(privateBody, { headers: { 'content-type': 'application/json' } }),
    );

    const response = await test.serve({ pathname: LAZY_DATA });

    expect(response.headers.get('cache-control')).toContain('private');
    await expect(response.text()).resolves.toBe(privateBody);
    expect(test.currentRecord).toHaveBeenCalledTimes(6);
    expect(test.fallback).not.toHaveBeenCalled();

    await waitOnExecutionContext(test.edge.ctx);
  }, 20_000);

  it('preserves a private origin cookie response instead of adopting an otherwise valid pair', async () => {
    const test = await fallbackEdgeFixture();
    const member = await test.runtimeMember();
    const privateBody = '{"visitor":"private cookie response"}';

    test.dispatch.mockResolvedValueOnce(
      new Response(privateBody, {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=visitor; Path=/; HttpOnly',
        },
      }),
    );

    test.currentRecord.mockResolvedValueOnce(member.bytes.buffer as ArrayBuffer);

    const response = await test.serve({ pathname: LAZY_DATA });

    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('set-cookie')).toContain('session=visitor');
    await expect(response.text()).resolves.toBe(privateBody);
    expect(test.currentRecord).not.toHaveBeenCalled();
    expect(test.edge.runtime.memory.generations.get(member.key)).toBeUndefined();

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('does not recycle an expired pair as its own replacement, even if its timestamps were refreshed', async () => {
    const test = await fallbackEdgeFixture();
    const now = FALLBACK_NOW + 61_000;

    test.setNow(now);

    const old = encodeGenerationPack(
      { ...test.built.pack.header, cacheTimestamp: now, producedAt: now },
      test.built.pack.html,
      undefined,
    );

    test.currentRecord.mockResolvedValueOnce(old.buffer as ArrayBuffer);

    const privateBody = '{"still":"private original response"}';

    test.dispatch.mockResolvedValueOnce(
      new Response(privateBody, { headers: { 'content-type': 'application/json' } }),
    );

    const response = await test.serve({ pathname: BUILT_DATA });

    expect(response.headers.get('cache-control')).toContain('private');
    await expect(response.text()).resolves.toBe(privateBody);
    expect(test.currentRecord).toHaveBeenCalledWith(
      FALLBACK_SCOPE,
      test.built.entryId,
      test.built.pack.header.revision,
    );
    expect(test.edge.runtime.memory.generations.get(test.built.key)?.pack.header.generationId).toBe(
      test.built.pack.header.generationId,
    );

    await waitOnExecutionContext(test.edge.ctx);
  });

  it('adopts a strictly newer expired pair and keeps it ahead of the older KV record', async () => {
    const test = await fallbackEdgeFixture();

    test.setNow(FALLBACK_NOW + 61_000);

    const member = await test.runtimeMember(BUILT_PATH, 2, 2);

    test.currentRecord.mockResolvedValueOnce(member.bytes.buffer as ArrayBuffer);

    test.dispatch.mockResolvedValueOnce(
      new Response('private capture', { headers: { 'content-type': 'application/json' } }),
    );

    const response = await test.serve({ pathname: BUILT_DATA });

    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(member.data);
    expect(test.currentRecord.mock.calls).toStrictEqual([[FALLBACK_SCOPE, test.built.entryId, 1]]);

    await waitOnExecutionContext(test.edge.ctx);

    const html = await test.serve();

    expect(new Uint8Array(await html.arrayBuffer())).toStrictEqual(member.html);
    expect(test.edge.runtime.memory.generations.get(test.built.key)?.pack.header.generationId).toBe(
      member.pack.header.generationId,
    );
    expect({
      dispatch: test.dispatch.mock.calls.length,
      current: test.currentRecord.mock.calls.length,
    }).toStrictEqual({ dispatch: 1, current: 1 });
  });
});
