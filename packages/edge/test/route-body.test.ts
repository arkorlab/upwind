import { sha256Hex } from '@stayingupwind/core/artifact';
import type { Prerender } from '@stayingupwind/core/bundle';
import {
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
} from '@stayingupwind/core/cache';
import {
  buildProjectManifest,
  type HeaderRule,
  type ProjectManifest,
} from '@stayingupwind/core/manifest';
import {
  FUNCTION_HEADER,
  HEADER_RULES_JUDGED_HEADER,
  HEADER_RULES_LEFT_HEADER,
  MISDIRECTED_STATUS,
} from '@stayingupwind/core/paas';
import { seedRouteFor } from '@stayingupwind/host/bundle';
import type { HostCredentials } from '@stayingupwind/host/credentials';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Exercise the host's existing real seed fixture, without a production test export. */
import { shellBundle } from '../../host/test/shared-shell-fixture.ts';
import { triggerDetached } from '../src/cache/regenerate.ts';
import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { routeHostedBody } from '../src/handlers/route-body.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { type PointerReads, serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const NOW = 1_800_000_000_000;
const SCOPE = 'dpl_icon';
const BODY = new Uint8Array([137, 80, 78, 71, 0, 255, 128, 10]);
const REPLACEMENT = new Uint8Array([137, 80, 78, 71, 1, 254, 127, 10]);
const MIDDLEWARE_TOOK_MS = 240;
const BUILD_PROTOCOL = [
  'host',
  'x-matched-path',
  'x-prerender-revalidate',
  'x-prerender-revalidate-if-generated',
  'x-next-revalidated-tags',
  'x-next-revalidate-tag-token',
];
const BODY_CONTROLS = [
  ...BUILD_PROTOCOL.filter((name) => name !== 'host'),
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-action',
  'next-url',
];

