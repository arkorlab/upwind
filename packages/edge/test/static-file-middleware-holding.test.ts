import { sha256Hex } from '@stayingupwind/core/artifact';
import type { HeaderRule, ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

/**
 * How the edge has a shipped file held where the application's middleware ran for it and let the
 * request on (`cacheControlFor`, `heldAsTheFile`): a build-hashed file as itself by the visitor's
 * browser for its year, and anything else the middleware may have made one visitor's revalidated.
 */

const CHUNK = '/_next/static/chunks/main-0a1b2c3d.js';
const SCRIPT = 'console.log("main");';
/** A file the build did not mark immutable: its name stays the same from one build to the next. */
const ROBOTS = '/robots.txt';
const HELD_FOR_THE_YEAR = 'private, max-age=31536000, immutable';
const REVALIDATED = 'private, max-age=0, must-revalidate';
const CONTINUE = { 'x-middleware-next': '1' };

interface Holding {
  /** What the middleware answers the request with; absent, it lets it on and sets nothing. */
  readonly middleware?: Response;
  readonly headerRules?: readonly HeaderRule[];
  readonly privateDelivery?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A `GET` of `path`, of a deployment whose middleware covers every path, answered as it says. */
async function held(path: string, holding: Holding = {}): Promise<Response> {
  const site = await seedSite({
    document: pprDocument(),
    files: { [ROBOTS]: 'User-agent: *' },
    headerRules: holding.headerRules,
  });
  const bytes = encodeUtf8(SCRIPT);
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    staticFiles: {
      ...site.manifest.staticFiles,
      [CHUNK]: {
        sha256,
        byteLength: bytes.byteLength,
        contentType: 'text/javascript; charset=utf-8',
        immutable: true,
      },
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () =>
      Promise.resolve(holding.middleware ?? new Response(null, { headers: CONTINUE })),
  });
  const request = navigation(path, { headers: holding.headers ?? {} });
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
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
      },
      pointerMs: 0,
      privateDelivery: holding.privateDelivery ?? false,
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
  return response;
}

function continuing(headers: Readonly<Record<string, string>>): Response {
  return new Response(null, { headers: { ...CONTINUE, ...headers } });
}

describe('a build-hashed file the middleware let on', () => {
  it('is held by the visitor alone, for its year, and by no shared cache', async () => {
    const response = await held(CHUNK, {
      middleware: continuing({ 'cdn-cache-control': 'public, max-age=600', 'x-seen': '1' }),
    });

    await expect(response.text()).resolves.toBe(SCRIPT);
    expect({
      status: response.status,
      holding: response.headers.get('cache-control'),
      shared: response.headers.get('cdn-cache-control'),
      seen: response.headers.get('x-seen'),
      edge: response.headers.get(EDGE_DEBUG_HEADER),
    }).toStrictEqual({
      status: 200,
      holding: HELD_FOR_THE_YEAR,
      shared: null,
      seen: '1',
      edge: expect.stringMatching(/;mw=hit$/u) as unknown,
    });
  });

  it('is told so again where the browser asks whether what it holds still stands', async () => {
    const etag = `"${await sha256Hex(encodeUtf8(SCRIPT))}"`;
    const response = await held(CHUNK, { headers: { 'if-none-match': etag } });

    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toBe(HELD_FOR_THE_YEAR);
  });

  it('is held for its year where a rewrite keeps the request on the file itself', async () => {
    const response = await held(CHUNK, {
      middleware: new Response(null, {
        headers: { 'x-middleware-rewrite': `https://site.example${CHUNK}?v=1` },
      }),
    });

    await expect(response.text()).resolves.toBe(SCRIPT);
    expect(response.headers.get('cache-control')).toBe(HELD_FOR_THE_YEAR);
  });

  it.each([
    {
      label: 'a file the build did not mark immutable',
      path: ROBOTS,
      holding: {},
      status: 200,
    },
    {
      label: 'a cookie the middleware set beside it',
      path: CHUNK,
      holding: { middleware: continuing({ 'set-cookie': 'seen=1; Path=/' }) },
      status: 200,
    },
    {
      label: 'a rule the request selected by a condition',
      path: CHUNK,
      holding: {
        headerRules: [
          {
            sourceRegex: '^/_next/static/(.*)$',
            has: [{ type: 'header' as const, key: 'x-variant' }],
            headers: { 'x-rule': 'applied' },
            phase: 'beforeMiddleware' as const,
          },
        ],
        headers: { 'x-variant': 'b' },
      },
      status: 200,
    },
    {
      label: 'a rewrite that lands another path on the file',
      path: ROBOTS,
      holding: {
        middleware: new Response(null, {
          headers: { 'x-middleware-rewrite': `https://site.example${CHUNK}` },
        }),
      },
      status: 200,
    },
    {
      label: 'a status the middleware gave its rewrite',
      path: CHUNK,
      holding: {
        middleware: new Response(null, {
          status: 203,
          headers: { 'x-middleware-rewrite': `https://site.example${CHUNK}` },
        }),
      },
      status: 203,
    },
  ])('is revalidated at every use where it is not the file alone: $label', async (example) => {
    const response = await held(example.path, example.holding);

    await response.arrayBuffer();

    expect(response.status).toBe(example.status);
    expect(response.headers.get('cache-control')).toBe(REVALIDATED);
  });

  it('is held as the middleware said, where it wrote a Cache-Control itself', async () => {
    const response = await held(CHUNK, {
      middleware: continuing({ 'cache-control': 'public, max-age=60' }),
    });

    await response.arrayBuffer();

    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('is kept by nobody where delivery is private', async () => {
    const response = await held(CHUNK, { privateDelivery: true });

    await response.arrayBuffer();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
