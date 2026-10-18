import { sha256Hex, sha256HexOfText } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest, StaticFileEntry } from '@stayingupwind/core/manifest';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { type ImageSource, imageSourceId } from '../src/handlers/image-source.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CURRENT = 'dpl_site';
const PREVIOUS = 'dpl_previous';
const HOST = 'site.example';
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
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

function file(sha256: string): StaticFileEntry {
  return { sha256, byteLength: 32, contentType: 'image/png', immutable: false };
}

function gated(sha256: string, href = '/logo.png'): ImageSource {
  return { kind: 'blob', file: file(sha256), href, gate: 'middleware' };
}

/** Different PNG signatures' payloads, passed through the test transformer as their own result. */
function png(text: string): Uint8Array {
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8(text),
  ]);
}

async function store(bytes: Uint8Array): Promise<StaticFileEntry> {
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  return { ...file(sha256), byteLength: bytes.byteLength };
}

/** Middleware covers only the file; the optimizer itself remains eligible for the shared cache. */
async function serving() {
  const path = `/gated/${crypto.randomUUID()}.png`;
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const now = png('current image');
  const before = png('previous image');
  const [own, kept] = await Promise.all([store(now), store(before)]);
  const app = {
    deploymentId: CURRENT,
    scriptName: 'site-app',
    middlewareScriptName: 'site-middleware',
  };
  const manifest: ProjectManifest = {
    ...site.manifest,
    deployment: { ...site.manifest.deployment, dplId: CURRENT },
    middleware: { matchers: [{ sourceRegex: '^/gated/' }] },
    staticFiles: {
      [path]: { ...own, deploymentId: CURRENT, previous: { ...kept, deploymentId: PREVIOUS } },
    },
  };
  const middleware = vi.fn(() =>
    Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } })),
  );
  const transform = vi.fn(async (source: ReadableStream<Uint8Array>) => {
    const bytes = await new Response(source).arrayBuffer();
    return { contentType: 'image/webp', body: new Blob([bytes]).stream() };
  });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: middleware,
    transformImage: transform,
  });
  const get = async (dpl: string) => {
    const query = new URLSearchParams({ url: path, w: '64', q: '75', dpl });
    const request = new Request<unknown, IncomingRequestCfProperties>(
      `https://${HOST}/_next/image?${query.toString()}`,
      { headers: { accept: 'image/webp', 'sec-fetch-dest': 'image' } },
    );
    const ctx = createExecutionContext();
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
        host: standaloneHost(env),
        pointer: { ...site.pointer, app },
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
    const body = new Uint8Array(await response.arrayBuffer());
    await waitOnExecutionContext(ctx);
    return { response, body };
  };
  return { get, now, before, middleware, transform };
}

describe('an optimized image source identity', () => {
  it.each(['middleware', 'reserved'] as const)(
    'separates selected file bytes behind a %s gate at the same deployment, host and path',
    async (gate) => {
      const now = { ...gated('a'.repeat(64)), gate };
      const before = { ...gated('b'.repeat(64)), gate };

      const [current, previous] = await Promise.all([
        imageSourceId(now, CURRENT, HOST),
        imageSourceId(before, CURRENT, HOST),
      ]);

      expect(previous).not.toBe(current);
      expect(current).toMatch(/^local:dpl_site:site\.example:[0-9a-f]{64}$/u);
    },
  );

  it('keeps a gated file separated by deployment, host and path, and reuses the same selected bytes', async () => {
    const source = gated('a'.repeat(64));
    const current = await imageSourceId(source, CURRENT, HOST);
    const otherPath = gated('a'.repeat(64), '/other.png');

    await expect(imageSourceId(source, CURRENT, HOST)).resolves.toBe(current);
    await expect(imageSourceId(source, PREVIOUS, HOST)).resolves.not.toBe(current);
    await expect(imageSourceId(source, CURRENT, 'other.example')).resolves.not.toBe(current);
    await expect(imageSourceId(otherPath, CURRENT, HOST)).resolves.not.toBe(current);
  });

  it('preserves ordinary file, local and remote identity bytes', async () => {
    const sha256 = 'a'.repeat(64);
    const source: ImageSource = {
      kind: 'blob',
      file: file(sha256),
      href: '/logo.png',
      gate: 'none',
    };
    const local = '/draw.png';
    const remote = 'https://cdn.example/logo.png';

    await expect(imageSourceId(source, CURRENT, HOST)).resolves.toBe(`blob:${sha256}`);
    await expect(imageSourceId(source, PREVIOUS, 'other.example')).resolves.toBe(`blob:${sha256}`);
    await expect(imageSourceId({ kind: 'local', href: local }, CURRENT, HOST)).resolves.toBe(
      `local:${CURRENT}:${HOST}:${await sha256HexOfText(local)}`,
    );
    await expect(imageSourceId({ kind: 'remote', href: remote }, CURRENT, HOST)).resolves.toBe(
      `remote:${await sha256HexOfText(remote)}`,
    );
  });

  it.each([CURRENT, PREVIOUS])(
    'keeps both builds in separate optimized entries when %s fills the cache first',
    async (first) => {
      const served = await serving();
      const second = first === CURRENT ? PREVIOUS : CURRENT;
      const expected =
        first === CURRENT ? [served.now, served.before] : [served.before, served.now];

      const filled = await served.get(first);
      const other = await served.get(second);
      const repeated = await served.get(first);

      expect(filled.response.status).toBe(200);
      expect(other.response.status).toBe(200);
      expect(other.response.headers.get('x-nextjs-cache')).toBe('MISS');
      expect(repeated.response.headers.get('x-nextjs-cache')).toBe('HIT');
      expect([filled.body, other.body, repeated.body]).toStrictEqual([
        expected[0],
        expected[1],
        expected[0],
      ]);
      expect(served.transform).toHaveBeenCalledTimes(2);
      expect(served.middleware).toHaveBeenCalledTimes(2);
    },
  );
});
