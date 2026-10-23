import { FUNCTION_HEADER, MISDIRECTED_STATUS } from '@stayingupwind/core/paas';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchesOfFailure, fetchUpstream } from '../src/handlers/upstream.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { admittedAssetCacheKey } from '../src/strategies/asset-cache-api-readthrough.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const ASSET = 'https://site.example/_next/static/chunks/main-abc123.js';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CLIENTS: readonly { readonly label: string; readonly headers: Record<string, string> }[] = [
  { label: 'anonymous', headers: {} },
  { label: 'cookie', headers: { cookie: 'session=secret' } },
  { label: 'authorization', headers: { authorization: 'Bearer secret' } },
];

describe.each(['r2-mirror', 'cache-api-readthrough', 'passthrough'] as const)(
  'head assets under the %s policy',
  (backend) => {
    it.each(CLIENTS)(
      'dispatches one HEAD without an anonymous GET probe for $label',
      async (client) => {
        const site = await seedSite({ document: pprDocument() });
        const headers = new Headers(client.headers);
        const request = new Request<unknown, IncomingRequestCfProperties>(ASSET, {
          method: 'HEAD',
          headers,
        });
        const asked: Request[] = [];
        const runtime = standaloneRuntime(env, {
          memory: createEdgeMemory(() => Date.now()),
          dispatchApp: (_scriptName, dispatched) => {
            asked.push(dispatched);
            return Promise.resolve(
              new Response(null, {
                headers: {
                  'cache-control': CACHE_CONTROL,
                  'content-type': 'text/javascript',
                  'content-length': '42',
                  etag: '"asset-v1"',
                },
              }),
            );
          },
        });
        const ctx = createExecutionContext();
        const response = await serveFromPointer(
          {
            request,
            url: new URL(request.url),
            env,
            ctx,
            runtime,
            host: standaloneHost(env),
            pointer: site.pointer,
            pointerMs: 0,
            privateDelivery: false,
            cspReportingPath: undefined,
          },
          {
            manifestLookup: Promise.resolve({ kind: 'found', value: site.manifest }),
            policyLookup: Promise.resolve({
              kind: 'found',
              source: 'exact',
              policy: {
                ...DEFAULT_DELIVERY_POLICY,
                assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend },
              },
            }),
          },
        );
        await waitOnExecutionContext(ctx);

        expect(
          asked.map((sent) => {
            return {
              method: sent.method,
              cookie: sent.headers.get('cookie'),
              authorization: sent.headers.get('authorization'),
            };
          }),
        ).toStrictEqual([
          {
            method: 'HEAD',
            cookie: headers.get('cookie'),
            authorization: headers.get('authorization'),
          },
        ]);
        expect(response.body).toBeNull();
        expect(response.headers.get('x-arkor-edge')).toBe('passthrough;reason=head');
        // Passthroughs preserve browser caching and prohibit a shared cache's independent copy.
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(response.headers.get('content-length')).toBe('42');
        expect(response.headers.get('etag')).toBe('"asset-v1"');
      },
    );
  },
);

