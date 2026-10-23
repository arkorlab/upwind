import { kvArtifactKey, r2ArtifactKey, sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromCacheControl,
  type DecodedGenerationPack,
} from '@stayingupwind/core/cache';
import type { HeaderRule, ProjectManifest } from '@stayingupwind/core/manifest';
import { classifyRequest } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { seedRouteFor } from '@stayingupwind/host/bundle';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  resolvePolicy,
} from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- These fixtures exercise the real host seed and publisher, and share their constants. */
import { assembleManifest } from '../../deploy/src/manifest.ts';
import {
  BUILT_PATH,
  FALLBACK_NOW,
  FALLBACK_ROUTE,
  LAZY_PATH,
  fallbackPageFixture,
} from '../../host/test/fallback-page-fixture.ts';
import { routeHostedFallbackPage } from '../src/handlers/fallback-page.ts';
import type { StaticPageInput } from '../src/handlers/static-page.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { edgeStrategyRegistry } from '../src/strategies/registry.ts';

export const FALLBACK_SCOPE = 'dpl_fallbackPages';
const DATE = '2027-01-15T08:00:00.000Z';

export interface FallbackEdgeOptions {
  readonly headerRules?: HeaderRule[];
  readonly middleware?: boolean;
}
export interface FallbackServeOptions {
  readonly pathname?: string;
  readonly init?: RequestInit;
  readonly classifiedHeaders?: Headers;
  readonly edge?: Partial<EdgeContext>;
  readonly manifest?: ProjectManifest;
}

