import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest, ReservedRoute, StaticFileEntry } from '@stayingupwind/core/manifest';
import {
  decodeLocaleRequest,
  LOCALE_REQUEST_HEADER,
  MIDDLEWARE_DONE_HEADER,
} from '@stayingupwind/core/paas';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

/**
 * A shipped source the middleware let on, as it left it (greptile): a rule ahead of the filesystem
 * that claims the path it rewrote the source to, or the request whose headers it changed, makes the
 * Worker's answer the source, as Next.js's router runs its `beforeFiles` rewrites after the
 * middleware; a rule that claims neither leaves the file shipped there to answer.
 */

const HOST = 'site.example';
const DPL = 'dpl_site';
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

/** A PNG signature and a payload of its own, which the test transformer passes through. */
function png(text: string): Uint8Array {
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8(text),
  ]);
}

async function store(bytes: Uint8Array): Promise<StaticFileEntry> {
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  return {
    sha256,
    byteLength: bytes.byteLength,
    contentType: 'image/png',
    immutable: false,
    deploymentId: DPL,
  };
}

function escaped(pathname: string): string {
  return pathname.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

interface Case {
  readonly i18nRoot?: boolean;
  /** What the source's middleware answers, given the source's path and the file it may rewrite to. */
  readonly middleware: (paths: { readonly source: string; readonly target: string }) => Response;
  /** The rules ahead of the filesystem, given the same paths. */
  readonly reserved: (paths: {
    readonly source: string;
    readonly target: string;
  }) => readonly ReservedRoute[];
}

/** An optimizer request for a shipped source its middleware covers, and what was asked of whom. */
async function optimized(example: Case) {
  const source = example.i18nRoot === true ? '/index' : `/gated/${crypto.randomUUID()}.png`;
  const target = `/gated/${crypto.randomUUID()}.png`;
  const paths = { source, target };
  const stored = { source: png(`stored at ${source}`), target: png(`stored at ${target}`) };
  const fromWorker = png('the Worker answered');
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const [own, other] = await Promise.all([store(stored.source), store(stored.target)]);
  const manifest: ProjectManifest = {
    ...site.manifest,
    deployment: { ...site.manifest.deployment, dplId: DPL },
    middleware: {
      matchers: [{ sourceRegex: example.i18nRoot === true ? '^/index$' : '^/gated/' }],
    },
    ...(example.i18nRoot === true && { spelledPrefix: { basePath: '', locales: ['en', 'fr'] } }),
    staticFiles: { [source]: own, [target]: other },
    reservedRoutes: [...example.reserved(paths)],
  };
  const asked: { readonly script: string; readonly request: Request }[] = [];
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (script, request) => {
      asked.push({ script, request });
      return Promise.resolve(
        script === 'site-middleware'
          ? example.middleware(paths)
          : new Response(fromWorker, { headers: { 'content-type': 'image/png' } }),
      );
    },
    transformImage: async (body) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
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
  const query = new URLSearchParams({ url: source, w: '64', q: '75', dpl: DPL });
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
      pointer: {
        ...site.pointer,
        app: { deploymentId: DPL, scriptName: 'site-app', middlewareScriptName: 'site-middleware' },
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
  const body = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  const worker = asked.filter((one) => one.script === 'site-app').map((one) => one.request);
  return { response, body, stored, fromWorker, paths, worker };
}

function rewritingTo(paths: { readonly target: string }): Response {
  return new Response(null, {
    headers: { 'x-middleware-rewrite': `https://${HOST}${paths.target}` },
  });
}

function variant(value: string): () => Response {
  return () => {
    return new Response(null, {
      headers: {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-variant',
        'x-middleware-request-x-variant': value,
      },
    });
  };
}

/** A rule ahead of the filesystem that claims `pathname`. */
function claiming(pathname: string): readonly ReservedRoute[] {
  return [{ sourceRegex: `^${escaped(pathname)}$`, beforeFiles: true }];
}

/** Claims the source's path for a request carrying `x-variant: b`, before the filesystem. */
function claimedForVariant(paths: { readonly source: string }): readonly ReservedRoute[] {
  return [
    {
      sourceRegex: `^${escaped(paths.source)}$`,
      beforeFiles: true,
      has: [{ type: 'header', key: 'x-variant', value: 'b' }],
    },
  ];
}

describe('a shipped image source the middleware changed', () => {
  it('keeps the anonymous root locale inputs when source middleware adds locale headers', async () => {
    const result = await optimized({
      i18nRoot: true,
      middleware: (paths) => {
        return new Response(null, {
          headers: {
            'x-middleware-rewrite': `https://${HOST}${paths.target}`,
            'x-middleware-override-headers': 'accept-language,cookie',
            'x-middleware-request-accept-language': 'fr',
            'x-middleware-request-cookie': 'NEXT_LOCALE=fr',
          },
        });
      },
      reserved: (paths) => claiming(paths.target),
    });

    expect(result.response.status).toBe(200);
    expect(result.worker).toHaveLength(1);
    expect(result.worker[0]?.headers.get('accept-language')).toBe('fr');
    expect(result.worker[0]?.headers.get('cookie')).toBe('NEXT_LOCALE=fr');
    expect(
      decodeLocaleRequest(result.worker[0]?.headers.get(LOCALE_REQUEST_HEADER) ?? ''),
    ).toStrictEqual({ language: null, cookie: null });
  });

  it('asks the Worker for a path it rewrote the source to that a rule claims', async () => {
    const result = await optimized({
      middleware: rewritingTo,
      reserved: (paths) => claiming(paths.target),
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(new URL(result.worker[0]?.url ?? '').pathname).toBe(result.paths.target);
    expect(result.worker[0]?.headers.get(MIDDLEWARE_DONE_HEADER)).toBe('1');
  });

  it('reads the file a rewrite lands on where no rule claims it', async () => {
    const result = await optimized({
      middleware: rewritingTo,
      reserved: (paths) => claiming(`${paths.source}-elsewhere`),
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.stored.target);
    expect(result.worker).toStrictEqual([]);
  });

  it('asks the Worker for a source whose headers it changed into a request a rule claims', async () => {
    const result = await optimized({ middleware: variant('b'), reserved: claimedForVariant });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.fromWorker);
    expect(result.worker).toHaveLength(1);
    expect(new URL(result.worker[0]?.url ?? '').pathname).toBe(result.paths.source);
    expect(result.worker[0]?.headers.get('x-variant')).toBe('b');
    expect(result.worker[0]?.headers.get(MIDDLEWARE_DONE_HEADER)).toBe('1');
  });

  it('reads the file where the headers it changed leave the request unclaimed', async () => {
    const result = await optimized({ middleware: variant('a'), reserved: claimedForVariant });

    expect(result.response.status).toBe(200);
    expect(result.body).toStrictEqual(result.stored.source);
    expect(result.worker).toStrictEqual([]);
  });
});