describe('asset dispatch failures', () => {
  it.each([undefined, { deploymentId: 'dpl_unbound', scriptName: 'unbound-app' }])(
    'counts no dispatch for an upstream refusal with app %j',
    async (app) => {
      const runtime = { ...standaloneRuntime(env), dispatchApp: undefined };
      let count: number | undefined;
      try {
        await fetchUpstream(runtime, app, new Request(ASSET));
      } catch (error) {
        count = dispatchesOfFailure(error);
      }

      expect(count).toBe(0);
    },
  );

  it.each([
    { kind: 'missing-dispatch', sent: 0 },
    { kind: 'failed', sent: 1 },
    { kind: 'non-error', sent: 1 },
    { kind: 'split-failed', sent: 2 },
  ])('counts requests actually sent when $kind', async (example) => {
    const site = await seedSite({ document: pprDocument() });
    const app = {
      ...site.pointer.app!,
      ...(example.kind === 'split-failed' && { functions: { 'app-2': 'site-app-2' } }),
    };
    const calls: string[] = [];
    const points: EdgeMetric[] = [];
    const base = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
    const host = standaloneHost(env);
    const request = new Request<unknown, IncomingRequestCfProperties>(ASSET);
    const ctx = createExecutionContext();
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        pointer: { ...site.pointer, app },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
        runtime: {
          ...base,
          dispatchApp:
            example.kind === 'missing-dispatch'
              ? undefined
              : (script) => {
                  calls.push(script);
                  if (example.kind === 'split-failed' && script === app.scriptName) {
                    return Promise.resolve(
                      new Response(null, {
                        status: MISDIRECTED_STATUS,
                        headers: { [FUNCTION_HEADER]: 'app-2' },
                      }),
                    );
                  }
                  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- A host may reject with any reason after sending the request.
                  return Promise.reject(
                    example.kind === 'non-error' ? 'source refused' : new Error('source failed'),
                  );
                },
        },
        host: {
          ...host,
          observer: {
            ...host.observer,
            metric: (point) => {
              points.push(point);
            },
          },
        },
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: site.manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: {
            ...DEFAULT_DELIVERY_POLICY,
            assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend: 'passthrough' },
          },
        }),
      },
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    expect(calls).toHaveLength(example.sent);
    expect(points.at(-1)?.kind).toBe('asset');
    expect(points.at(-1)?.subrequests).toBe(example.sent);

    await response.body?.cancel();
  });
});

