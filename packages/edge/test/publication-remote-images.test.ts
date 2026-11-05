import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { parseImageRequest, type ImagesConfig } from '@stayingupwind/core/images';
import { buildProjectManifest } from '@stayingupwind/core/manifest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleImage, type ImageInput } from '../src/handlers/image.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const GRANT = `upwind:publication:v1:${ID}:${String(NOW + 1000)}`;
const WITNESS = `upwind:resource-snapshot:v1:${ID}:4`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1024,
  remotePatterns: [],
  domains: ['images.test'],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

function fixture() {
  let now = NOW;
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    originHost: 'site.test',
    generatedAt: '2026-11-05T00:00:00Z',
    deployment: { assetSetHash: 'b'.repeat(64), observedAt: '2026-11-05T00:00:00Z' },
    app: { deploymentId: 'deployment', scriptName: 'application' },
    routes: [],
  });
  const kept = new Map<string, Response>();
  const match = vi.fn((key: Request) => Promise.resolve(kept.get(key.url)?.clone()));
  const put = vi.fn((key: Request, response: Response) => {
    kept.set(key.url, response.clone());
    return Promise.resolve();
  });
  vi.stubGlobal('caches', { open: () => Promise.resolve({ match, put }) });
  const source = vi.fn(() => Promise.resolve(new Response(PNG)));
  const transformed = vi.fn(async (body: ReadableStream<Uint8Array>) => {
    await new Response(body).arrayBuffer();
    return { contentType: 'image/webp', body: new Blob(['resized']).stream() };
  });
  const pending: Promise<unknown>[] = [];
  const edge = {
    projectId: 'site',
    host: {
      credentials: { headers: [], cookies: [] },
      names: { imageKeyOrigin: 'https://image.invalid', imageCache: 'images' },
      ownDomains: [],
      ownHostnames: [],
      observer: { metric: vi.fn(), imageTransformed: vi.fn() },
    },
    policy: { id: 'policy' },
    forwarding: { previewHost: 'site.test', previewDomain: 'invalid', clientIp: undefined },
    validated: false,
    app: manifest.app,
    runtime: { now: () => now, fetchImpl: source, transformImage: transformed },
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    },
  } as unknown as EdgeContext;
  const query = new URLSearchParams({ url: 'https://images.test/avatar.png', w: '64', q: '75' });
  const request = new Request(`https://site.test/_next/image?${query.toString()}`);
  const parsed = parseImageRequest(query, 'image/webp', CONFIG);
  if (parsed.kind !== 'ok') throw new Error('Expected a valid image fixture.');
  const input: ImageInput = {
    request,
    manifest,
    params: parsed.params,
    edge,
    config: CONFIG,
    configured: {
      headers: { 'Cloudflare-CDN-Cache-Control': 'public, max-age=3600' },
      conditioned: false,
    },
    middleware: undefined,
    dpl: undefined,
  };
  return {
    input,
    match,
    put,
    source,
    transformed,
    setNow(value: number) {
      now = value;
    },
    protect() {
      manifest.schemaVersion = 9;
      manifest.publication = { version: 1, identities: [ID], routes: ['/items'] };
    },
    async get() {
      const response = await handleImage(input);
      await Promise.all(pending);
      return response;
    },
  };
}

function unreadSource(cancel: () => void): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) controller.close();
        else {
          sent = true;
          controller.enqueue(PNG);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
}