/** Real seed, publication, KV/R2 and reader; application dispatch stays an explicit test binding. */
async function createFallbackEdgeFixture(options: FallbackEdgeOptions = {}) {
  const native = await fallbackPageFixture();
  const seed = await seedRouteFor(native.bundle, native.page, {
    scopeId: FALLBACK_SCOPE,
    generatedAt: FALLBACK_NOW,
  });
  if (seed?.cache === undefined) throw new Error('native fallback member needs its real seed');
  const { entryId } = await deriveEntry(FALLBACK_SCOPE, seed.input.descriptor);
  const generation = seed.input.generation;
  if (generation.outputs.filter((output) => output.staticPagePrivacy === 3).length !== 2)
    throw new Error('both native outputs must attest their pair');
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: FALLBACK_SCOPE,
      entryId,
      generationId: generation.generationId,
      seq: 1,
      revision: 1,
      source: 'build',
      kind: 'pages',
      route: FALLBACK_ROUTE,
      pathname: BUILT_PATH,
      cacheTimestamp: generation.cacheTimestamp,
      producedAt: generation.producedAt,
      policy: generation.policy,
      status: generation.status,
      headers: generation.headers,
      tags: generation.tags,
      htmlSha256: native.page.body!.sha256,
      htmlLength: native.html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      staticPagePrivacy: 3,
      artifacts: generation.outputs.flatMap((output) => {
        return output.artifacts.map((artifact) => {
          return {
            ...artifact,
            artifactId: `artifact_${output.representationKey}`,
            representationKey: output.representationKey,
          };
        });
      }),
    },
    native.html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('real fallback seed must encode');
  const built = {
    entryId,
    bytes,
    pack: decoded.pack,
    key: kvGenerationKey(FALLBACK_SCOPE, entryId),
  };
  let now = FALLBACK_NOW;
  const memory = createEdgeMemory(() => now);
  const dispatch = vi
    .fn<NonNullable<EdgeContext['runtime']['dispatchApp']>>()
    .mockResolvedValue(new Response(null));
  const currentRecord = vi
    .fn<NonNullable<EdgeContext['host']['currentRecord']>>()
    .mockResolvedValue(undefined);
  const ctx = createExecutionContext();
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    shell: { backend: 'r2' as const, memoryLru: true, cacheApiLayer: false },
    runtimeCache: {
      ...DEFAULT_RUNTIME_CACHE_SETTINGS,
      generations: 'on' as const,
      holdMs: 60_000,
      cacheApiMaxAgeMs: 0,
    },
  };
  const app = {
    deploymentId: FALLBACK_SCOPE,
    scriptName: 'fallback-app',
    ...(options.middleware === true && { middlewareScriptName: 'fallback-middleware' }),
  };
  const edge: EdgeContext = {
    env,
    ctx,
    runtime: standaloneRuntime(env, { now: () => now, memory, dispatchApp: dispatch }),
    host: { ...standaloneHost(env), currentRecord },
    forwarding: { previewDomain: 'invalid', previewHost: 'site.example', clientIp: undefined },
    app,
    originalUrl: undefined,
    policy,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'a'.repeat(64),
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
  };
  const assembled = await assembleManifest({
    bundle: native.bundle,
    previous: undefined,
    projectId: 'site',
    runId: 'run_fallbackPages',
    originHost: 'site.example',
    deploymentId: FALLBACK_SCOPE,
    fingerprint: {
      dplId: native.bundle.deploymentId,
      buildId: native.bundle.buildId,
      assetSetHash: 'a'.repeat(64),
      observedAt: DATE,
    },
    app,
    generatedAt: DATE,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-test'",
    nextVersionJudged: true,
  });
  if (assembled.kind !== 'assembled')
    throw new Error(`fallback manifest refused: ${assembled.reason}`);
  const manifest: ProjectManifest = {
    ...assembled.manifest,
    ...(options.headerRules !== undefined && { headerRules: options.headerRules }),
    ...(options.middleware === true && { middleware: { matchers: [{ sourceRegex: '^/.*$' }] } }),
  };
  for (const [output, body] of [
    [native.page, native.html],
    [native.twin, native.data],
    [native.fallback, native.loading],
  ] as const) {
    const ref = output.body;
    if (ref === undefined) throw new Error('native fixture body missing');
    await env.ARTIFACTS.put(blobObjectKey(ref.sha256), body);
    await env.ARTIFACTS.put(r2ArtifactKey(ref.sha256), body);
    await env.EDGE_STATE.put(kvArtifactKey(ref.sha256), body);
  }
  const hold = (pack: DecodedGenerationPack, record = bytes, key = built.key): void => {
    memory.generations.set(key, { pack, readAt: now, bytes: record.byteLength }, record.byteLength);
  };
  hold(decoded.pack);
  await env.CACHE_STATE.put(built.key, bytes);
  const fallback = vi
    .fn<StaticPageInput['passthrough']>()
    .mockResolvedValue(
      new Response('Function', { headers: { 'cache-control': 'private, no-store' } }),
    );
  async function serve(input: FallbackServeOptions = {}) {
    const request = new Request(`https://site.example${input.pathname ?? BUILT_PATH}`, input.init);
    const url = new URL(request.url);
    const selectedManifest = input.manifest ?? manifest;
    // A direct-handler test may deliberately supply raw state that changed after classification.
    const originalUrl = new URL(url.href);
    originalUrl.search = '';
    const classification = classifyRequest({
      method: 'GET',
      url: originalUrl,
      headers: new Headers(),
      manifest: selectedManifest,
      deployment: selectedManifest.deployment,
    });
    if (classification.kind !== 'static-page' && classification.kind !== 'pages-fallback')
      throw new Error('fixture needs a real Pages candidate');
    return routeHostedFallbackPage({
      request,
      url,
      edge: { ...edge, ...input.edge },
      manifest: selectedManifest,
      classification,
      classifiedHeaders: input.classifiedHeaders ?? request.headers,
      resolved: resolvePolicy(edgeStrategyRegistry, policy),
      passthrough: fallback,
    });
  }
  async function runtimeMember(pathname = LAZY_PATH, seq = 1, revision = seq) {
    const concrete = await deriveEntry(FALLBACK_SCOPE, {
      kind: 'pages',
      route: FALLBACK_ROUTE,
      pathname,
    });
    const slug = pathname.split('/').at(-1) ?? '';
    const html = encodeUtf8(`<p>runtime ${slug}</p>`);
    const data = encodeUtf8(JSON.stringify({ pageProps: { slug }, __N_SSG: true }));
    const htmlHash = await sha256Hex(html);
    const dataHash = await sha256Hex(data);
    await env.ARTIFACTS.put(blobObjectKey(htmlHash), html);
    await env.ARTIFACTS.put(blobObjectKey(dataHash), data);
    const record = encodeGenerationPack(
      {
        ...built.pack.header,
        entryId: concrete.entryId,
        pathname,
        generationId: `runtime-${seq}-${revision}`,
        source: 'runtime',
        seq,
        revision,
        cacheTimestamp: now,
        producedAt: now,
        htmlSha256: htmlHash,
        htmlLength: html.byteLength,
        artifacts: built.pack.header.artifacts.map((artifact) => {
          return artifact.role === 'html'
            ? {
                ...artifact,
                sha256: htmlHash,
                byteLength: html.byteLength,
                storageRef: blobObjectKey(htmlHash),
              }
            : {
                ...artifact,
                sha256: dataHash,
                byteLength: data.byteLength,
                storageRef: blobObjectKey(dataHash),
              };
        }),
        policy: policyFromCacheControl({ revalidate: 2, expire: 60 }),
      },
      html,
      undefined,
    );
    const value = decodeGenerationPack(record);
    if (value.kind !== 'ok') throw new Error('runtime member pack must decode');
    return {
      bytes: record,
      pack: value.pack,
      entryId: concrete.entryId,
      key: kvGenerationKey(FALLBACK_SCOPE, concrete.entryId),
      html,
      data,
    };
  }
  return {
    serve,
    edge,
    manifest,
    built,
    dispatch,
    currentRecord,
    fallback,
    hold,
    runtimeMember,
    native,
    setNow: (value: number): void => {
      now = value;
    },
  };
}

export {
  BUILT_PATH,
  FALLBACK_NOW,
  FALLBACK_ROUTE,
  LAZY_PATH,
} from '../../host/test/fallback-page-fixture.ts';
export type FallbackEdgeFixture = Awaited<ReturnType<typeof createFallbackEdgeFixture>>;
export function fallbackEdgeFixture(
  options: FallbackEdgeOptions = {},
): Promise<FallbackEdgeFixture> {
  return createFallbackEdgeFixture(options);
}
