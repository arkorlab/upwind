import type { ImagesConfig } from '@stayingupwind/core/images';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [
    { protocol: 'https', hostname: String.raw`^(?:cdn\.site\.example)$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const PNG = concatBytes([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  new Uint8Array(2048),
]);
const OUTPUT = encodeUtf8('optimized');
const CACHED = encodeUtf8('cached');

/**
 * An optimizer request whose cache lookup is held: its `match` until `lookup` settles, and — where
 * `heldOpen` — opening the cache itself until `opening` settles. Returned once the held step began.
 */
async function imageLookup({ heldOpen = false }: { readonly heldOpen?: boolean } = {}) {
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const host = standaloneHost(env);
  const cache = await caches.open(host.names.imageCache);
  const entered = Promise.withResolvers<undefined>();
  const lookup = Promise.withResolvers<Response | undefined>();
  const match = vi.spyOn(cache, 'match').mockImplementation(() => {
    entered.resolve(undefined);
    return lookup.promise;
  });
  const opening = Promise.withResolvers<Cache>();
  if (heldOpen) {
    vi.spyOn(caches, 'open').mockImplementation(() => {
      entered.resolve(undefined);
      return opening.promise;
    });
  } else {
    vi.spyOn(caches, 'open').mockResolvedValue(cache);
  }
  const fetchSource = vi.fn(() => Promise.resolve(new Response(PNG)));
  const transform = vi.fn(async (source: ReadableStream<Uint8Array>) => {
    await new Response(source).arrayBuffer();
    return {
      contentType: 'image/webp',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(OUTPUT);
          controller.close();
        },
      }),
    };
  });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    fetchImpl: fetchSource,
    transformImage: transform,
  });
  const query = new URLSearchParams({
    url: `https://cdn.site.example/${crypto.randomUUID()}.png`,
    w: '64',
    q: '75',
  });
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://site.example/_next/image?${query.toString()}`,
    { headers: { accept: 'image/webp', 'sec-fetch-dest': 'image' } },
  );
  const ctx = createExecutionContext();
  vi.useFakeTimers();
  const response = serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host,
    pointer: site.pointer,
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  await entered.promise;
  return { lookup, opening, cache, match, response, ctx, fetchSource, transform };
}

function cacheHit(body: BodyInit): Response {
  return new Response(body, {
    headers: { 'content-type': 'image/webp', 'content-length': String(CACHED.byteLength) },
  });
}

describe('an image cache lookup that outlives its deadline', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['settled', 'pending', 'rejected'] as const)(
    'releases a late hit with %s cancellation after optimizing the miss',
    async (cancellation) => {
      const run = await imageLookup();
      await vi.advanceTimersByTimeAsync(100);
      const response = await run.response;

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(OUTPUT);
      expect(run.fetchSource).toHaveBeenCalledTimes(1);
      expect(run.transform).toHaveBeenCalledTimes(1);

      const cancel = vi.fn(() => {
        if (cancellation === 'pending')
          return new Promise<void>(() => {
            /* A cache need not acknowledge its stream's cancellation. */
          });
        if (cancellation === 'rejected') return Promise.reject(new Error('cache cancel failed'));
        return Promise.resolve();
      });
      run.lookup.resolve(cacheHit(new ReadableStream<Uint8Array>({ cancel })));
      await vi.advanceTimersByTimeAsync(0);

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(run.fetchSource).toHaveBeenCalledTimes(1);
      expect(run.transform).toHaveBeenCalledTimes(1);

      await waitOnExecutionContext(run.ctx);
    },
  );

  it.each([
    {
      kind: 'miss',
      finish: (lookup: PromiseWithResolvers<Response | undefined>) => {
        lookup.resolve(undefined);
      },
    },
    {
      kind: 'rejection',
      finish: (lookup: PromiseWithResolvers<Response | undefined>) => {
        lookup.reject(new Error('lookup failed late'));
      },
    },
  ])('handles a late $kind after optimizing', async ({ finish }) => {
    const run = await imageLookup();
    await vi.advanceTimersByTimeAsync(100);
    const response = await run.response;

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(OUTPUT);

    finish(run.lookup);
    await vi.advanceTimersByTimeAsync(0);

    expect(run.fetchSource).toHaveBeenCalledTimes(1);
    expect(run.transform).toHaveBeenCalledTimes(1);

    await waitOnExecutionContext(run.ctx);
  });

  it('optimizes the miss within the deadline where the cache does not open', async () => {
    const run = await imageLookup({ heldOpen: true });
    await vi.advanceTimersByTimeAsync(100);
    const response = await run.response;

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(OUTPUT);
    expect(run.fetchSource).toHaveBeenCalledTimes(1);
    expect(run.transform).toHaveBeenCalledTimes(1);

    // Opened late, the cache is asked nothing: no hit can arrive with no reader for its body.
    run.opening.resolve(run.cache);
    await vi.advanceTimersByTimeAsync(0);

    expect(run.match).not.toHaveBeenCalled();
    expect(run.fetchSource).toHaveBeenCalledTimes(1);

    await waitOnExecutionContext(run.ctx);
  });

  it('counts the time the cache took to open toward the deadline', async () => {
    const run = await imageLookup({ heldOpen: true });
    await vi.advanceTimersByTimeAsync(60);
    run.opening.resolve(run.cache);
    await vi.advanceTimersByTimeAsync(0);

    expect(run.match).toHaveBeenCalledTimes(1);
    expect(run.fetchSource).not.toHaveBeenCalled();

    // Forty more, not a hundred from the match: the deadline is the lookup's, opening included.
    await vi.advanceTimersByTimeAsync(40);
    const response = await run.response;

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(OUTPUT);
    expect(run.fetchSource).toHaveBeenCalledTimes(1);

    // The match that answers after that has its hit let go.
    const cancel = vi.fn(() => Promise.resolve());
    run.lookup.resolve(cacheHit(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(0);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(run.transform).toHaveBeenCalledTimes(1);

    await waitOnExecutionContext(run.ctx);
  });

  it('keeps a timely hit with its response reader', async () => {
    const run = await imageLookup();
    const hit = cacheHit(CACHED);
    const cancel = vi.spyOn(hit.body!, 'cancel');
    run.lookup.resolve(hit);
    const response = await run.response;

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(CACHED);
    expect(response.headers.get('content-length')).toBe(String(CACHED.byteLength));
    expect(cancel).not.toHaveBeenCalled();
    expect(run.fetchSource).not.toHaveBeenCalled();
    expect(run.transform).not.toHaveBeenCalled();

    await waitOnExecutionContext(run.ctx);
  });

  it('optimizes a timely miss without waiting for the cache deadline', async () => {
    const run = await imageLookup();
    run.lookup.resolve(undefined);
    const response = await run.response;

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(OUTPUT);
    expect(run.fetchSource).toHaveBeenCalledTimes(1);
    expect(run.transform).toHaveBeenCalledTimes(1);

    await waitOnExecutionContext(run.ctx);
  });
});