/** A real asset route with only the Cache API's answer held by the test. */
async function assetWithLookup(
  lookup: Promise<Response | undefined>,
  projectId = 'site',
): Promise<Response> {
  vi.spyOn(caches, 'open').mockResolvedValue({
    match: () => lookup,
  } as unknown as Cache);
  const site = await seedSite({ document: pprDocument() });
  const request = new Request<unknown, IncomingRequestCfProperties>(ASSET);
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        dispatchApp: () => {
          return Promise.resolve(
            new Response('origin', {
              headers: { 'cache-control': 'no-store' },
            }),
          );
        },
      }),
      host: standaloneHost(env),
      pointer: { ...site.pointer, projectId },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: { ...site.manifest, projectId } }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: {
          ...DEFAULT_DELIVERY_POLICY,
          assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend: 'cache-api-readthrough' },
        },
      }),
    },
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe('asset cache lookup bodies', () => {
  afterEach(() => vi.restoreAllMocks());

  it('releases a hit that arrives after the origin has answered the timed-out lookup', async () => {
    const lookup = Promise.withResolvers<Response | undefined>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const response = await assetWithLookup(lookup.promise);

    await expect(response.text()).resolves.toBe('origin');

    lookup.resolve(new Response(body));
    await vi.waitFor(() => {
      expect(cancelled).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    });
  });

  it('handles a late cache miss after the response', async () => {
    const lookup = Promise.withResolvers<Response | undefined>();
    const response = await assetWithLookup(lookup.promise);

    await expect(response.text()).resolves.toBe('origin');

    lookup.resolve(undefined);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  it('handles a late cache failure after the response', async () => {
    const lookup = Promise.withResolvers<Response | undefined>();
    const response = await assetWithLookup(lookup.promise);

    await expect(response.text()).resolves.toBe('origin');

    lookup.reject(new Error('late cache failure'));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  it('hands a timely hit to the client without releasing its body', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const response = await assetWithLookup(
      Promise.resolve(
        new Response(body, {
          headers: { 'cache-control': CACHE_CONTROL, 'content-type': 'text/javascript' },
        }),
      ),
    );

    expect(response.headers.get('x-arkor-edge')).toContain('hit=1');
    expect(cancelled).not.toHaveBeenCalled();

    await response.body?.cancel();
  });
});

describe('asset project identity', () => {
  const identifiers = [
    '.',
    '..',
    '%2E',
    '%2e',
    '%2E_',
    '._',
    '.._',
    '../',
    '.\\',
    '.%2e',
    '%2e.',
    '%2E%2E',
    '%',
    '~',
    'project',
    'a/b',
    'a%2Fb',
  ];

  it('keeps dot segments distinct through Request and the real Cache API', async () => {
    const origin = new URL(`https://site.example/_next/static/${crypto.randomUUID()}.js?dpl=one`);
    const cache = await caches.open('asset-project-identity');
    const keys = identifiers.map(
      (id) => new Request(admittedAssetCacheKey(origin, 'site.example', id)),
    );

    expect(new Set(keys.map((key) => key.url)).size).toBe(identifiers.length);

    for (const [index, key] of keys.entries()) {
      await cache.put(
        key,
        new Response(String(index), { headers: { 'cache-control': CACHE_CONTROL } }),
      );
    }
    for (const [index, key] of keys.entries()) {
      const hit = await cache.match(key);

      await expect(hit?.text()).resolves.toBe(String(index));
      expect(new URL(key.url).search).toBe('?dpl=one');
    }
  });

  it('keeps all UTF-16 identifiers distinct without changing ordinary keys', async () => {
    const origin = new URL(ASSET);
    const ids = ['\u{D800}', '\u{DC00}', String.raw`\ud800`, '%7E%5Cud800', '\u{FFFD}', '😀'];
    const keys = ids.map((id) => new Request(admittedAssetCacheKey(origin, 'site.example', id)));
    const cache = await caches.open('asset-project-unicode');

    expect(new Set(keys.map((key) => key.url)).size).toBe(ids.length);

    for (const [index, key] of keys.entries()) {
      await cache.put(
        key,
        new Response(String(index), { headers: { 'cache-control': CACHE_CONTROL } }),
      );
    }
    for (const [index, key] of keys.entries()) {
      await expect((await cache.match(key))?.text()).resolves.toBe(String(index));
    }

    expect(admittedAssetCacheKey(origin, 'site.example', 'project-a_1.~')).toBe(
      'https://site.example/project-a_1.~/site.example/_next/static/chunks/main-abc123.js',
    );
  });
});

describe('asset project diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { projectId: 'site:one+two ._~', encoded: 'site:one+two ._~' },
    { projectId: 'site;policy=forged', encoded: 'site%3Bpolicy=forged' },
    { projectId: 'site%3Bpolicy=forged', encoded: 'site%253Bpolicy=forged' },
    { projectId: 'line\rbreak', encoded: 'line%5Crbreak' },
    { projectId: 'line\nbreak', encoded: 'line%5Cnbreak' },
    { projectId: 'nul\0byte', encoded: 'nul%5Cu0000byte' },
    { projectId: 'tab\tbyte', encoded: 'tab%5Ctbyte' },
    { projectId: 'caf\u{E9}', encoded: 'caf%C3%A9' },
    { projectId: '😀', encoded: '%F0%9F%98%80' },
    { projectId: '\u{D800}', encoded: '%5Cud800' },
    { projectId: '\u{DC00}', encoded: '%5Cudc00' },
    { projectId: '%5Cud800', encoded: '%255Cud800' },
    { projectId: String.raw`\ud800`, encoded: String.raw`\ud800` },
  ])('serves a cached asset with header-safe project $encoded', async ({ projectId, encoded }) => {
    const response = await assetWithLookup(
      Promise.resolve(
        new Response('cached asset', {
          headers: { 'cache-control': CACHE_CONTROL, 'content-type': 'text/javascript' },
        }),
      ),
      projectId,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-arkor-edge')).toBe(
      `asset;strategy=cache-api-readthrough;hit=1;project=${encoded};policy=${DEFAULT_DELIVERY_POLICY.id}`,
    );
    await expect(response.text()).resolves.toBe('cached asset');
  });
});
