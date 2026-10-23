import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  FUNCTION_HEADER,
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  MIDDLEWARE_DONE_HEADER,
  MISDIRECTED_STATUS,
} from '@stayingupwind/core/paas';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { takeInvalidation, transferInvalidations } from '../src/cache/condemned.ts';
import { handlePassthrough } from '../src/handlers/passthrough.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { PolicyLookup } from '../src/preview/manifest.ts';
import type { Lookup } from '../src/preview/storage.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const HIGH_SURROGATE_UNIT = 55_296;
const LONE_HIGH_SURROGATE = String.fromCodePoint(HIGH_SURROGATE_UNIT);

const POLICY: PolicyLookup = {
  kind: 'found',
  source: 'exact',
  policy: DEFAULT_DELIVERY_POLICY,
};

/** An already available manifest. */
function availableManifest(stored: Lookup<ProjectManifest>): Promise<Lookup<ProjectManifest>> {
  return Promise.resolve(stored);
}

/** A manifest the test will release only once its Action has answered. */
function pendingManifest(
  _stored: Lookup<ProjectManifest>,
  pending: Promise<Lookup<ProjectManifest>>,
): Promise<Lookup<ProjectManifest>> {
  return pending;
}

/** A fresh tagged generation that an Action invalidates while its own manifest is still out. */
async function oldGeneration(scopeId: string) {
  const html = new TextEncoder().encode('<html><body>old cached generation</body></html>');
  const timestamp = Date.now();
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId,
      entryId: 'entry-race',
      generationId: 'gen_race_1',
      seq: 1,
      source: 'build',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: timestamp,
      producedAt: timestamp,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      tags: [{ kind: 'next-explicit', value: 'posts' }],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
      revision: 1,
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('the fixture generation did not decode');
  return { bytes, pack: decoded.pack, readAt: timestamp };
}