describe('proof-aware edge remote images', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('misses unaware remote entries and keeps resizing, then reuses a tag-free aware entry', async () => {
    const test = fixture();

    await expect((await test.get()).text()).resolves.toBe('resized');

    const legacyKey = test.put.mock.calls[0]![0].url;

    await expect((await test.get()).text()).resolves.toBe('resized');

    expect(test.source).toHaveBeenCalledTimes(1);

    test.protect();

    await expect((await test.get()).text()).resolves.toBe('resized');

    const awareKey = test.put.mock.calls[1]![0].url;

    expect(awareKey).toContain('publication-aware-v1:');
    expect(legacyKey).not.toContain('publication-aware-v1:');
    await expect((await test.get()).text()).resolves.toBe('resized');
    expect(test.source).toHaveBeenCalledTimes(2);
  });

  it.each([GRANT, WITNESS, `${GRANT},${WITNESS}`])(
    'keeps original source proof through the actual Images transformation (%s)',
    async (tags) => {
      const test = fixture();

      test.protect();

      test.source.mockResolvedValueOnce(
        new Response(PNG, { headers: { 'x-next-cache-tags': tags } }),
      );

      const response = await test.get();

      await expect(response.text()).resolves.toBe('resized');
      expect(response.headers.get('x-next-cache-tags')).toBe(tags);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.has('Cloudflare-CDN-Cache-Control')).toBe(false);
      expect(test.transformed).toHaveBeenCalledTimes(1);
      expect(test.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    'upwind:publication:v9:invalid',
    'upwind:resource-snapshot:v1:broken',
    `${WITNESS},upwind:resource-snapshot:v1:broken`,
  ])('refuses malformed reserved proof and releases the unread source (%s)', async (tags) => {
    const test = fixture();
    const cancel = vi.fn();
    const body = unreadSource(cancel);

    test.protect();

    test.source.mockResolvedValueOnce(
      new Response(body, { headers: { 'x-next-cache-tags': tags } }),
    );

    expect((await test.get()).status).toBeGreaterThanOrEqual(400);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(test.transformed).not.toHaveBeenCalled();
    expect(test.put).not.toHaveBeenCalled();
  });

  it.each(['expired', 'rollback'] as const)(
    'cancels a source refused before its first read (%s)',
    async (mode) => {
      const test = fixture();

      test.protect();

      const cancel = vi.fn();
      const body = unreadSource(cancel);

      test.source.mockImplementationOnce(() => {
        test.setNow(mode === 'expired' ? NOW + 1000 : NOW - 1000);

        return Promise.resolve(new Response(body, { headers: { 'x-next-cache-tags': GRANT } }));
      });

      expect((await test.get()).status).toBe(503);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(test.transformed).not.toHaveBeenCalled();
      expect(test.put).not.toHaveBeenCalled();
    },
  );

  it('retains only the fresh fallback source proof after a failed transformation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The asserted fallback intentionally logs its failed Images call.
    });
    const test = fixture();

    test.protect();

    test.source
      .mockResolvedValueOnce(new Response(PNG, { headers: { 'x-next-cache-tags': GRANT } }))
      .mockResolvedValueOnce(new Response(PNG, { headers: { 'x-next-cache-tags': WITNESS } }));

    test.transformed.mockRejectedValueOnce(new Error('service unavailable'));

    const response = await test.get();

    await expect(response.bytes()).resolves.toStrictEqual(PNG);
    expect(response.headers.get('x-next-cache-tags')).toBe(WITNESS);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.source).toHaveBeenCalledTimes(2);
    expect(test.put).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('refuses proof that expires during the Images call before accepting a matching validator', async () => {
    const test = fixture();

    test.protect();

    test.source.mockResolvedValueOnce(
      new Response(PNG, { headers: { 'x-next-cache-tags': GRANT } }),
    );

    const transform = test.transformed.getMockImplementation()!;

    test.transformed.mockImplementationOnce(async (body) => {
      const result = await transform(body);

      test.setNow(NOW + 1000);

      return result;
    });

    test.input.request.headers.set('if-none-match', `"${await sha256HexOfText('resized')}"`);

    expect((await test.get()).status).toBe(503);
    expect(test.put).not.toHaveBeenCalled();
  });

  it('rejects a late transformed chunk after its original source grant expires', async () => {
    const test = fixture();

    test.protect();

    test.source.mockResolvedValueOnce(
      new Response(PNG, { headers: { 'x-next-cache-tags': GRANT } }),
    );

    const cancel = vi.fn();
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const first = new Uint8Array(8 * 1024 * 1024 + 1);

    test.transformed.mockResolvedValueOnce({
      contentType: 'image/webp',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
          controller.enqueue(first);
        },
        cancel,
      }),
    });

    const response = await test.get();
    const reader = response.body!.getReader();

    const firstRead = await reader.read();

    expect(firstRead.done).toBe(false);
    expect(firstRead.value).toHaveLength(first.byteLength);

    const next = reader.read();
    await Promise.resolve();

    test.setNow(NOW + 1000);

    output!.enqueue(new Uint8Array([2]));

    await expect(next).rejects.toThrow('Publication unavailable');

    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    expect(test.put).not.toHaveBeenCalled();
  });
});
