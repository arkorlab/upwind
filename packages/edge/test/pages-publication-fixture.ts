import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromCacheControl,
  type GenerationPackHeader,
} from '@stayingupwind/core/cache';
import { classifyRequest } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { vi } from 'vitest';

import { assembleManifest } from '../../deploy/src/manifest.ts';
import { fallbackPageFixture } from '../../host/test/fallback-page-fixture.ts';
import { routeHostedFallbackPage } from '../src/handlers/fallback-page.ts';
import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const SCOPE = 'dpl_first_pages';
export const PAGE = '/fallback-true/second';
export const DATA = '/_next/data/build/fallback-true/second.json';
export const PRIVATE_BODY = '{"pageProps":{"source":"private visitor"}}';
export const PUBLIC = 'public, max-age=0, must-revalidate';
const NOW = 1_800_000_000_000;
const DATE = '2027-01-15T08:00:00.000Z';

/** Actual classification, pack admission and delivery in Node; Function and storage are in memory. */
async function createPagesPublicationFixture() {
  const native = await fallbackPageFixture();
  const app = { deploymentId: SCOPE, scriptName: 'app' };
  const assembled = await assembleManifest({
    bundle: native.bundle,
    previous: undefined,
    projectId: 'site',
    runId: 'run_first_pages',
    originHost: 'site.example',
    deploymentId: SCOPE,
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
  if (assembled.kind !== 'assembled') throw new Error(assembled.reason);
  const { manifest } = assembled;
  const tasks: Promise<unknown>[] = [];
  const beganAt = Date.now();
  const now = () => NOW + Date.now() - beganAt;
  const memory = createEdgeMemory(now);
  const kv = vi.fn<(key: string, options?: unknown) => Promise<ArrayBuffer | null>>(() =>
    Promise.resolve(null),
  );
  const currentRecord = vi.fn<
    (scope: string, entry: string, after: number) => Promise<ArrayBuffer | undefined>
  >(() => Promise.resolve(undefined));
  const entered: { count: number; resolve: () => void }[] = [];
  function waitForReads(count: number): Promise<void> {
    if (currentRecord.mock.calls.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entered.push({ count, resolve });
    });
  }
  const blobs = new Map<string, Uint8Array>();
  const get = vi.fn((key: string) => {
    const bytes = blobs.get(key);
    return Promise.resolve(
      bytes === undefined ? null : { size: bytes.byteLength, body: new Response(bytes).body },
    );
  });
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    shell: { backend: 'r2' as const, memoryLru: true, cacheApiLayer: false },
    runtimeCache: { ...DEFAULT_DELIVERY_POLICY.runtimeCache!, cacheApiMaxAgeMs: 0 },
  };
  const edge = {
    env: { CACHE_STATE: { get: kv }, ARTIFACTS: { get } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    runtime: { now, memory },
    host: {
      currentRecord: (...args: Parameters<typeof currentRecord>) => {
        const reading = currentRecord(...args);
        for (const waiter of entered) {
          if (currentRecord.mock.calls.length >= waiter.count) waiter.resolve();
        }
        return reading;
      },
      names: {},
      credentials: { headers: [], cookies: [] },
      observer: { metric: vi.fn(), recordServed: vi.fn() },
    },
    forwarding: { previewDomain: 'invalid', previewHost: 'site.example', clientIp: undefined },
    policy,
    app,
    projectId: 'site',
    manifestId: 'manifest',
    validated: false,
    privateDelivery: false,
    cspNonce: false,
    cacheApi: false,
    timings: { pointerMs: 0, manifestMs: 0 },
  } as unknown as EdgeContext;
  const fallback = vi.fn(() => Promise.resolve(new Response('private fallback')));
  async function serve(pathname = PAGE, init?: RequestInit): Promise<Response> {
    const request = new Request(`https://site.example${pathname}`, init);
    const url = new URL(request.url);
    const classification = classifyRequest({
      method: request.method,
      url,
      headers: request.headers,
      manifest,
      deployment: manifest.deployment,
    });
    if (classification.kind !== 'pages-fallback' && classification.kind !== 'static-page')
      throw new Error('request needs an admitted Pages route');
    return routeHostedFallbackPage({
      edge,
      request,
      url,
      classification,
      manifest,
      classifiedHeaders: request.headers,
      resolved: {
        policy,
        shell: {
          id: 'r2',
          getShell: () =>
            Promise.resolve({ bytes: native.loading, source: 'memory', latencyMs: 0 }),
        },
        assets: {
          id: 'passthrough',
          handle: () => Promise.reject(new Error('no asset is requested')),
        },
      },
      passthrough: fallback,
    });
  }
  async function member(pathname = PAGE, overrides: Partial<GenerationPackHeader> = {}) {
    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'pages',
      route: native.page.route,
      pathname,
    });
    const html = new TextEncoder().encode(`<p>completed member ${overrides.revision ?? 1}</p>`);
    const data = new TextEncoder().encode(
      JSON.stringify({ pageProps: { revision: overrides.revision ?? 1 } }),
    );
    const htmlHash = await sha256Hex(html);
    const dataHash = await sha256Hex(data);
    const storageRef = `runtime/${entryId}/pages-data`;
    blobs.set(storageRef, data);
    // Trusted immutable storage is preloaded; Node lacks workerd's BYOB readAtLeast extension.
    memory.shells.set(dataHash, data, data.byteLength);
    const header: GenerationPackHeader = {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: 'gen_first_pages',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'pages',
      route: native.page.route,
      pathname,
      cacheTimestamp: now(),
      producedAt: now(),
      policy: policyFromCacheControl({ revalidate: 2, expire: 60 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: htmlHash,
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      staticPagePrivacy: 3,
      artifacts: [
        {
          role: 'html',
          representationKey: 'html',
          artifactId: 'art_html',
          sha256: htmlHash,
          byteLength: html.byteLength,
          contentType: 'text/html',
          encoding: 'identity',
        },
        {
          role: 'pages-data',
          representationKey: 'pages-data',
          artifactId: 'art_data',
          sha256: dataHash,
          byteLength: data.byteLength,
          contentType: 'application/json',
          encoding: 'identity',
          storageRef,
        },
      ],
      ...overrides,
    };
    const bytes = new Uint8Array(encodeGenerationPack(header, html, undefined)).buffer;
    const decoded = decodeGenerationPack(new Uint8Array(bytes));
    if (decoded.kind !== 'ok') throw new Error('member pack must decode');
    return { bytes, html, data, entryId, key: kvGenerationKey(SCOPE, entryId), pack: decoded.pack };
  }
  const dispatch = vi.mocked(handlePassthrough);
  return {
    serve,
    fallback,
    member,
    edge,
    manifest,
    currentRecord,
    dispatch,
    tasks,
    kv,
    get,
    waitForReads,
    drain: async () => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

export function pagesPublicationFixture(): Promise<
  Awaited<ReturnType<typeof createPagesPublicationFixture>>
> {
  return createPagesPublicationFixture();
}