describe('passthrough before unused pointer reads', () => {
  it.each([
    { method: 'POST', action: true, reason: 'action' },
    { method: 'POST', action: false, reason: 'method' },
    { method: 'PUT', action: false, reason: 'method' },
    { method: 'DELETE', action: false, reason: 'method' },
    { method: 'OPTIONS', action: false, reason: 'method' },
  ])('dispatches $method (action=$action) while both reads are pending', async (example) => {
    const site = await seedSite({ document: pprDocument() });
    const manifest = Promise.withResolvers<Lookup<ProjectManifest>>();
    const policy = Promise.withResolvers<PolicyLookup>();
    const ctx = createExecutionContext();
    const asked: Request[] = [];
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (_script, request) => {
        asked.push(request);
        return Promise.resolve(
          new Response('saved', {
            headers: {
              'content-type': 'text/html',
              'content-security-policy': "default-src 'self'",
            },
          }),
        );
      },
    });
    const request = navigation('/api/items', {
      method: example.method,
      body: 'streamed payload',
      headers: {
        ...(example.action && { 'next-action': 'save-item' }),
        cookie: 'host_session=secret; theme=dark',
        'x-middleware-done': 'untrusted',
        [MIDDLEWARE_DONE_HEADER]: 'untrusted',
      },
    });
    const response = serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
        host: {
          ...standaloneHost(env),
          credentials: { cookies: ['host_session'], headers: [] },
        },
        pointer: site.pointer,
        pointerMs: 0,
        privateDelivery: true,
        cspReportingPath: '/reports/csp',
      },
      { manifestLookup: manifest.promise, policyLookup: policy.promise },
    );
    try {
      // Dispatch starts synchronously; neither promise is released until the answer is checked.
      expect(asked).toHaveLength(1);
      expect({
        cookie: asked[0]?.headers.get('cookie'),
        middleware: asked[0]?.headers.get(MIDDLEWARE_DONE_HEADER),
        internal: asked[0]?.headers.get('x-middleware-done'),
      }).toStrictEqual({ cookie: 'theme=dark', middleware: null, internal: null });
      await expect(asked[0]?.text()).resolves.toBe('streamed payload');

      const answer = await response;

      await expect(answer.text()).resolves.toBe('saved');
      expect(answer.headers.get('x-arkor-edge')).toBe(`passthrough;reason=${example.reason}`);
      expect(answer.headers.get('cache-control')).toContain('no-store');
      expect(answer.headers.get('content-security-policy')).toContain('report-uri /reports/csp');
    } finally {
      manifest.resolve({ kind: 'found', value: site.manifest });
      policy.resolve(POLICY);
      await waitOnExecutionContext(ctx);
    }
  });

  it.each([
    { state: 'pending', read: pendingManifest, before: undefined, provisional: 7 },
    { state: 'available', read: availableManifest, before: 7, provisional: undefined },
  ])('keeps action invalidations when the manifest is $state', async (example) => {
    const site = await seedSite({ document: pprDocument() });
    const manifest = Promise.withResolvers<Lookup<ProjectManifest>>();
    const policy = Promise.withResolvers<PolicyLookup>();
    const stored: Lookup<ProjectManifest> = {
      kind: 'found',
      value: {
        ...site.manifest,
        cache: { keySchemaVersion: 1, scopeId: 'scope-of-the-manifest' },
      },
    };
    const ctx = createExecutionContext();
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: () => {
        return Promise.resolve(
          new Response('updated', {
            headers: { [INVALIDATED_TAGS_HEADER]: 'posts', [INVALIDATED_REVISION_HEADER]: '7' },
          }),
        );
      },
    });
    const request = navigation('/', {
      method: 'POST',
      headers: { 'next-action': 'update-post' },
    });
    try {
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
          manifestLookup: example.read(stored, manifest.promise),
          policyLookup: policy.promise,
        },
      );

      await expect(response.text()).resolves.toBe('updated');
      expect(response.headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
      // A later request may finish its own manifest read first. The deployment's own scope
      // must already reject its older generations before this Action returns to its caller.
      expect(
        runtime.memory.invalidations.of(site.pointer.app!.deploymentId)?.tags.get('posts'),
      ).toBe(example.provisional);

      expect(runtime.memory.invalidations.of('scope-of-the-manifest')?.tags.get('posts')).toBe(
        example.before,
      );
    } finally {
      manifest.resolve(stored);
      policy.resolve(POLICY);
      await waitOnExecutionContext(ctx);
    }

    expect(runtime.memory.invalidations.of('scope-of-the-manifest')?.tags.get('posts')).toBe(7);
  });

  it('invalidates a distinct cache scope when the next GET resolves its manifest first', async () => {
    const site = await seedSite({ document: pprDocument() });
    const scopeId = 'actual-cold-manifest-race';
    const generation = await oldGeneration(scopeId);
    const recordKey = kvGenerationKey(scopeId, 'entry-race');
    await env.CACHE_STATE.put(recordKey, generation.bytes);
    const held = Promise.withResolvers<Lookup<ProjectManifest>>();
    const policy = Promise.withResolvers<PolicyLookup>();
    const stored: Lookup<ProjectManifest> = {
      kind: 'found',
      value: {
        ...site.manifest,
        cache: { keySchemaVersion: 1, scopeId },
        routes: {
          '/': {
            ...site.manifest.routes['/']!,
            cache: { entryId: 'entry-race', kind: 'app-page', delivery: 'complete' },
          },
        },
      },
    };
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (_script, request) => {
        return Promise.resolve(
          new Response(request.headers.has('next-action') ? 'updated' : 'fresh generated page', {
            headers: { [INVALIDATED_TAGS_HEADER]: 'posts', [INVALIDATED_REVISION_HEADER]: '7' },
          }),
        );
      },
    });
    runtime.memory.generations.set(
      recordKey,
      {
        pack: generation.pack,
        bytes: generation.bytes.byteLength,
        readAt: generation.readAt,
      },
      generation.bytes.byteLength,
    );
    const actionCtx = createExecutionContext();
    const nextCtx = createExecutionContext();
    const common = {
      env,
      runtime,
      host: standaloneHost(env),
      pointer: { ...site.pointer, cacheApi: false as const },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    };
    const action = navigation('/', { method: 'POST', headers: { 'next-action': 'update-post' } });
    try {
      const answer = await serveFromPointer(
        {
          ...common,
          request: action,
          url: new URL(action.url),
          ctx: actionCtx,
        },
        { manifestLookup: held.promise, policyLookup: policy.promise },
      );

      await expect(answer.text()).resolves.toBe('updated');

      const next = navigation('/');
      const response = await serveFromPointer(
        {
          ...common,
          request: next,
          url: new URL(next.url),
          ctx: nextCtx,
        },
        { manifestLookup: Promise.resolve(stored), policyLookup: Promise.resolve(POLICY) },
      );

      await expect(response.text()).resolves.toBe('fresh generated page');
      expect(response.headers.get('x-arkor-edge')).toContain('reason=regenerate');
      expect(runtime.memory.generations.get(recordKey)).toBeUndefined();
      expect(runtime.memory.invalidations.of(scopeId)?.tags.get('posts')).toBe(7);
    } finally {
      held.resolve(stored);
      policy.resolve(POLICY);
      await Promise.all([waitOnExecutionContext(actionCtx), waitOnExecutionContext(nextCtx)]);
    }
  });

  it('drops held records on a transfer of a legacy revisionless notification', async () => {
    const memory = createEdgeMemory(() => Date.now());
    const generation = await oldGeneration('actual-legacy-scope');
    const key = kvGenerationKey('actual-legacy-scope', 'entry-race');
    memory.generations.set(
      key,
      {
        pack: generation.pack,
        bytes: generation.bytes.byteLength,
        readAt: generation.readAt,
      },
      generation.bytes.byteLength,
    );

    takeInvalidation(memory, 'deployment', { value: 'posts', bound: null });
    transferInvalidations(memory, 'deployment', 'actual-legacy-scope');

    expect(memory.generations.get(key)).toBeUndefined();
    expect(memory.invalidations.absencesHeldFrom('actual-legacy-scope')).toBeGreaterThan(
      generation.readAt,
    );
    expect(memory.invalidations.of('deployment')).toBeUndefined();
  });

  it.each(['range', 'service-worker'])('dispatches a %s GET without the policy', async (header) => {
    const site = await seedSite({ document: pprDocument() });
    const policy = Promise.withResolvers<PolicyLookup>();
    const ctx = createExecutionContext();
    const asked: string[] = [];
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (script) => {
        asked.push(script);
        return Promise.resolve(new Response('from the Function'));
      },
    });
    const request = navigation('/', { headers: { [header]: '1' } });
    const response = serveFromPointer(
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
        policyLookup: policy.promise,
      },
    );
    try {
      // Let the ready manifest's continuation run, while leaving the policy unresolved.
      await Promise.resolve();

      expect(asked).toHaveLength(1);

      const answer = await response;

      await expect(answer.text()).resolves.toBe('from the Function');
      expect(answer.headers.get('x-arkor-edge')).toBe(`passthrough;reason=${header}`);
    } finally {
      policy.resolve(POLICY);
      await waitOnExecutionContext(ctx);
    }
  });

  it('waits for split routing tables but dispatches without the policy', async () => {
    const site = await seedSite({ document: pprDocument() });
    const app = { ...site.pointer.app!, functions: { 'app-2': 'site-app-2' } };
    const manifest = Promise.withResolvers<Lookup<ProjectManifest>>();
    const policy = Promise.withResolvers<PolicyLookup>();
    const ctx = createExecutionContext();
    const asked: string[] = [];
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (script) => {
        asked.push(script);
        return Promise.resolve(new Response('saved by split Function'));
      },
    });
    const request = navigation('/api/items', { method: 'POST' });
    const response = serveFromPointer(
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
      { manifestLookup: manifest.promise, policyLookup: policy.promise },
    );
    try {
      expect(asked).toHaveLength(0);

      manifest.resolve({
        kind: 'found',
        value: {
          ...site.manifest,
          app,
          exactPathnames: { '/api/items': true },
          exactFunctions: { '/api/items': 'app-2' },
        },
      });
      const answer = await response;

      await expect(answer.text()).resolves.toBe('saved by split Function');
      expect(asked).toStrictEqual(['site-app-2']);
    } finally {
      policy.resolve(POLICY);
      await waitOnExecutionContext(ctx);
    }
  });
});

