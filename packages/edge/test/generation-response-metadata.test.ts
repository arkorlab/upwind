import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  type GenerationPackHeader,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { HeaderRule } from '@stayingupwind/core/manifest';
import { NEXT_RESUME_HEADER } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const NOW = 100;
const KEY = { scopeId: 'scope-response-metadata', entryId: 'entry-response-metadata' };
const RECORD_KEY = kvGenerationKey(KEY.scopeId, KEY.entryId);
const HTML = encodeUtf8('<html><body>the retained document</body></html>');
const PART = encodeUtf8('the retained Flight payload');
const PART_KEY = 'metadata-response-part';
const CSP = 'content-security-policy';
const FALLBACK = 'the whole application response';
const INVALID_VALUES = ['a\0b', 'a\rb', 'a\nb'];

async function record(
  options: {
    readonly headers?: Record<string, string>;
    readonly contentType?: string;
    readonly unusedType?: string;
    readonly partial?: boolean;
    readonly status?: number;
  } = {},
) {
  const document = pprDocument();
  const html = options.partial === true ? document.shell : HTML;
  const postponed = options.partial === true ? encodeUtf8('the resume state') : undefined;
  const artifact = {
    artifactId: 'artifact_response_part',
    sha256: await sha256Hex(PART),
    byteLength: PART.byteLength,
    contentType: options.contentType ?? 'text/x-component',
    encoding: 'identity' as const,
    role: 'rsc' as const,
    representationKey: 'rsc',
    storageRef: PART_KEY,
  };
  const header: GenerationPackHeader = {
    schemaVersion: 1,
    ...KEY,
    generationId: 'gen_response_metadata',
    seq: 1,
    revision: 3,
    source: 'runtime',
    kind: 'app-page',
    route: '/',
    pathname: '/',
    cacheTimestamp: NOW,
    producedAt: NOW,
    policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
    status: options.status ?? 200,
    headers: { 'content-type': 'text/html', ...options.headers },
    tags: [],
    htmlSha256: await sha256Hex(html),
    htmlLength: html.byteLength,
    postponedSha256: postponed === undefined ? null : await sha256Hex(postponed),
    postponedLength: postponed?.byteLength ?? 0,
    artifacts: [
      artifact,
      {
        ...artifact,
        artifactId: 'artifact_unselected',
        role: 'segment',
        representationKey: 'segment:/unselected',
        contentType: options.unusedType ?? 'text/x-component',
      },
    ],
  };
  const bytes = encodeGenerationPack(header, html, postponed);
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('the metadata record must decode');
  return { bytes, pack: decoded.pack, document };
}

async function fixture(copies = false, headerRules?: HeaderRule[]) {
  const document = pprDocument();
  const site = await seedSite({ document, headerRules });
  const settings = {
    ...DEFAULT_RUNTIME_CACHE_SETTINGS,
    generations: 'on' as const,
    holdMs: 5000,
    cacheApiMaxAgeMs: copies ? 1000 : 0,
  };
  const manifest = {
    ...site.manifest,
    cache: { keySchemaVersion: 1 as const, scopeId: KEY.scopeId },
    routes: {
      '/': {
        ...site.manifest.routes['/']!,
        cache: { entryId: KEY.entryId, kind: 'app-page' as const, delivery: 'resume' as const },
      },
    },
  };
  const dispatch = vi.fn((_script: string, request: Request) => {
    const body = request.headers.has(NEXT_RESUME_HEADER) ? document.suffix : FALLBACK;
    return Promise.resolve(
      htmlResponse(body, { headers: { 'cache-control': 'private, no-store' } }),
    );
  });
  const runtime = standaloneRuntime(env, {
    now: () => NOW,
    memory: createEdgeMemory(() => NOW),
    dispatchApp: dispatch,
  });
  runtime.memory.shells.set(
    manifest.routes['/'].shell.sha256,
    document.shell,
    document.shell.byteLength,
  );
  const host = standaloneHost(env);
  const points: EdgeMetric[] = [];
  const edge: EdgeContext = {
    env,
    ctx: createExecutionContext(),
    runtime,
    host: {
      ...host,
      observer: {
        ...host.observer,
        metric(point) {
          points.push(point);
        },
      },
    },
    forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
    app: site.pointer.app,
    originalUrl: undefined,
    policy: { ...DEFAULT_DELIVERY_POLICY, runtimeCache: settings },
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: true,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: site.manifestId,
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
  };
  const cache = await caches.open(edge.host.names.recordCache);
  vi.spyOn(caches, 'open').mockResolvedValue(cache);
  const match = vi.spyOn(cache, 'match').mockResolvedValue(undefined);
  const get = vi.spyOn(env.CACHE_STATE, 'get');
  const artifactGet = vi.spyOn(env.ARTIFACTS, 'get');
  await env.ARTIFACTS.put(PART_KEY, PART);
  return { edge, site, manifest, dispatch, match, get, artifactGet, points };
}

