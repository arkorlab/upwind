import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_VALIDATED_HEADER } from '@stayingupwind/core/request';
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
const RULE_TAG = '"configured-tag"';
const RULE_CSP = "default-src 'self'";
const STREAM_BYTES = 9 * 1024 * 1024;
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
  readonly configured?: boolean;
  readonly nominatedCookie?: boolean;
}

async function rewrittenImage(options: Options) {
  const site = await seedSite({
    document: pprDocument(),
    images: CONFIG,
    headerRules:
      options.configured === true
        ? [
            {
              sourceRegex: '^/_next/image$',
              headers: {
                'Content-Encoding': 'gzip',
                'Content-Length': '1',
                ETag: RULE_TAG,
                'Content-Range': 'bytes 0-0/1',
                'Accept-Ranges': 'bytes',
                Connection:
                  options.nominatedCookie === true
                    ? 'X-Internal, Set-Cookie'
                    : 'X-Internal, not a name',
                'Keep-Alive': 'timeout=5',
                'Transfer-Encoding': 'chunked',
                [EDGE_VALIDATED_HEADER]: '1',
                'X-Internal': 'one hop',
                'Content-Type': 'text/html',
                'Content-Security-Policy': RULE_CSP,
                'Access-Control-Allow-Origin': '*',
                'Set-Cookie': 'rule=1; Path=/',
                'X-Rule': 'retained',
              },
            },
          ]
        : undefined,
  });
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
      const bytes = options.streamed === true ? new Uint8Array(STREAM_BYTES) : OUTPUT;
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

describe('configured headers beside an optimized image', () => {
  it.each([
    {
      kind: 'buffered',
      status: 201,
      expectedLength: String(OUTPUT.byteLength),
      expectedBytes: OUTPUT.byteLength,
    },
    {
      kind: 'HEAD',
      status: 201,
      method: 'HEAD',
      expectedLength: String(OUTPUT.byteLength),
      expectedBytes: 0,
    },
    { kind: 'refusal', status: 400, invalid: true, expectedLength: null },
    {
      kind: 'streamed',
      status: 201,
      streamed: true,
      expectedLength: null,
      expectedBytes: STREAM_BYTES,
    },
    {
      kind: 'streamed conditional',
      status: 201,
      streamed: true,
      validator: RULE_TAG,
      expectedLength: null,
      expectedBytes: STREAM_BYTES,
    },
  ])('preserves the owned metadata of a $kind response', async (options) => {
    const { response } = await rewrittenImage({ ...options, status: 201, configured: true });
    const body = await response.arrayBuffer();

    expect(response.status).toBe(options.status);
    expect({
      coding: response.headers.get('content-encoding'),
      length: response.headers.get('content-length'),
      range: response.headers.get('content-range'),
      acceptsRanges: response.headers.get('accept-ranges'),
      connection: response.headers.get('connection'),
      keepAlive: response.headers.get('keep-alive'),
      transfer: response.headers.get('transfer-encoding'),
      platform: response.headers.get(EDGE_VALIDATED_HEADER),
      nominated: response.headers.get('x-internal'),
    }).toStrictEqual({
      coding: null,
      length: options.expectedLength,
      range: null,
      acceptsRanges: null,
      connection: null,
      keepAlive: null,
      transfer: null,
      platform: null,
      nominated: null,
    });
    expect(response.headers.get('content-type')).toBe(
      options.invalid === true ? 'text/plain; charset=utf-8' : 'image/webp',
    );
    expect(response.headers.get('etag')).toBe(
      options.invalid === true || options.streamed === true ? null : `"${await sha256Hex(OUTPUT)}"`,
    );
    expect({
      csp: response.headers.get('content-security-policy'),
      cors: response.headers.get('access-control-allow-origin'),
      cookies: response.headers.getSetCookie(),
      rule: response.headers.get('x-rule'),
    }).toStrictEqual({
      csp: options.invalid === true ? RULE_CSP : CONFIG.contentSecurityPolicy,
      cors: '*',
      cookies: ['rule=1; Path=/', 'mw=1; Path=/'],
      rule: 'retained',
    });
    expect({
      bytes: options.expectedBytes === undefined ? undefined : body.byteLength,
      refusal:
        options.invalid === true ? new TextDecoder().decode(body).includes('quality') : undefined,
    }).toStrictEqual({
      bytes: options.expectedBytes,
      refusal: options.invalid === true ? true : undefined,
    });
  });

  it('retains an independent middleware cookie after configured Connection nominations', async () => {
    const { response } = await rewrittenImage({
      status: 201,
      configured: true,
      nominatedCookie: true,
    });

    await response.arrayBuffer();

    expect(response.headers.getSetCookie()).toStrictEqual(['mw=1; Path=/']);
  });

  it('keeps the optimized validator conditional under configured headers', async () => {
    const validator = `"${await sha256Hex(OUTPUT)}"`;
    const { response } = await rewrittenImage({ status: 201, configured: true, validator });

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get('etag')).toBe(validator);
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
  });
});