/** Use the host's real app-route seed contract, including its route-body output and policy. */
async function fixture(
  options: {
    readonly initialHeaders?: Record<string, string>;
    readonly privateDelivery?: boolean;
    readonly validated?: boolean;
    readonly middlewareHeaders?: Record<string, string>;
    readonly middlewareMs?: number;
    readonly headerRules?: HeaderRule[];
    readonly holdMs?: number;
    readonly publishOnRegeneration?: boolean;
    readonly authorizeByHeader?: boolean;
    readonly credentials?: HostCredentials;
    readonly deferHeaderRules?: boolean;
    readonly split?: boolean;
    readonly withoutDispatcher?: boolean;
    readonly allowHeader?: string[];
  } = {},
) {
  const sha256 = await sha256Hex(BODY);
  const prerender: Prerender = {
    id: 'icon',
    route: '/icon',
    pathname: '/icon',
    parentOutputId: 'icon',
    groupId: 1,
    routeType: 'route',
    response: 'complete',
    compute: 'static',
    renderingMode: 'STATIC',
    body: { sha256, byteLength: BODY.byteLength, contentType: 'image/png' },
    initialStatus: 200,
    initialHeaders: { 'content-type': 'image/png', ...options.initialHeaders },
    initialRevalidate: 1,
    initialExpiration: 2,
    ...(options.allowHeader !== undefined && { allowHeader: options.allowHeader }),
  };
  const bundle = { ...shellBundle(prerender, 'app-route'), routeBodyPrivacy: 2 as const };
  const seed = await seedRouteFor(bundle, prerender, { scopeId: SCOPE, generatedAt: NOW });
  if (seed === undefined) throw new Error('route fixture must be seeded');
  const { entryId } = await deriveEntry(SCOPE, seed.input.descriptor);
  const generation = seed.input.generation;
  const packed = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: generation.generationId,
      seq: 1,
      revision: 1,
      source: 'build',
      kind: 'app-route',
      route: '/icon',
      pathname: '/icon',
      cacheTimestamp: generation.cacheTimestamp,
      producedAt: generation.producedAt,
      policy: generation.policy,
      status: generation.status,
      headers: generation.headers,
      tags: generation.tags,
      htmlSha256: sha256,
      htmlLength: BODY.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: generation.outputs.flatMap((output) => {
        return output.artifacts.map((artifact) => {
          return {
            ...artifact,
            artifactId: 'artifact_icon',
            representationKey: output.representationKey,
          };
        });
      }),
    },
    BODY,
    undefined,
  );
  const decoded = decodeGenerationPack(packed);
  if (decoded.kind !== 'ok') throw new Error('seed pack must decode');
  const tag = decoded.pack.header.tags[0]?.value;
  if (tag === undefined) throw new Error('real route seeds must have an implicit tag');
  const clock = { now: NOW };
  const memory = createEdgeMemory(() => clock.now);
  const key = kvGenerationKey(SCOPE, entryId);
  memory.generations.set(
    key,
    { pack: decoded.pack, readAt: NOW, bytes: packed.byteLength },
    packed.byteLength,
  );
  await env.CACHE_STATE.put(key, packed);
  const hasMiddleware =
    options.middlewareHeaders !== undefined || options.authorizeByHeader === true;
  const dispatch = vi.fn().mockImplementation(async (script: string, request: Request) => {
    if (script === 'icon-middleware') {
      clock.now += options.middlewareMs ?? 0;
      if (options.authorizeByHeader === true && request.headers.get('x-allow') !== 'yes') {
        return new Response('Not allowed', {
          status: 403,
          headers: { 'cache-control': 'private, no-store' },
        });
      }
      return new Response(null, {
        headers: { 'x-middleware-next': '1', ...options.middlewareHeaders },
      });
    }
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 202,
        headers: { 'x-custom-head': 'explicit', 'cache-control': 'private, no-store' },
      });
    }
    if (options.publishOnRegeneration === true) {
      const digest = await sha256Hex(REPLACEMENT);
      const next = encodeGenerationPack(
        {
          ...decoded.pack.header,
          generationId: 'gen_regenerated',
          seq: 2,
          revision: 2,
          source: 'runtime',
          cacheTimestamp: clock.now,
          producedAt: clock.now,
          htmlSha256: digest,
          htmlLength: REPLACEMENT.byteLength,
          artifacts: decoded.pack.header.artifacts.map((artifact) => {
            return {
              ...artifact,
              sha256: digest,
              byteLength: REPLACEMENT.byteLength,
            };
          }),
        },
        REPLACEMENT,
        undefined,
      );
      await env.CACHE_STATE.put(key, next);
    }
    return new Response(REPLACEMENT, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=99999',
        ...(options.deferHeaderRules === true &&
          request.headers.get(HEADER_RULES_JUDGED_HEADER) === '1' && {
            [HEADER_RULES_LEFT_HEADER]: '1',
          }),
      },
    });
  });
  const tasks: Promise<unknown>[] = [];
  const points: EdgeMetric[] = [];
  const host = standaloneHost(env);
  const ctx = createExecutionContext();
  vi.spyOn(ctx, 'waitUntil').mockImplementation((task) => {
    tasks.push(task);
  });
  const edge: EdgeContext = {
    env,
    ctx,
    runtime: {
      ...standaloneRuntime(env, { now: () => clock.now, memory, dispatchApp: dispatch }),
      ...(options.withoutDispatcher === true && { dispatchApp: undefined }),
    },
    host: {
      ...host,
      credentials: options.credentials ?? host.credentials,
      observer: {
        ...host.observer,
        metric: (point) => {
          points.push(point);
        },
      },
    },
    forwarding: { previewDomain: 'invalid', previewHost: 'site.example', clientIp: undefined },
    app: {
      deploymentId: SCOPE,
      scriptName: 'icon-app',
      ...(options.split === true && {
        functions: { 'app-2': 'icon-app-2', 'app-3': 'icon-app-3' },
      }),
      ...(hasMiddleware && { middlewareScriptName: 'icon-middleware' }),
    },
    originalUrl: undefined,
    policy: {
      ...DEFAULT_DELIVERY_POLICY,
      runtimeCache: {
        ...DEFAULT_RUNTIME_CACHE_SETTINGS,
        generations: 'on',
        holdMs: options.holdMs ?? 60_000,
        cacheApiMaxAgeMs: 0,
      },
    },
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'a'.repeat(64),
    colo: undefined,
    validated: options.validated ?? false,
    demotedRoutes: undefined,
    privateDelivery: options.privateDelivery ?? false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
  };
  const entry = {
    pathname: '/icon',
    route: '/icon',
    entryId,
    ...(options.split === true && { function: 'app-2' }),
  };
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run_icon',
    generatedAt: '2026-10-18T00:00:00.000Z',
    originHost: 'site.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: '2026-10-18T00:00:00.000Z' },
    routes: [],
    dynamicRoutes: [],
    app: edge.app!,
    cache: { keySchemaVersion: 1, scopeId: SCOPE },
    routeBodies: [entry],
    ...(options.headerRules !== undefined && { headerRules: options.headerRules }),
    ...(hasMiddleware && {
      middleware: { matchers: [{ sourceRegex: '^/icon$' }] },
    }),
  });
  const fallback = vi.fn().mockResolvedValue(
    new Response('Function', {
      headers: { 'cache-control': 'private, no-store' },
    }),
  );
  function serve(init: RequestInit = {}) {
    const request = new Request('https://site.example/icon', init);
    return routeHostedBody({
      request,
      url: new URL(request.url),
      edge,
      manifest,
      entry,
      classifiedHeaders: request.headers,
      passthrough: fallback,
    });
  }
  return {
    serve,
    edge,
    manifest,
    entry,
    fallback,
    dispatch,
    clock,
    key,
    pack: decoded.pack,
    record: packed,
    tasks,
    points,
    tag,
    drain: async () => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

/** Read response metadata from a digest-valid runtime record, without inheriting its build type. */
async function runtimeBodyType(
  test: Awaited<ReturnType<typeof fixture>>,
  contentType: string,
  headers: Record<string, string> = {},
) {
  const record = encodeGenerationPack(
    {
      ...test.pack.header,
      generationId: 'gen_runtime_body_type',
      seq: 2,
      revision: 2,
      source: 'runtime',
      headers,
      artifacts: test.pack.header.artifacts.map((artifact) => {
        return artifact.role === 'route-body' && artifact.representationKey === 'route-body'
          ? { ...artifact, contentType }
          : artifact;
      }),
    },
    BODY,
    undefined,
  );

  test.edge.runtime.memory.generations.delete(test.key);

  await env.CACHE_STATE.put(test.key, record);
}

const VARY_LAYERS = ['record', 'configured', 'middleware'] as const;
type VaryLayer = (typeof VARY_LAYERS)[number];

function varyCases(values: readonly string[]) {
  return VARY_LAYERS.flatMap((layer) => values.map((vary) => ({ layer, vary })));
}

const VARY_FIXTURES = {
  record: async (vary: string) => {
    const test = await fixture();
    await runtimeBodyType(test, 'image/png', { vary });
    return test;
  },
  configured: (vary: string) => {
    return fixture({
      headerRules: [{ sourceRegex: '^/icon$', headers: { vary } }],
    });
  },
  middleware: (vary: string) => fixture({ middlewareHeaders: { vary } }),
};

/** Place variation on the selected runtime record or on the layer that actually supplies it. */
function varyFixture(layer: VaryLayer, vary: string) {
  return VARY_FIXTURES[layer](vary);
}

/** Exercise the dispatcher too: a non-document request must never enter HTML composition. */
function routed(
  test: Awaited<ReturnType<typeof fixture>>,
  manifest = test.manifest,
  headers: HeadersInit = {},
  options: { readonly method?: string; readonly reads?: Partial<PointerReads> } = {},
) {
  const request = new Request<unknown, IncomingRequestCfProperties>('https://site.example/icon', {
    headers,
    method: options.method ?? 'GET',
  });
  return serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx: test.edge.ctx,
      runtime: test.edge.runtime,
      host: test.edge.host,
      pointer: {
        v: 1,
        projectId: 'site',
        originHost: 'site.example',
        mode: 'edge',
        manifestId: test.edge.manifestId,
        policyId: test.edge.policy.id,
        app: manifest.app,
        updatedAt: '2026-10-18T00:00:00.000Z',
      },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: test.edge.policy }),
      ...options.reads,
    },
  );
}

