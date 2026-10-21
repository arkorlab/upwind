import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchApp, TransformImage } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

async function serving(middleware: boolean) {
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const path = `/_next/static/media/${crypto.randomUUID()}.png`;
  const bytes = concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8(path),
  ]);
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: middleware ? { matchers: [{ sourceRegex: '^/_next/image$' }] } : undefined,
    staticFiles: {
      [path]: { sha256, byteLength: bytes.byteLength, contentType: 'image/png', immutable: true },
    },
  };
  const dispatch = vi.fn<DispatchApp>(() => {
    const response = new Response(null, { headers: { 'x-middleware-next': '1' } });
    return Promise.resolve(response);
  });
  const transform = vi.fn<TransformImage>(async (source, options) => {
    const body = new Uint8Array(await new Response(source).arrayBuffer());
    return {
      contentType: options.format,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    };
  });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: dispatch,
    transformImage: transform,
  });
  const get = async (headers: HeadersInit, ownedHeaders: readonly string[]) => {
    const query = new URLSearchParams({ url: path, w: '64', q: '75' });
    const request = new Request<unknown, IncomingRequestCfProperties>(
      `https://site.example/_next/image?${query.toString()}`,
      { headers },
    );
    const ctx = createExecutionContext();
    try {
      const response = await serveFromPointer(
        {
          request,
          url: new URL(request.url),
          env,
          ctx,
          runtime,
          host: {
            ...standaloneHost(env),
            credentials: { cookies: [], headers: ownedHeaders },
          },
          pointer: {
            ...site.pointer,
            app: {
              deploymentId: 'dpl_site',
              scriptName: 'site-app',
              middlewareScriptName: 'site-middleware',
            },
          },
          pointerMs: 0,
          privateDelivery: false,
          cspReportingPath: undefined,
        },
        {
          manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
          policyLookup: Promise.resolve({
            kind: 'found',
            source: 'exact',
            policy: DEFAULT_DELIVERY_POLICY,
          }),
        },
      );
      return { response, body: new Uint8Array(await response.arrayBuffer()), request };
    } finally {
      await waitOnExecutionContext(ctx);
    }
  };
  return { get, bytes, dispatch, transform };
}

const CASES = [
  { label: 'without middleware', middleware: false },
  { label: 'after middleware', middleware: true },
];

describe('host-owned headers on optimized images', () => {
  it.each(CASES)('ignores only host-owned validators $label', async (example) => {
    const site = await serving(example.middleware);
    const owned = await site.get({ 'If-None-Match': '*' }, ['IF-NONE-MATCH']);
    const visible = await site.get({ 'If-None-Match': '*' }, []);

    expect(owned.response.status).toBe(200);
    expect(owned.body).toStrictEqual(site.bytes);
    expect(owned.request.headers.get('if-none-match')).toBe('*');
    expect(visible.response.status).toBe(304);
    expect(visible.body.byteLength).toBe(0);
  });

  it.each(CASES)('negotiates from application-visible Accept $label', async (example) => {
    const site = await serving(example.middleware);
    const owned = await site.get({ Accept: 'image/webp' }, ['Accept']);

    expect(owned.response.status).toBe(200);
    expect(owned.response.headers.get('content-type')).toBe('image/png');
    expect(owned.request.headers.get('accept')).toBe('image/webp');

    const visible = await site.get({ Accept: 'image/webp' }, []);

    expect(visible.response.status).toBe(200);
    expect(visible.response.headers.get('content-type')).toBe('image/webp');
  });

  it('keeps the warmed image cache for host-owned validators without middleware', async () => {
    const site = await serving(false);
    const first = await site.get({}, ['If-None-Match']);
    const repeated = await site.get({ 'If-None-Match': '*' }, ['If-None-Match']);

    expect(first.response.status).toBe(200);
    expect(repeated.response.status).toBe(200);
    expect(repeated.body).toStrictEqual(site.bytes);
    expect(repeated.response.headers.get('x-nextjs-cache')).toBe('HIT');
    expect(site.transform).toHaveBeenCalledTimes(1);
    expect(site.dispatch).not.toHaveBeenCalled();
  });
});
