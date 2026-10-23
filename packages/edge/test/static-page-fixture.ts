import { sha256Hex } from '@stayingupwind/core/artifact';
import type { Prerender } from '@stayingupwind/core/bundle';
import {
  decodeGenerationPack,
  type DecodedGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
} from '@stayingupwind/core/cache';
import { buildProjectManifest, type HeaderRule } from '@stayingupwind/core/manifest';
import { RSC_VARY } from '@stayingupwind/core/request';
import { seedRouteFor } from '@stayingupwind/host/bundle';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- The real host seed is the sharing authority under test. */
import { shellBundle } from '../../host/test/shared-shell-fixture.ts';
import { routeHostedStaticPage } from '../src/handlers/static-page.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

export const NOW = 1_800_000_000_000;
const SCOPE = 'dpl_staticPages';
export const PATH = '/something';
export const BODY = new TextEncoder().encode(
  '<!doctype html><html><body>hello: world</body></html>',
);
export const DATE = '2026-10-18T00:00:00.000Z';

interface FixtureOptions {
  readonly legacy?: boolean;
  readonly privacy?: 1 | 2;
  readonly initialRevalidate?: number | false;
  readonly headerRules?: HeaderRule[];
  readonly middleware?: boolean;
  readonly cspNonce?: boolean;
  readonly privateDelivery?: boolean;
  readonly validated?: boolean;
  readonly initialHeaders?: Record<string, string>;
}

function expectedMarker(options: FixtureOptions): 1 | 2 {
  return options.privacy === 2 && typeof options.initialRevalidate === 'number' ? 2 : 1;
}

/** A real build seed, not a public header returned by a Function. */
export function staticPageFixture(options: FixtureOptions = {}): ReturnType<typeof fixture> {
  return fixture(options);
}

async function fixture(options: FixtureOptions) {
  let now = NOW;
  const sha256 = await sha256Hex(BODY);
  const prerender: Prerender = {
    id: 'something',
    route: PATH,
    pathname: PATH,
    parentOutputId: 'page',
    groupId: 1,
    routeType: 'page',
    response: 'complete',
    compute: 'static',
    renderingMode: 'STATIC',
    initialStatus: 200,
    initialRevalidate: options.initialRevalidate ?? false,
    initialHeaders: {
      'content-type': 'text/html; charset=utf-8',
      vary: RSC_VARY,
      ...options.initialHeaders,
    },
    allowHeader: ['host', 'x-prerender-revalidate'],
    body: { sha256, byteLength: BODY.byteLength, contentType: 'text/html; charset=utf-8' },
  };
  const base = shellBundle(prerender, 'pages');
  const bundle = {
    ...base,
    config: { ...base.config, cacheComponents: false },
    ...(options.legacy !== true && { staticPagesPrivacy: options.privacy ?? 1 }),
  };
  const seed = await seedRouteFor(bundle, prerender, { scopeId: SCOPE, generatedAt: NOW });
  if (seed?.cache === undefined) throw new Error('Pages must have a real seed');
  const generation = seed.input.generation;
  const marker = generation.outputs.find(
    (output) => output.representationKey === 'html',
  )?.staticPagePrivacy;
  const expected = expectedMarker(options);
  if (marker !== expected && options.legacy !== true)
    throw new Error('eligible build must attest HTML');
  const { entryId } = await deriveEntry(SCOPE, seed.input.descriptor);
  const record = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: generation.generationId,
      seq: 1,
      revision: 1,
      source: 'build',
      kind: 'pages',
      route: PATH,
      pathname: PATH,
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
      ...((marker === 1 || marker === 2) && { staticPagePrivacy: marker }),
      artifacts: generation.outputs.flatMap((output) => {
        return output.artifacts.map((artifact) => {
          return {
            ...artifact,
            artifactId: 'artifact_staticPage',
            representationKey: output.representationKey,
          };
        });
      }),
    },
    BODY,
    undefined,
  );
  const decoded = decodeGenerationPack(record);
  if (decoded.kind !== 'ok') throw new Error('real seed must produce a valid pack');
  const key = kvGenerationKey(SCOPE, entryId);
  const memory = createEdgeMemory(() => now);
  const hold = (pack: DecodedGenerationPack): void => {
    memory.generations.set(key, { pack, readAt: now, bytes: record.byteLength }, record.byteLength);
  };
  hold(decoded.pack);
  await env.CACHE_STATE.put(key, record);
  const dispatch = vi
    .fn<NonNullable<EdgeContext['runtime']['dispatchApp']>>()
    .mockResolvedValue(new Response(null, { headers: { 'x-middleware-next': '1' } }));
  const ctx = createExecutionContext();
  const edge: EdgeContext = {
    env,
    ctx,
    runtime: standaloneRuntime(env, { now: () => now, memory, dispatchApp: dispatch }),
    host: standaloneHost(env),
    forwarding: { previewDomain: 'invalid', previewHost: 'site.example', clientIp: undefined },
    app: {
      deploymentId: SCOPE,
      scriptName: 'static-page-app',
      ...(options.middleware === true && { middlewareScriptName: 'static-page-middleware' }),
    },
    originalUrl: undefined,
    policy: {
      ...DEFAULT_DELIVERY_POLICY,
      runtimeCache: {
        ...DEFAULT_RUNTIME_CACHE_SETTINGS,
        generations: 'on',
        holdMs: 60_000,
        cacheApiMaxAgeMs: 0,
      },
    },
    cspNonce: options.cspNonce ?? false,
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
    pathname: PATH,
    route: PATH,
    entryId,
    ...(marker === 2 && { staticPagePrivacy: 2 as const }),
  };
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run_staticPage',
    generatedAt: DATE,
    originHost: 'site.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: DATE },
    routes: [
      {
        pathname: PATH,
        status: 200,
        shell: { ...prerender.body!, encoding: 'identity' },
        headers: { 'content-type': 'text/html; charset=utf-8' },
        cache: seed.cache,
      },
    ],
    dynamicRoutes: [],
    app: edge.app!,
    cache: { keySchemaVersion: 1, scopeId: SCOPE },
    staticPages: [entry],
    ...(options.headerRules !== undefined && { headerRules: options.headerRules }),
    ...(options.middleware === true && {
      middleware: { matchers: [{ sourceRegex: '^/something$' }] },
    }),
  });
  const fallback = vi
    .fn()
    .mockResolvedValue(
      new Response('Function', { headers: { 'cache-control': 'private, no-store' } }),
    );
  function serve(init: RequestInit = {}, pathname = PATH) {
    const request = new Request(`https://site.example${pathname}`, init);
    return routeHostedStaticPage({
      request,
      url: new URL(request.url),
      edge,
      manifest,
      entry,
      classifiedHeaders: request.headers,
      passthrough: fallback,
    });
  }
  const setNow = (value: number): void => {
    now = value;
  };
  return {
    serve,
    edge,
    manifest,
    entry,
    pack: decoded.pack,
    fallback,
    dispatch,
    key,
    hold,
    setNow,
  };
}
