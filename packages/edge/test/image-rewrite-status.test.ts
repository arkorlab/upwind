import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
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
const OUTPUT = encodeUtf8('optimized');
const PNG = concatBytes([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  new Uint8Array(2048),
]);

interface Options {
  readonly status: number;
  readonly method?: string;
  readonly validator?: string;
  readonly invalid?: boolean;
  readonly streamed?: boolean;
}

async function rewrittenImage(options: Options) {
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/_next/image$' }] },
  };
  const metrics: EdgeMetric[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () => {
      const query = new URLSearchParams({
        url: `https://cdn.site.example/${crypto.randomUUID()}.png`,
        w: '64',
        q: options.invalid === true ? '0' : '75',
      });
      return Promise.resolve(
        new Response(null, {
          status: options.status,
          headers: {
            'x-middleware-rewrite': `https://site.example/_next/image?${query.toString()}`,
            'set-cookie': 'mw=1; Path=/',
          },
        }),
      );
    },
    fetchImpl: () => Promise.resolve(new Response(PNG)),
    transformImage: async (source) => {
      await new Response(source).arrayBuffer();
      const bytes = options.streamed === true ? new Uint8Array(9 * 1024 * 1024) : OUTPUT;
      return {
        contentType: 'image/webp',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
  });
  const host = standaloneHost(env);
  const request = new Request<unknown, IncomingRequestCfProperties>(
    'https://site.example/_next/image?url=%2Foriginal.png&w=64&q=75',
    {
      method: options.method ?? 'GET',
      headers: {
        accept: 'image/webp',
        'sec-fetch-dest': 'image',
        ...(options.validator !== undefined && { 'if-none-match': options.validator }),
      },
    },
  );
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host: {
        ...host,
        observer: {
          ...host.observer,
          metric: (metric) => {
            metrics.push(metric);
          },
        },
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
  await waitOnExecutionContext(ctx);
  return { response, metrics };
}

describe('an optimized image under its middleware rewrite status', () => {
  it.each([201, 409])('keeps status %s and the optimized representation', async (status) => {
    const { response, metrics } = await rewrittenImage({ status });

    expect(response.status).toBe(status);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(OUTPUT);
    expect(response.headers.get('content-length')).toBe(String(OUTPUT.byteLength));
    expect(response.headers.get('set-cookie')).toContain('mw=1');
    expect(metrics.at(-1)?.suffixBytes).toBe(OUTPUT.byteLength);
  });

  it.each([204, 205, 304])('sends no body or length for rewrite status %s', async (status) => {
    const { response, metrics } = await rewrittenImage({ status });

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(response.headers.has('content-length')).toBe(false);
    expect(metrics.at(-1)?.suffixBytes).toBe(0);
  });

  it('keeps the HEAD representation length and sends no image', async () => {
    const { response, metrics } = await rewrittenImage({ status: 201, method: 'HEAD' });

    expect(response.status).toBe(201);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBe(String(OUTPUT.byteLength));
    expect(metrics.at(-1)?.suffixBytes).toBe(0);
  });

  it('retains the optimizer conditional 304 over the rewrite status', async () => {
    const validator = `"${await sha256Hex(OUTPUT)}"`;
    const { response, metrics } = await rewrittenImage({ status: 201, validator });

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.has('content-length')).toBe(false);
    expect(metrics.at(-1)?.suffixBytes).toBe(0);
  });

  it('retains an optimizer refusal instead of the rewrite status', async () => {
    const { response } = await rewrittenImage({ status: 201, invalid: true });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('quality');
  });

  it('releases an uncached streamed image and counts no body for a bodyless status', async () => {
    const { response, metrics } = await rewrittenImage({ status: 204, streamed: true });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.has('content-length')).toBe(false);
    expect(metrics.at(-1)?.suffixBytes).toBe(0);
  });
});
