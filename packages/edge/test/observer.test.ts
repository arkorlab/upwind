import type { ImagesConfig } from '@stayingupwind/core/images';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import type { EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, type StandaloneEnv, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

/**
 * The host's observer (`EdgeHost.observer`) is the host's own code. One that throws is the host's
 * to mend, and changes no answer: none fails, and none is answered otherwise for it.
 */

const SITE = 'site.example';
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
    { protocol: 'https', hostname: String.raw`^(?:^(?:cdn\.site\.example)$)$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const OPTIMIZED = encodeUtf8('optimized');

function thrower(what: string): () => never {
  return () => {
    throw new Error(`the observer gave out on ${what}`);
  };
}

/** What an observer that keeps to its part does with what it is told: nothing, here. */
function quiet(): void {
  // Told, and nothing done with it.
}

/** A host whose observer throws on whatever `throwing` names, and is quiet otherwise. */
function hostThrowingOn(site: StandaloneEnv, throwing: readonly string[]): EdgeHost {
  const pick = (name: string): (() => void) => (throwing.includes(name) ? thrower(name) : quiet);
  return {
    ...standaloneHost(site),
    observer: {
      metric: pick('metric'),
      recordServed: pick('recordServed'),
      imageTransformed: pick('imageTransformed'),
    },
  };
}

/** A PNG by its signature, different every time so no test finds another's cache entry. */
function pngBytes(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concatBytes([signature, encodeUtf8(crypto.randomUUID())]);
}

/** The site's Function, its image sources on the internet, and an image service that answers. */
function runtimeOf(site: StandaloneEnv, png: Uint8Array): EdgeRuntime {
  return standaloneRuntime(site, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_scriptName, request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/') {
        return Promise.resolve(htmlResponse(pprDocument().suffix));
      }
      return Promise.resolve(
        new Response(`asked ${pathname}`, { headers: { 'cache-control': 'no-store' } }),
      );
    },
    fetchImpl: () =>
      Promise.resolve(new Response(png, { headers: { 'content-type': 'image/png' } })),
    transformImage: async (source) => {
      await new Response(source).arrayBuffer();
      return { contentType: 'image/webp', body: new Blob([OPTIMIZED]).stream() };
    },
  });
}

/** A site as the edge serves it: its bindings, the pointer it is served by, and its host. */
interface Served {
  readonly site: StandaloneEnv;
  readonly pointer: EdgePointer;
  readonly host: EdgeHost;
  readonly runtime: EdgeRuntime;
}

async function serve(
  served: Served,
  request: IncomingRequest,
): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env: served.site,
    ctx,
    runtime: served.runtime,
    host: served.host,
    pointer: served.pointer,
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { response, bytes };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function imageOf(source: string): IncomingRequest {
  const query = `url=${encodeURIComponent(source)}&w=64&q=75`;
  return new Request(`https://${SITE}/_next/image?${query}`, {
    headers: { accept: 'image/webp,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image' },
  });
}

describe('an observer that throws', () => {
  /** Told before an answer goes out, or as it does, it neither fails one (Codex, upwind#179). */
  it('changes no answer, of whatever kind', async () => {
    const document = pprDocument();
    const { pointer } = await seedSite({
      document,
      files: { '/robots.txt': 'User-agent: *' },
      images: IMAGES,
      segments: { '/_tree': '0:["tree"]\n' },
    });
    const site = { ...env };
    const served: Served = {
      site,
      pointer,
      host: hostThrowingOn(site, ['metric', 'recordServed', 'imageTransformed']),
      runtime: runtimeOf(site, pngBytes()),
    };

    const page = await serve(served, navigation('/'));
    const handedOn = await serve(served, navigation('/api/hello'));
    const file = await serve(served, navigation('/robots.txt'));
    const asset = await serve(served, navigation('/_next/static/chunks/a.js'));
    const segment = await serve(
      served,
      new Request(`https://${SITE}/`, {
        headers: {
          rsc: '1',
          'next-router-prefetch': '1',
          'next-router-segment-prefetch': '/_tree',
        },
      }),
    );
    const image = await serve(served, imageOf(`https://cdn.${SITE}/a.png`));

    expect(text(page.bytes)).toBe(document.shellText + document.suffixText);
    expect(text(handedOn.bytes)).toBe('asked /api/hello');
    expect(text(file.bytes)).toBe('User-agent: *');
    expect(text(asset.bytes)).toBe('asked /_next/static/chunks/a.js');
    expect(text(segment.bytes)).toBe('0:["tree"]\n');
    expect(image.response.headers.get('content-type')).toBe('image/webp');
    expect(image.bytes).toStrictEqual(OPTIMIZED);
  });

  /**
   * Told once the service has answered, and not taken for the service failing: the source is not
   * fetched again and served untransformed in the result's place (Codex, upwind#179).
   */
  it('on an image transformed is not taken for the transformation failing', async () => {
    const { pointer } = await seedSite({ document: pprDocument(), images: IMAGES });
    const site = { ...env };
    let fetched = 0;
    const runtime = runtimeOf(site, pngBytes());
    const served: Served = {
      site,
      pointer,
      host: hostThrowingOn(site, ['imageTransformed']),
      runtime: {
        ...runtime,
        fetchImpl: (request, init) => {
          fetched += 1;
          return runtime.fetchImpl(request, init);
        },
      },
    };

    const { response, bytes } = await serve(served, imageOf(`https://cdn.${SITE}/b.png`));

    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(bytes).toStrictEqual(OPTIMIZED);
    expect(fetched).toBe(1);
  });
});