describe.each(['passthrough', 'disabled'] as const)('opaque reasons in %s pointers', (mode) => {
  it.each([
    { reason: 'ordinary-reason', encoded: 'ordinary-reason' },
    { reason: '理由\r\n', encoded: '%E7%90%86%E7%94%B1%5Cr%5Cn' },
    { reason: `semi;percent%${LONE_HIGH_SURROGATE}`, encoded: 'semi%3Bpercent%25%5Cud800' },
  ])('answers with the diagnostic field $encoded', async (example) => {
    const site = await seedSite({ document: pprDocument() });
    const ctx = createExecutionContext();
    const request = navigation('/');
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: () => Promise.resolve(new Response('from the Function')),
    });
    try {
      const response = await serveFromPointer(
        {
          request,
          url: new URL(request.url),
          env,
          ctx,
          runtime,
          host: standaloneHost(env),
          pointer: { ...site.pointer, mode, reason: example.reason },
          pointerMs: 0,
          privateDelivery: false,
          cspReportingPath: undefined,
        },
        {
          manifestLookup: Promise.resolve({ kind: 'found', value: site.manifest }),
          policyLookup: Promise.resolve(POLICY),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(`passthrough;reason=${example.encoded}`);
      await expect(response.text()).resolves.toBe('from the Function');
    } finally {
      await waitOnExecutionContext(ctx);
    }
  });
});