async function seed(saved: Awaited<ReturnType<typeof record>>) {
  await env.CACHE_STATE.put(RECORD_KEY, saved.bytes);
}

function serve(test: Awaited<ReturnType<typeof fixture>>, part = false, method = 'GET') {
  const request = navigation('/', {
    method,
    headers: part ? { rsc: '1', 'next-router-prefetch': '1' } : {},
  });
  return serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx: test.edge.ctx,
      runtime: test.edge.runtime,
      host: test.edge.host,
      pointer: test.site.pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: test.manifest }),
      policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: test.edge.policy }),
    },
  );
}

describe('replaying generation response metadata at its use boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(INVALID_VALUES)(
    'hands a retained document with malformed CSP %j to the whole Function',
    async (value) => {
      const test = await fixture();
      const saved = await record({ headers: { [CSP]: value } });
      await seed(saved);

      const response = await serve(test);
      const held = test.edge.runtime.memory.generations.get(RECORD_KEY);
      const warm = await serve(test);

      expect(await response.text()).toBe(FALLBACK);
      expect(await warm.text()).toBe(FALLBACK);
      expect(response.headers.get(CSP)).toBeNull();
      expect(response.headers.get('cache-control')).toContain('private');
      expect(test.dispatch).toHaveBeenCalledTimes(2);
      expect(test.dispatch.mock.calls[0]?.[1].headers.has(NEXT_RESUME_HEADER)).toBe(false);
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.headers[CSP]).toBe(
        value,
      );
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)).toBe(held);
      expect(test.get.mock.calls.filter(([key]) => key === RECORD_KEY)).toHaveLength(1);
      await waitOnExecutionContext(test.edge.ctx);
      expect(test.points.map((point) => point.subrequests)).toStrictEqual([1, 1]);
    },
  );

  it('does not dispatch a resume before declining a partial record with invalid replay metadata', async () => {
    const test = await fixture();
    await seed(await record({ partial: true, headers: { [CSP]: 'default-src a\0b' } }));

    const response = await serve(test);

    expect(await response.text()).toBe(FALLBACK);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.dispatch.mock.calls[0]?.[1].headers.has(NEXT_RESUME_HEADER)).toBe(false);
    await waitOnExecutionContext(test.edge.ctx);
  });

  it('keeps the same fallback when a valid configured policy would override a malformed recorded policy', async () => {
    const test = await fixture(false, [
      { sourceRegex: '^/$', headers: { [CSP]: "default-src 'self'" } },
    ]);
    await seed(await record({ headers: { [CSP]: 'a\0b' } }));

    const response = await serve(test);

    expect(await response.text()).toBe(FALLBACK);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.dispatch.mock.calls[0]?.[1].headers.has(NEXT_RESUME_HEADER)).toBe(false);
    await waitOnExecutionContext(test.edge.ctx);
  });

  it('protects document replay from a young Cache API copy when KV fails', async () => {
    const test = await fixture(true);
    const saved = await record({ headers: { [CSP]: 'a\rb' } });
    test.match.mockResolvedValue(
      new Response(saved.bytes, {
        headers: { 'x-arkor-kept-at': String(NOW), 'x-arkor-revision': '3' },
      }),
    );
    test.get.mockRejectedValue(new Error('KV is unavailable'));

    const response = await serve(test);

    expect(await response.text()).toBe(FALLBACK);
    expect(test.match).toHaveBeenCalledTimes(1);
    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.headers[CSP]).toBe(
      'a\rb',
    );
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    await waitOnExecutionContext(test.edge.ctx);
  });

  it.each(INVALID_VALUES)(
    'hands a selected runtime part type containing %j to the Function',
    async (value) => {
      const test = await fixture();
      await seed(await record({ contentType: `text/x-component; name=${value}` }));

      const response = await serve(test, true);

      expect(await response.text()).toBe(FALLBACK);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
      expect(test.artifactGet).toHaveBeenCalledTimes(1);
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.source).toBe(
        'runtime',
      );
      await waitOnExecutionContext(test.edge.ctx);
    },
  );

  it('preserves a recorded security policy by falling back instead of silently dropping it from a part', async () => {
    const test = await fixture();
    await seed(await record({ headers: { [CSP]: 'default-src a\0b' } }));

    const response = await serve(test, true);

    expect(await response.text()).toBe(FALLBACK);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.artifactGet).toHaveBeenCalledTimes(1);
    await waitOnExecutionContext(test.edge.ctx);
  });

  it('protects a selected part type from a retained Cache API record with the default shell layers enabled', async () => {
    const test = await fixture(true);
    const saved = await record({ contentType: 'text/x-component; a\0b' });
    test.match.mockResolvedValue(
      new Response(saved.bytes, {
        headers: { 'x-arkor-kept-at': String(NOW), 'x-arkor-revision': '3' },
      }),
    );
    test.get.mockRejectedValue(new Error('KV is unavailable'));

    const response = await serve(test, true);

    expect(await response.text()).toBe(FALLBACK);
    expect(test.edge.policy.shell.cacheApiLayer).toBe(true);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.artifactGet).toHaveBeenCalledTimes(1);
    expect(test.edge.runtime.memory.generations.get(RECORD_KEY)?.pack.header.source).toBe(
      'runtime',
    );
    await waitOnExecutionContext(test.edge.ctx);
  });

  it('keeps ignored document fields and unselected artifact types harmless', async () => {
    const test = await fixture();
    await seed(
      await record({
        headers: { 'x-not-replayed': 'a\0b' },
        unusedType: 'text/x-component; a\rb',
      }),
    );

    const document = await serve(test);

    expect(await document.text()).toBe(new TextDecoder().decode(HTML));
    expect(document.headers.get('x-not-replayed')).toBeNull();
    expect(test.dispatch).not.toHaveBeenCalled();
    await waitOnExecutionContext(test.edge.ctx);
  });

  it('does not replay the document entity type when the selected part owns a valid type', async () => {
    const test = await fixture();
    await seed(await record({ headers: { 'content-type': 'text/html; a\0b' } }));

    const response = await serve(test, true);

    expect(await response.text()).toBe(new TextDecoder().decode(PART));
    expect(response.headers.get('content-type')).toBe('text/x-component');
    expect(test.dispatch).not.toHaveBeenCalled();
    await waitOnExecutionContext(test.edge.ctx);
  });

  it('does not reject a document because an unrequested Flight representation has an invalid type', async () => {
    const test = await fixture();
    await seed(await record({ contentType: 'text/x-component; a\0b' }));

    const response = await serve(test);

    expect(await response.text()).toBe(new TextDecoder().decode(HTML));
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(test.dispatch).not.toHaveBeenCalled();
    expect(test.artifactGet).not.toHaveBeenCalled();
    await waitOnExecutionContext(test.edge.ctx);
  });

  it.each([
    { value: '日本語', expected: '日本語' },
    { value: ' \tvalid policy\t ', expected: 'valid policy' },
  ])(
    'keeps native document header normalization for $value on cold and warm reads',
    async ({ value, expected }) => {
      const test = await fixture();
      await seed(await record({ headers: { [CSP]: value } }));

      const first = await serve(test);
      const held = test.edge.runtime.memory.generations.get(RECORD_KEY);
      const second = await serve(test);

      expect(await first.text()).toBe(new TextDecoder().decode(HTML));
      expect(await second.text()).toBe(new TextDecoder().decode(HTML));
      expect(first.headers.get(CSP)).toBe(expected);
      expect(second.headers.get(CSP)).toBe(expected);
      expect(test.edge.runtime.memory.generations.get(RECORD_KEY)).toBe(held);
      expect(test.get.mock.calls.filter(([key]) => key === RECORD_KEY)).toHaveLength(1);
      expect(test.artifactGet).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
      await waitOnExecutionContext(test.edge.ctx);
    },
  );

  it.each([
    { value: 'text/x-component; name="日本語"', expected: 'text/x-component; name="日本語"' },
    { value: ' \ttext/x-component\t ', expected: 'text/x-component' },
  ])('keeps a selected native part type $value and its warm bytes', async ({ value, expected }) => {
    const test = await fixture();
    await seed(await record({ contentType: value, unusedType: 'text/x-component; a\0b' }));

    const first = await serve(test, true);
    const second = await serve(test, true);

    expect(await first.text()).toBe(new TextDecoder().decode(PART));
    expect(await second.text()).toBe(new TextDecoder().decode(PART));
    expect(first.headers.get('content-type')).toBe(expected);
    expect(second.headers.get('content-type')).toBe(expected);
    expect(test.get.mock.calls.filter(([key]) => key === RECORD_KEY)).toHaveLength(1);
    expect(test.artifactGet).toHaveBeenCalledTimes(1);
    expect(test.dispatch).not.toHaveBeenCalled();
    await waitOnExecutionContext(test.edge.ctx);
  });

  it.each([302, 304])(
    'keeps an unusable status %s on the existing application path',
    async (status) => {
      const test = await fixture();
      await seed(await record({ status, headers: { [CSP]: 'a\0b' } }));

      const response = await serve(test);

      expect(await response.text()).toBe(FALLBACK);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
      expect(test.artifactGet).not.toHaveBeenCalled();
      await waitOnExecutionContext(test.edge.ctx);
    },
  );
});
