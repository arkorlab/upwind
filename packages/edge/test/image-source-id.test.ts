import { sha256Hex, sha256HexOfText } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import {
  appRuntimeSchema,
  type MiddlewareMatcher,
  type ProjectManifest,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { IP_COUNTRY_HEADER } from '@stayingupwind/core/paas';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { DispatchApp } from '../src/edge-runtime.ts';
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
async function serving(matchers: readonly MiddlewareMatcher[] = [{ sourceRegex: '^/gated/' }]) {
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
    middleware: { matchers: [...matchers] },
    staticFiles: {
      [path]: { ...own, deploymentId: CURRENT, previous: { ...kept, deploymentId: PREVIOUS } },
    },
  };
  const middleware = vi.fn<DispatchApp>(() =>
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
  const get = async (dpl: string, country?: string) => {
    const query = new URLSearchParams({ url: path, w: '64', q: '75', dpl });
    const request = new Request<unknown, IncomingRequestCfProperties>(
      `https://${HOST}/_next/image?${query.toString()}`,
      {
        headers: {
          accept: 'image/webp',
          'sec-fetch-dest': 'image',
          'cf-connecting-ip': '203.0.113.7',
          'x-visitor-data': 'private',
        },
      },
    );
    if (country !== undefined) {
      Object.defineProperty(request, 'cf', { value: { country } });
    }
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
  it('keeps source middleware anonymous before sharing its result between countries', async () => {
    const served = await serving();
    const anonymous = png('anonymous');
    served.middleware.mockImplementation((_script, request) => {
      const bytes = png(request.headers.get(IP_COUNTRY_HEADER) ?? 'anonymous');
      return Promise.resolve(
        new Response(bytes, {
          headers: { 'content-type': 'image/png' },
        }),
      );
    });

    const first = await served.get(CURRENT, 'JP');
    const second = await served.get(CURRENT, 'US');

    expect(first.body).toStrictEqual(anonymous);
    expect(second.body).toStrictEqual(anonymous);
    expect(second.response.headers.get('x-nextjs-cache')).toBe('HIT');
    expect(served.middleware).toHaveBeenCalledTimes(1);
    expect(served.transform).toHaveBeenCalledTimes(1);

    const source = served.middleware.mock.calls[0]?.[1];

    const forwarding = ['x-forwarded-host', 'x-forwarded-proto', 'via'];

    expect(forwarding.map((name) => source?.headers.get(name))).toStrictEqual([
      HOST,
      'https',
      '1.1 arkor-edge',
    ]);

    for (const name of [
      'cf-connecting-ip',
      IP_COUNTRY_HEADER,
      'x-forwarded-for',
      'x-visitor-data',
    ]) {
      expect(source?.headers.has(name)).toBe(false);
    }
  });

  it.each(['has', 'missing'] as const)(
    'judges a source matcher with a %s country condition as an anonymous source',
    async (condition) => {
      const served = await serving([
        {
          sourceRegex: '^/gated/',
          [condition]: [{ type: 'header', key: IP_COUNTRY_HEADER, value: 'JP' }],
        },
      ]);
      const response = await served.get(CURRENT, 'JP');

      expect(response.response.status).toBe(200);
      expect(response.body).toStrictEqual(served.now);
      expect(served.middleware).toHaveBeenCalledTimes(condition === 'missing' ? 1 : 0);
    },
  );

  it.each([
    { first: 'a/../local:b', second: 'b' },
    { first: String.raw`a\..\local:b`, second: 'b' },
    { first: 'depl\noyment', second: 'deployment' },
    { first: 'depl\royment', second: 'deployment' },
  ])(
    'keeps deployment IDs $first and $second apart in the actual URL cache',
    async ({ first, second }) => {
      const source: ImageSource = { kind: 'local', href: '/dynamic.png' };
      const host = `${crypto.randomUUID()}.example`;
      const key = async (deploymentId: string): Promise<Request> => {
        expect(appRuntimeSchema.validate({ deploymentId, scriptName: 'site-app' })).toBe(true);

        return new Request(
          `https://images.test.invalid/${await imageSourceId(source, deploymentId, host)}/64/75/image/webp`,
        );
      };
      const [one, two] = await Promise.all([key(first), key(second)]);
      const cache = await caches.open('image-source-url-identity');
      await cache.put(
        one,
        new Response('first image', { headers: { 'cache-control': 'max-age=60' } }),
      );

      expect(one.url).not.toBe(two.url);
      await expect(cache.match(two)).resolves.toBeUndefined();
      await expect((await cache.match(one))?.text()).resolves.toBe('first image');
    },
  );

  it('keeps literal escapes and distinct UTF-16 strings apart without refusing a valid ID', async () => {
    const source: ImageSource = { kind: 'local', href: '/dynamic.png' };
    const deployments = ['a/b', 'a%2Fb', '\u{D800}', '\u{D801}', String.raw`\ud800`, '\u{FFFD}'];
    const ids = await Promise.all(deployments.map((id) => imageSourceId(source, id, HOST)));
    const urls = ids.map((id) => new Request(`https://images.test.invalid/${id}`).url);

    expect(new Set(urls).size).toBe(deployments.length);
  });

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