describe('the dispatches a passthrough records', () => {
  it.each([
    { kind: 'missing-app', sent: 0, status: 502, fn: undefined },
    { kind: 'missing-dispatch', sent: 0, status: 502, fn: undefined },
    { kind: 'answered', sent: 1, status: 200, fn: undefined },
    { kind: 'failed', sent: 1, status: 502, fn: undefined },
    { kind: 'redispatched', sent: 2, status: 200, fn: 'app-2' },
    { kind: 'redispatch-failed', sent: 2, status: 502, fn: 'app-2' },
    { kind: 'misrouted', sent: 1, status: 502, fn: 'app' },
    { kind: 'replaced', sent: 1, status: 200, fn: undefined },
  ])('counts only requests sent when $kind', async (example) => {
    const points: EdgeMetric[] = [];
    const calls: string[] = [];
    const base = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
    const host = standaloneHost(env);
    const split = example.kind.startsWith('redispatch') || example.kind === 'misrouted';
    const app = { deploymentId: 'dpl_counted', scriptName: 'counted-app' };
    const response = await handlePassthrough({
      request: new Request('https://customer.example.test/api/items'),
      forwarding: {
        previewDomain: 'example.test',
        previewHost: 'customer.example.test',
        clientIp: undefined,
      },
      app:
        example.kind === 'missing-app'
          ? undefined
          : { ...app, ...(split && { functions: { 'app-2': 'counted-app-2' } }) },
      runtime: {
        ...base,
        dispatchApp:
          example.kind === 'missing-dispatch'
            ? undefined
            : (script) => {
                calls.push(script);
                if (split && script === app.scriptName) {
                  return Promise.resolve(
                    new Response(null, {
                      status: MISDIRECTED_STATUS,
                      headers: {
                        [FUNCTION_HEADER]: example.kind === 'misrouted' ? 'absent' : 'app-2',
                      },
                    }),
                  );
                }
                return example.kind.endsWith('failed') || example.kind === 'replaced'
                  ? Promise.reject(new Error('the dispatched Function could not answer'))
                  : Promise.resolve(new Response('answered'));
              },
      },
      host: {
        ...host,
        functionGone: () => example.kind === 'replaced',
        observer: {
          ...host.observer,
          metric: (point) => {
            points.push(point);
          },
        },
      },
      whenGone: () => Promise.resolve(new Response('replacement')),
      reason: 'route-not-proved',
      metrics: {
        projectId: 'project-counted',
        manifestId: 'manifest-counted',
        policyId: 'policy-counted',
        pathname: '/api/items',
        colo: '',
        storageReads: 3,
        resumeDispatches: 2,
        assetDispatches: 1,
      },
    });

    expect(response.status).toBe(example.status);
    expect(calls).toHaveLength(example.sent);
    expect(points).toHaveLength(1);
    expect(points[0]?.subrequests).toBe(6 + example.sent);
    expect(points[0]?.fn).toBe(example.fn);
    expect(points[0]?.redispatch).toBe(example.sent === 2 ? 1 : 0);

    await response.body?.cancel();
  });
});
