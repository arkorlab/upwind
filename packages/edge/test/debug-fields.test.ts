import type { ImagesConfig } from '@stayingupwind/core/images';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const BODY = 'served bytes';
const IMAGES: ImagesConfig = {
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
    { protocol: 'https', hostname: String.raw`^cdn\.site\.example$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const IDENTITIES = [
  { value: 'site:one+two ._~', encoded: 'site:one+two ._~' },
  { value: 'line\r\nbreak', encoded: 'line%5Cr%5Cnbreak' },
  { value: 'nul\0byte', encoded: 'nul%5Cu0000byte' },
  { value: '\u{D800}', encoded: '%5Cud800' },
  { value: '\u{DC00}', encoded: '%5Cudc00' },
  { value: '😀', encoded: '%F0%9F%98%80' },
  { value: 'site;policy=forged', encoded: 'site%3Bpolicy=forged' },
  { value: '%3B', encoded: '%253B' },
  { value: String.raw`\ud800`, encoded: String.raw`\ud800` },
  { value: 'aaaaaaa😀', encoded: 'aaaaaaa%F0%9F%98%80' },
] as const;
type Family = 'static' | 'segment' | 'image';

/** The image service's known bytes under both Workers and DOM stream declarations. */
function transformedBody(): ReadableStream<Uint8Array> {
  const bytes = encodeUtf8(BODY);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The public entry with actual stored file/segment bytes and an image service's result. */
async function serve(family: Family, identity: string) {
  const document = pprDocument();
  const site = await seedSite({
    document,
    files: { '/manual.txt': BODY },
    images: IMAGES,
    segments: { '/_tree': BODY },
  });
  const source = `https://cdn.site.example/${crypto.randomUUID()}.png`;
  let path = '/';
  if (family === 'static') {
    path = '/manual.txt';
  } else if (family === 'image') {
    path = `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;
  }
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://site.example${path}`, {
    headers:
      family === 'segment'
        ? {
            rsc: '1',
            'next-router-prefetch': '1',
            'next-router-segment-prefetch': '/_tree',
          }
        : { accept: family === 'image' ? 'image/webp' : 'text/html' },
  });
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sourceBytes = concatBytes([signature, encodeUtf8(source)]);
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        fetchImpl: () => Promise.resolve(new Response(sourceBytes)),
        transformImage: async (stream) => {
          await new Response(stream).arrayBuffer();
          return { contentType: 'image/webp', body: transformedBody() };
        },
      }),
      host: standaloneHost(env),
      pointer: { ...site.pointer, projectId: identity },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({
        kind: 'found',
        value: { ...site.manifest, projectId: identity },
      }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text, expected: BODY };
}

describe.each(['static', 'segment', 'image'] as const)('%s project diagnostic', (family) => {
  it.each(IDENTITIES)(
    'keeps the response and field boundaries for $encoded',
    async ({ value, encoded }) => {
      const { response, text, expected } = await serve(family, value);
      const debug = response.headers.get(EDGE_DEBUG_HEADER) ?? '';

      expect(response.status).toBe(200);
      expect(text).toBe(expected);
      expect(debug.split(';')).toContain(`project=${encoded}`);
      expect(debug.split(';')).not.toContain('policy=forged');
      expect(debug.split(';')).toContain(`policy=${DEFAULT_DELIVERY_POLICY.id}`);
    },
  );
});

const ROUTES = [
  { pathname: '/ordinary', expected: '/ordinary' },
  { pathname: '/items/[id]', expected: '/items/[id]' },
  { pathname: '/percent%3B', expected: '/percent%3B' },
  { pathname: '/semi;policy=forged', expected: '~%2Fsemi%3Bpolicy%3Dforged' },
  { pathname: '/line\r\nbreak', expected: '~%2Fline%5Cr%5Cnbreak' },
  { pathname: '/nul\0byte', expected: '~%2Fnul%5Cu0000byte' },
  { pathname: '/space ', expected: '~%2Fspace%20' },
  { pathname: '/日本', expected: '~%2F%E6%97%A5%E6%9C%AC' },
  { pathname: '/a;b', expected: '~%2Fa%3Bb' },
  { pathname: '/a%3Bb', expected: '/a%3Bb' },
] as const;

describe('document route diagnostics through the public entry', () => {
  it.each(ROUTES)('serves the admitted route as one field: $expected', async (example) => {
    const document = pprDocument();
    const site = await seedSite({ document, pathname: example.pathname });
    // Encode each segment as a request does. The route lookup decodes it before finding the entry.
    const path = example.pathname
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const request = navigation(path);
    const ctx = createExecutionContext();
    const response = await serveFromPointer({
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: () => Promise.resolve(htmlResponse(document.suffix)),
      }),
      host: standaloneHost(env),
      pointer: site.pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    const text = await response.text();
    await waitOnExecutionContext(ctx);
    const debug = response.headers.get(EDGE_DEBUG_HEADER) ?? '';

    expect(response.status).toBe(200);
    expect(text).toBe(document.shellText + document.suffixText);
    expect(debug.split(';')).toContain(`route=${example.expected}`);
    expect(debug.split(';')).not.toContain('policy=forged');
    expect(debug.split(';').filter((field) => field.startsWith('route='))).toHaveLength(1);
  });
});