describe('the host serves complete route-body generations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves a body with only the fixed Next build protocol inputs without another request', async () => {
    const test = await fixture({ allowHeader: BUILD_PROTOCOL });
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve({ headers: { host: 'site.example' } });

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(get).not.toHaveBeenCalled();
    expect(test.fallback).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each(BODY_CONTROLS)(
    'rejects even an empty original body control before reading a record: %s',
    async (name) => {
      const test = await fixture();
      const get = vi.spyOn(env.CACHE_STATE, 'get');
      const memory = vi.spyOn(test.edge.runtime.memory.generations, 'get');
      const response = await test.serve({ headers: { [name.toUpperCase()]: '' } });

      await expect(response.text()).resolves.toBe('Function');
      expect(get).not.toHaveBeenCalled();
      expect(memory).not.toHaveBeenCalled();
      expect(test.fallback).toHaveBeenCalledTimes(1);
      expect(test.dispatch).not.toHaveBeenCalled();
    },
  );

  it('retains a classified-only control veto', async () => {
    const test = await fixture();
    const request = new Request('https://site.example/icon');
    const memory = vi.spyOn(test.edge.runtime.memory.generations, 'get');
    const response = await routeHostedBody({
      request,
      url: new URL(request.url),
      edge: test.edge,
      manifest: test.manifest,
      entry: test.entry,
      classifiedHeaders: new Headers({ 'x-next-revalidated-tags': '' }),
      passthrough: test.fallback,
    });

    await expect(response.text()).resolves.toBe('Function');
    expect(memory).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each(['x-matched-path', 'x-next-revalidated-tags', 'x-next-revalidate-tag-token'])(
    'keeps original control evidence when classification strips a host credential: %s',
    async (name) => {
      const test = await fixture({
        credentials: { cookies: [], headers: [name, 'authorization'] },
      });
      const get = vi.spyOn(env.CACHE_STATE, 'get');
      const memory = vi.spyOn(test.edge.runtime.memory.generations, 'get');
      const response = await routed(test, test.manifest, { [name]: 'control' });

      expect(response.headers.get('cache-control')).toContain('private');
      expect(get).not.toHaveBeenCalled();
      expect(memory).not.toHaveBeenCalled();
      expect(test.dispatch).toHaveBeenCalledTimes(1);

      await test.drain();
    },
  );

  it.each(['x-matched-path', 'x-next-revalidated-tags', 'x-next-revalidate-tag-token'])(
    'keeps a middleware control veto before credential forwarding removes it: %s',
    async (name) => {
      const test = await fixture({
        credentials: { cookies: [], headers: [name] },
        middlewareHeaders: {
          'x-middleware-override-headers': name,
          [`x-middleware-request-${name}`]: 'control',
        },
      });
      const get = vi.spyOn(env.CACHE_STATE, 'get');
      const memory = vi.spyOn(test.edge.runtime.memory.generations, 'get');
      const response = await test.serve();

      await expect(response.text()).resolves.toBe('Function');
      expect(get).not.toHaveBeenCalled();
      expect(memory).not.toHaveBeenCalled();
      expect(test.fallback).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a middleware RSC segment request before reading the image record', async () => {
    const test = await fixture({
      middlewareHeaders: {
        'x-middleware-override-headers': 'rsc,next-router-segment-prefetch',
        'x-middleware-request-rsc': '1',
        'x-middleware-request-next-router-segment-prefetch': '/segment',
      },
    });
    const memory = vi.spyOn(test.edge.runtime.memory.generations, 'get');
    const response = await test.serve();

    await expect(response.text()).resolves.toBe('Function');
    expect(memory).not.toHaveBeenCalled();
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves binary bytes and shares only the trusted seeded body', async () => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve();

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('content-length')).toBe(String(BODY.byteLength));
    expect(get).not.toHaveBeenCalled();
    expect(test.fallback).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('leaves HEAD to the Function without reading or regenerating a GET generation', async () => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await test.serve({ method: 'HEAD' });

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('preserves an explicit HEAD handler through the real dispatcher without a generation read', async () => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await routed(test, test.manifest, {}, { method: 'HEAD' });

    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-custom-head')).toBe('explicit');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();

    await test.drain();
  });

  it('answers a custom HEAD without waiting for an unresolved delivery policy', async () => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');
    const policy = Promise.withResolvers<Awaited<PointerReads['policyLookup']>>();
    const pending = routed(
      test,
      test.manifest,
      {},
      {
        method: 'HEAD',
        reads: { policyLookup: policy.promise },
      },
    );
    try {
      const response = await Promise.race([
        pending,
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('policy pending');
          }, 100);
        }),
      ]);

      expect(response).toHaveProperty('status', 202);
      expect(get).not.toHaveBeenCalled();
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      policy.resolve({ kind: 'found', source: 'exact', policy: test.edge.policy });
      await pending;

      await test.drain();
    }
  });

  it('preserves original conditioned header rules after middleware changes request headers', async () => {
    const test = await fixture({
      deferHeaderRules: true,
      headerRules: [
        {
          sourceRegex: '^/icon$',
          has: [{ type: 'header', key: 'x-before', value: 'matched' }],
          headers: { 'x-original-rule': 'retained' },
        },
      ],
      middlewareHeaders: {
        'x-middleware-override-headers': 'user-agent',
        'x-middleware-request-user-agent': 'sanitized',
      },
    });
    const response = await routed(test, test.manifest, { 'x-before': 'matched' });

    expect(response.headers.get('x-original-rule')).toBe('retained');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(test.dispatch).toHaveBeenCalledTimes(2);

    await test.drain();
  });

  it('preserves original header rules during foreground body regeneration after middleware', async () => {
    const test = await fixture({
      deferHeaderRules: true,
      headerRules: [{ sourceRegex: '^/icon$', headers: { 'x-original-rule': 'retained' } }],
      middlewareHeaders: {},
      middlewareMs: MIDDLEWARE_TOOK_MS,
    });

    test.clock.now += 3000;

    const response = await routed(test);

    expect(response.headers.get('x-original-rule')).toBe('retained');
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(test.dispatch).toHaveBeenCalledTimes(2);

    await test.drain();

    expect(test.points.map((point) => point.middlewareMs)).toStrictEqual([MIDDLEWARE_TOOK_MS]);
  });

  it.each([
    { cookie: '__Host-host_access=host-only', shared: true },
    { cookie: '__Host-host_access=host-only; theme=dark', shared: false },
  ])(
    'tests route-body privacy on application-visible cookies: $cookie',
    async ({ cookie, shared }) => {
      const test = await fixture({
        credentials: { cookies: ['__Host-host_access'], headers: [] },
      });
      const response = await routed(test, test.manifest, { cookie });

      expect(response.headers.get('cache-control')?.startsWith('public')).toBe(shared);
      expect(test.dispatch).toHaveBeenCalledTimes(shared ? 0 : 1);

      await test.drain();
    },
  );

  it.each([false, true])(
    'serves a shipped file rewritten from a body only outside reserved routes: $0',
    async (reserved) => {
      const path = '/_next/static/media/large.png';
      const bytes = new Uint8Array(128 * 1024).fill(97);
      const digest = await sha256Hex(bytes);
      await env.ARTIFACTS.put(blobObjectKey(digest), bytes);
      const test = await fixture({
        middlewareHeaders: { 'x-middleware-rewrite': `https://site.example${path}` },
      });
      const manifest: ProjectManifest = {
        ...test.manifest,
        staticFiles: {
          [path]: {
            sha256: digest,
            byteLength: bytes.byteLength,
            contentType: 'image/png',
            immutable: true,
          },
        },
        ...(reserved && {
          reservedRoutes: [
            { sourceRegex: String.raw`^/_next/static/media/large\.png$`, beforeFiles: true },
          ],
        }),
      };
      const response = await routed(test, manifest);
      const expected = reserved ? REPLACEMENT : bytes;
      const actual = new Uint8Array(await response.arrayBuffer());

      expect(actual.byteLength).toBe(expected.byteLength);
      await expect(sha256Hex(actual)).resolves.toBe(await sha256Hex(expected));
      expect(test.dispatch).toHaveBeenCalledTimes(reserved ? 2 : 1);
      expect(response.headers.get('cache-control')).toContain('private');

      await test.drain();
    },
  );

  it.each(
    ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control'].flatMap((header) =>
      ['record', 'configured', 'middleware'].map((layer) => ({ header, layer })),
    ),
  )(
    'retains a CDN no-transform prohibition from the $layer: $header',
    async ({ header, layer }) => {
      const test = await fixture({
        ...(layer === 'record' && {
          initialHeaders: { 'cache-control': 'public, max-age=60', [header]: 'no-transform' },
        }),
        ...(layer === 'configured' && {
          headerRules: [{ sourceRegex: '^/icon$', headers: { [header]: 'no-transform' } }],
        }),
        ...(layer === 'middleware' && {
          middlewareHeaders: { 'cache-control': 'public, max-age=600', [header]: 'no-transform' },
        }),
      });
      const response = await test.serve();
      const fallbackPolicy = `${layer === 'middleware' ? 'private' : 'public'}, max-age=0, must-revalidate, no-transform`;

      expect(response.headers.get('cache-control')).toBe(
        layer === 'record' ? 'public, max-age=60, no-transform' : fallbackPolicy,
      );
      expect(response.headers.has(header)).toBe(false);
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect(test.fallback).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps transport fields out of a route body (unsafe-record injection: %s)',
    async (injected) => {
      const raw = {
        connection: 'x-hop',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'x-hop': 'hop-only',
        'cache-control': 'public, max-age=30',
        'cdn-cache-control': 'no-transform',
      };
      const test = await fixture({ initialHeaders: raw });
      const pack = injected
        ? {
            ...test.pack,
            header: { ...test.pack.header, headers: { ...test.pack.header.headers, ...raw } },
          }
        : test.pack;

      test.edge.runtime.memory.generations.set(test.key, { pack, readAt: NOW, bytes: 1024 }, 1024);

      const response = await test.serve();

      expect(response.headers.get('connection')).toBeNull();
      expect(response.headers.get('keep-alive')).toBeNull();
      expect(response.headers.get('transfer-encoding')).toBeNull();
      expect(response.headers.get('x-hop')).toBeNull();
      expect(response.headers.get('cdn-cache-control')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('public, max-age=30, no-transform');
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect(test.fallback).not.toHaveBeenCalled();
    },
  );

  it('does not sanitize away a stored Connection privacy veto before checking it', async () => {
    const test = await fixture();
    const pack = {
      ...test.pack,
      header: {
        ...test.pack.header,
        headers: {
          ...test.pack.header.headers,
          connection: 'cache-control',
          'cache-control': 'private',
        },
      },
    };

    test.edge.runtime.memory.generations.set(test.key, { pack, readAt: NOW, bytes: 1024 }, 1024);

    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { split: true, stale: true, withoutDispatcher: false, dispatches: 1, fn: 'app-2' },
    { split: true, stale: false, withoutDispatcher: false, dispatches: 0, fn: undefined },
    { split: false, stale: true, withoutDispatcher: false, dispatches: 1, fn: undefined },
    { split: true, stale: true, withoutDispatcher: true, dispatches: 0, fn: undefined },
  ])(
    'attributes a detached body regeneration only to an actual split dispatch: %j',
    async (example) => {
      const test = await fixture(example);

      test.clock.now += example.stale ? 1500 : 0;

      const response = await test.serve();

      await test.drain();

      expect(response.status).toBe(200);
      expect(test.points.at(-1)?.fn).toBe(example.fn);
      expect(test.points.at(-1)?.subrequests).toBe(example.dispatches);
      expect(test.dispatch).toHaveBeenCalledTimes(example.dispatches);
    },
  );

  it('attributes a failed detached body dispatch to the split Function it reached', async () => {
    const test = await fixture({ split: true });

    test.dispatch.mockRejectedValueOnce(new Error('app unavailable'));

    test.clock.now += 1500;

    const response = await test.serve();

    await test.drain();

    expect(response.status).toBe(200);
    expect(test.points.at(-1)?.fn).toBe('app-2');
    expect(test.points.at(-1)?.subrequests).toBe(1);
  });

  it('attributes a detached body redispatch to the Function that actually answered', async () => {
    const test = await fixture({ split: true });

    test.dispatch.mockImplementation((script: string) => {
      return Promise.resolve(
        script === 'icon-app-2'
          ? new Response(null, {
              status: MISDIRECTED_STATUS,
              headers: { [FUNCTION_HEADER]: 'app-3' },
            })
          : new Response(REPLACEMENT),
      );
    });

    test.clock.now += 1500;

    const response = await test.serve();

    await test.drain();

    expect(response.status).toBe(200);
    expect(test.points.at(-1)?.fn).toBe('app-3');
    expect(test.points.at(-1)?.subrequests).toBe(2);
    expect(test.points.at(-1)?.redispatch).toBe(1);
  });

  it('keeps dispatch observation failures out of the application response', async () => {
    const test = await fixture({ split: true });
    const onDispatched = vi.fn().mockImplementation(() => {
      throw new Error('observer failed');
    });
    const response = await handlePassthrough({
      request: new Request('https://site.example/icon'),
      forwarding: test.edge.forwarding,
      runtime: test.edge.runtime,
      host: test.edge.host,
      app: test.edge.app,
      function: 'app-2',
      reason: 'route-body-observer-control',
      onDispatched,
    });

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(onDispatched).toHaveBeenCalledTimes(1);
  });

  it('does not attribute middleware-only dispatches to an app Function', async () => {
    const test = await fixture({ split: true, middlewareHeaders: {} });

    await test.serve();

    await test.drain();

    expect(test.points.at(-1)?.fn).toBeUndefined();
    expect(test.points.at(-1)?.subrequests).toBe(1);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves existing detached metric callers without the attribution option', async () => {
    const test = await fixture({ split: true });

    await test.serve();

    triggerDetached(test.edge, {
      request: new Request('https://site.example/icon'),
      middleware: undefined,
      target: { pack: test.pack, entryId: test.entry.entryId },
      function: 'app-2',
    }).record(test.points[0]!);

    await test.drain();

    expect(test.points.at(-1)?.fn).toBeUndefined();
    expect(test.points.at(-1)?.subrequests).toBe(1);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['public, max-age=60, no-transform', 'no-cache, no-transform'])(
    'preserves a safe Cache-Control from the current authority record: %s',
    async (cacheControl) => {
      const test = await fixture({ initialHeaders: { 'cache-control': cacheControl } });
      const response = await test.serve();

      expect(response.headers.get('cache-control')).toBe(cacheControl);
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect(test.dispatch).not.toHaveBeenCalled();
    },
  );

  it('preserves a safe unconditional configured cache policy', async () => {
    const test = await fixture({
      headerRules: [
        {
          sourceRegex: '^/icon$',
          headers: { 'cache-control': 'public, max-age=15, no-transform' },
        },
      ],
    });
    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe('public, max-age=15, no-transform');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { headers: {}, noTransform: false },
    {
      headers: {
        'cache-control': 'public, max-age=600',
        'cdn-cache-control': 'public, max-age=600',
      },
      noTransform: false,
    },
    { headers: { 'cache-control': 'public, max-age=600, no-transform' }, noTransform: true },
  ])(
    'keeps middleware-authorized body bytes private without a Function dispatch: %j',
    async ({ headers, noTransform }) => {
      const test = await fixture({ authorizeByHeader: true, middlewareHeaders: headers });
      const response = await test.serve({ headers: { 'x-allow': 'yes' } });

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect(response.headers.get('cache-control')).toBe(
        `private, max-age=0, must-revalidate${noTransform ? ', no-transform' : ''}`,
      );
      expect(response.headers.has('cdn-cache-control')).toBe(false);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
      expect(test.fallback).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { 'cache-control': 'public, max-age=600' }])(
    'retains a record no-transform when narrowing a middleware-authorized body: %j',
    async (middlewareHeaders) => {
      const test = await fixture({
        authorizeByHeader: true,
        middlewareHeaders,
        initialHeaders: { 'cache-control': 'public, no-transform' },
      });
      const response = await test.serve({ headers: { 'x-allow': 'yes' } });

      expect(response.headers.get('cache-control')).toBe(
        'private, max-age=0, must-revalidate, no-transform',
      );
      expect(test.fallback).not.toHaveBeenCalled();
    },
  );

  it('never supplies the cached body when custom middleware authorization rejects the visitor', async () => {
    const test = await fixture({ authorizeByHeader: true });
    const response = await test.serve();

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Not allowed');
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.fallback).not.toHaveBeenCalled();
  });

  it.each([
    'cache-control',
    'cdn-cache-control',
    'cloudflare-cdn-cache-control',
    'surrogate-control',
  ])('keeps default revalidation when only %s prohibits transformation', async (header) => {
    const test = await fixture({ initialHeaders: { [header]: 'no-transform' } });
    const response = await test.serve();

    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate, no-transform',
    );

    expect(response.headers.has(header)).toBe(header === 'cache-control');

    expect(test.fallback).not.toHaveBeenCalled();
  });

  it.each(
    ['', ' '.repeat(3), ', ,', ', no-transform, '].flatMap((value) =>
      ['record', 'configured'].map((layer) => ({ value, layer })),
    ),
  )(
    'defaults an empty or prohibition-only $layer Cache-Control: "$value"',
    async ({ value, layer }) => {
      const test = await fixture({
        ...(layer === 'record' && { initialHeaders: { 'cache-control': value } }),
        ...(layer === 'configured' && {
          headerRules: [{ sourceRegex: '^/icon$', headers: { 'cache-control': value } }],
        }),
      });
      const response = await test.serve();

      expect(response.headers.get('cache-control')).toBe(
        `public, max-age=0, must-revalidate${value.includes('no-transform') ? ', no-transform' : ''}`,
      );
      expect(test.fallback).not.toHaveBeenCalled();
    },
  );

  it('routes an image GET through the body handler without reading an HTML artifact', async () => {
    const test = await fixture();
    const artifacts = vi.spyOn(env.ARTIFACTS, 'get');
    const response = await routed(test, test.manifest, {
      accept: 'image/png',
      'sec-fetch-dest': 'image',
    });

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(response.headers.get('x-arkor-edge')).toContain('route-body;');
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
  });

  it('does not fall through a bypassed body onto a dynamic HTML route', async () => {
    const test = await fixture();
    const manifest: ProjectManifest = {
      ...test.manifest,
      routeBodies: {
        '/icon': {
          ...test.entry,
          bypassFor: [{ type: 'header', key: 'x-private' }],
        },
      },
      routes: {
        '/[slug]': {
          pathname: '/[slug]',
          status: 200,
          shell: {
            sha256: 'b'.repeat(64),
            byteLength: 100,
            contentType: 'text/html',
            encoding: 'identity',
          },
          headers: { 'content-type': 'text/html' },
        },
      },
      dynamicRoutes: [{ sourceRegex: '^/([^/]+)$', route: '/[slug]' }],
    };
    const html = vi.spyOn(env.EDGE_STATE, 'get');
    const records = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await routed(test, manifest, {
      accept: 'text/html',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'x-private': '1',
    });

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).not.toContain('public');
    expect(response.headers.get('x-arkor-edge')).toContain('route-body-bypass');
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(html).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();

    await test.drain();
  });

  it('judges route-body bypass against the Via value the Function receives', async () => {
    const test = await fixture();
    const manifest: ProjectManifest = {
      ...test.manifest,
      routeBodies: {
        '/icon': {
          ...test.entry,
          bypassFor: [{ type: 'header', key: 'via', value: '1.1 arkor-edge' }],
        },
      },
    };
    const records = vi.spyOn(env.CACHE_STATE, 'get');
    const response = await routed(test, manifest);

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(records).not.toHaveBeenCalled();

    await test.drain();
  });

  it('does not evaluate body bypass against host credentials the Function never receives', async () => {
    const test = await fixture({ credentials: { cookies: [], headers: ['x-host-session'] } });
    const manifest: ProjectManifest = {
      ...test.manifest,
      routeBodies: {
        '/icon': {
          ...test.entry,
          bypassFor: [{ type: 'header', key: 'x-host-session', value: 'present' }],
        },
      },
    };
    const response = await routed(test, manifest, { 'x-host-session': 'present' });

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { privateDelivery: true },
    { validated: true },
    { initialHeaders: { 'cache-control': 'private, max-age=0' } },
    { initialHeaders: { 'cache-control': 'no-store' } },
    { initialHeaders: { vary: '*' } },
    { initialHeaders: { 'set-cookie': 'visitor=1' } },
    { initialHeaders: { 'content-type': 'text/html' } },
  ])('leaves an unshareable record or host policy with the Function: %j', async (options) => {
    const test = await fixture(options);
    const response = await test.serve();

    await expect(response.text()).resolves.toBe('Function');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { cookie: 'visitor=1' },
    { authorization: 'Bearer visitor' },
    { range: 'bytes=0-1' },
    { 'if-none-match': '"old"' },
  ])('does not read a record for visitor-specific or conditional headers: %j', async (headers) => {
    const test = await fixture();
    const get = vi.spyOn(env.CACHE_STATE, 'get');

    await test.serve({ headers });

    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('uses foreground regeneration after hard expiry, preserving raw bytes and private policy', async () => {
    const test = await fixture();

    test.clock.now += 3000;

    const response = await test.serve();

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).not.toContain('public');
    expect(test.dispatch).toHaveBeenCalledTimes(1);

    await test.drain();

    expect(test.points.map((point) => point.middlewareMs)).toStrictEqual([undefined]);
  });

  it('adopts a regenerated current record without replacing unrelated stored data', async () => {
    const test = await fixture({ holdMs: 0, publishOnRegeneration: true });
    await env.CACHE_STATE.put('unrelated-entry', 'keep this value');

    test.clock.now += 3000;

    const rendered = await test.serve();

    expect(new Uint8Array(await rendered.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(rendered.headers.get('cache-control')).toContain('private');

    const current = await test.serve();

    expect(new Uint8Array(await current.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(current.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    await expect(env.CACHE_STATE.get('unrelated-entry')).resolves.toBe('keep this value');

    await test.drain();
  });

  it('serves a stale generation while its existing detached regeneration runs behind it', async () => {
    const test = await fixture();

    test.clock.now += 1500;

    const response = await test.serve();

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(response.headers.get('x-arkor-edge')).toContain('cache=stale');

    await test.drain();

    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it('honours an at-once tag invalidation before the time deadline', async () => {
    const test = await fixture();
    const untouched = {
      ...test.pack,
      header: { ...test.pack.header, entryId: 'unrelated', tags: [] },
    };
    const unrelated = kvGenerationKey(SCOPE, 'unrelated');

    test.edge.runtime.memory.generations.set(
      unrelated,
      { pack: untouched, readAt: NOW, bytes: 1024 },
      1024,
    );

    test.edge.runtime.memory.invalidations.take(SCOPE, [test.tag], 2);

    const response = await test.serve();

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.edge.runtime.memory.generations.get(unrelated)?.pack).toBe(untouched);

    await test.drain();
  });

  it('does not regenerate an expired generation behind a HEAD request', async () => {
    const test = await fixture();

    test.clock.now += 3000;

    const response = await test.serve({ method: 'HEAD' });

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('does not reinterpret another entry kind as a route body', async () => {
    const test = await fixture();
    const pack = { ...test.pack, header: { ...test.pack.header, kind: 'app-page' as const } };

    test.edge.runtime.memory.generations.set(test.key, { pack, readAt: NOW, bytes: 1024 }, 1024);

    await test.serve();

    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('falls back privately when the current record is missing, without using the build body', async () => {
    const test = await fixture();

    test.edge.runtime.memory.generations.delete(test.key);

    await env.CACHE_STATE.delete(test.key);
    const response = await test.serve();

    await expect(response.text()).resolves.toBe('Function');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('counts a record lookup before falling back to the Function', async () => {
    const test = await fixture();

    test.edge.runtime.memory.generations.delete(test.key);

    const records: { get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null> } =
      env.CACHE_STATE;
    vi.spyOn(records, 'get').mockImplementation(() => {
      test.clock.now += 7;

      return Promise.resolve(null);
    });
    const response = await routed(test);
    await response.arrayBuffer();

    await test.drain();

    const point = test.points.find((item) => item.outcomeKind === 'route-body-no-record');

    expect(point?.recordLookupMs).toBe(7);
    // Existing passthrough timing starts at the upstream; earlier record work stays separate.
    expect(point?.ttfbInternalMs).toBe(0);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects stored bytes that do not match the generation digest', async () => {
    const test = await fixture();
    const damaged = new Uint8Array(test.record);
    damaged[damaged.length - 1] = ((damaged.at(-1) ?? 0) + 1) % 256;

    test.edge.runtime.memory.generations.delete(test.key);

    await env.CACHE_STATE.put(test.key, damaged);
    const response = await test.serve();

    await expect(response.text()).resolves.toBe('Function');
    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('does not publish an error generation as the image', async () => {
    const test = await fixture();
    const pack = { ...test.pack, header: { ...test.pack.header, status: 500 } };

    test.edge.runtime.memory.generations.set(test.key, { pack, readAt: NOW, bytes: 1024 }, 1024);

    const response = await test.serve();

    await expect(response.text()).resolves.toBe('Function');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('leaves a generation with malformed HTTP headers to the Function', async () => {
    const test = await fixture();
    const pack = {
      ...test.pack,
      header: { ...test.pack.header, headers: { 'bad header name': 'unsafe' } },
    };

    test.edge.runtime.memory.generations.set(test.key, { pack, readAt: NOW, bytes: 1024 }, 1024);

    const response = await test.serve();

    await expect(response.text()).resolves.toBe('Function');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it.each(['\0', '\r', '\n'])(
    'leaves a selected runtime body type containing %j to the Function',
    async (control) => {
      const test = await fixture();
      const contentType = `image/png; name=a${control}b`;

      await runtimeBodyType(test, contentType);

      const response = await routed(test);

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(REPLACEMENT);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toContain('private');
      expect(test.dispatch).toHaveBeenCalledTimes(1);
      expect(test.edge.runtime.memory.generations.get(test.key)?.pack.header.source).toBe(
        'runtime',
      );

      await test.drain();

      expect(test.points.map((point) => point.outcomeKind)).toContain('route-body-record-mismatch');
    },
  );

  it.each([
    { contentType: 'image/png; name="日本語"', expected: 'image/png; name="日本語"' },
    { contentType: ' \timage/png; name=icon\t ', expected: 'image/png; name=icon' },
  ])(
    'uses native normalization for a selected runtime body type: $contentType',
    async (example) => {
      const test = await fixture();

      await runtimeBodyType(test, example.contentType);

      const response = await routed(test);

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect(response.headers.get('content-type')).toBe(example.expected);
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(test.dispatch).not.toHaveBeenCalled();

      await test.drain();
    },
  );

  it('keeps a recorded body type ahead of an unused malformed artifact type', async () => {
    const test = await fixture();

    await runtimeBodyType(test, 'image/png; name=a\r\nb', { 'content-type': 'image/png' });

    const response = await routed(test);

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(test.dispatch).not.toHaveBeenCalled();

    await test.drain();
  });

  it.each([
    { 'cache-control': 'private' },
    { 'cache-control': 'no-store' },
    { vary: '*' },
    { 'cdn-cache-control': 'private' },
    { connection: 'cache-control' },
  ])('honours configured privacy before reading a generation: %j', async (headers) => {
    const test = await fixture({ headerRules: [{ sourceRegex: '^/icon$', headers }] });
    const get = vi.spyOn(env.CACHE_STATE, 'get');

    await test.serve();

    expect(test.fallback).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(varyCases(['Accept-Language', 'Accept-Encoding, aCcEpT-LaNgUaGe']))(
    'does not share an unkeyed variant from $layer: $vary',
    async ({ layer, vary }) => {
      const test = await varyFixture(layer, vary);

      const response = await test.serve({ headers: { 'accept-language': 'fr' } });

      await expect(response.text()).resolves.toBe('Function');
      expect(test.fallback).toHaveBeenCalledTimes(1);

      await test.drain();
    },
  );

  it.each(varyCases(['Accept-Encoding', 'aCcEpT-EnCoDiNg']))(
    'keeps serving identity bytes with compression Vary from $layer: $vary',
    async ({ layer, vary }) => {
      const test = await varyFixture(layer, vary);

      const response = await test.serve({ headers: { 'accept-encoding': 'gzip' } });

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(BODY);
      expect(test.fallback).not.toHaveBeenCalled();
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(test.dispatch).toHaveBeenCalledTimes(layer === 'middleware' ? 1 : 0);

      await test.drain();
    },
  );

  it.each([
    { 'cache-control': 'private' },
    { 'cache-control': 'no-store' },
    { vary: '*' },
    { 'set-cookie': 'visitor=1' },
    { 'cloudflare-cdn-cache-control': 'no-store' },
    { connection: 'vary' },
    { connection: 'cache-control', 'cache-control': 'private' },
    { connection: 'set-cookie', 'set-cookie': 'visitor=1' },
    { connection: 'content-encoding', 'content-encoding': 'gzip' },
  ])(
    'honours middleware privacy without making its response public: %j',
    async (middlewareHeaders) => {
      const test = await fixture({ middlewareHeaders });
      const response = await test.serve();

      await expect(response.text()).resolves.toBe('Function');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(test.fallback).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ cookie: 'visitor=1' }, { authorization: 'Bearer visitor' }])(
    'does not lose the original visitor privacy when middleware deletes headers: %j',
    async (headers) => {
      const test = await fixture({
        middlewareHeaders: {
          'x-middleware-override-headers': 'user-agent',
          'x-middleware-request-user-agent': 'sanitized',
        },
      });
      const get = vi.spyOn(env.CACHE_STATE, 'get');

      await test.serve({ headers });

      expect(test.fallback).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    },
  );
});
