import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry, packBodyDigests, policyFromBuild } from '@stayingupwind/core/cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { requestContextFor } from '../src/cache/context.ts';
import { observeFreshPublication } from '../src/cache/publication.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { admitRequestPublication, requirePublication } from '../src/publication.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const NOW = 1_800_000_000_000;
const ROUTE = '/items';
const ID = 'a'.repeat(64);
const GRANT = `upwind:publication:v1:${ID}:${String(NOW + 1000)}`;
const bytes = (value: string) => new TextEncoder().encode(value);
const handler: NodeHandler = () => Promise.resolve();

async function scenario(postponed: boolean, version: 1 | 2 = 1, method = 'GET') {
  const runtime = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: 'seeded-publication',
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.test',
      ARKOR_CACHE_TOKEN: 'test-token',
    },
    now: () => NOW,
    fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
  });
  if (runtime === undefined) throw new Error('The seeded fixture must have a cache runtime.');
  Object.assign(runtime.host, {
    publication: {
      version,
      ...(version === 2 && { valueObservers: true }),
      identities: [ID],
      routes: [ROUTE],
      independentBuild: [ROUTE],
    },
  });
  const request = new Request(`https://fixture.test${ROUTE}`, { method });
  const tables = { app: { entries: {} }, edge: { entries: {} } };
  const context = requestContextFor({
    tables,
    runtime,
    request,
    startedAt: NOW,
    waitUntil: vi.fn(),
    clock: version === 2 ? undefined : NOW,
  });
  const input: RoutedInput = {
    ...tables,
    cache: runtime,
    request,
    initURL: request.url,
    run: context.run,
    waitUntil: vi.fn(),
  };
  const shell: Prerender = {
    id: ROUTE,
    route: ROUTE,
    pathname: ROUTE,
    parentOutputId: ROUTE,
    groupId: 0,
    body: { sha256: 'build', byteLength: 12, contentType: 'text/html' },
  };
  const store = {
    manifest: {
      buildId: 'build',
      config: { basePath: '' },
      entrypoints: [{ pathname: ROUTE, kind: 'app-page' }],
      routing: { rsc: { prefetchSegmentHeader: 'next-router-segment-prefetch' } },
    },
    prerendersByPathname: new Map([[ROUTE, shell]]),
    shellsByRoute: new Map([[ROUTE, { pages: new Map([[ROUTE, shell]]), patterns: [] }]]),
  } as unknown as Store;
  const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: ROUTE };
  const { entryId } = await deriveEntry(runtime.scopeId, descriptor);
  const html = bytes('seeded shell');
  const state = postponed ? bytes('saved') : undefined;
  runtime.recordMemo.set(entryId, {
    header: {
      schemaVersion: 1,
      scopeId: runtime.scopeId,
      entryId,
      generationId: 'seeded',
      seq: 1,
      revision: 1,
      source: 'build',
      ...descriptor,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: [],
      artifacts: [],
      ...(await packBodyDigests(html, state)),
    },
    html,
    postponed: state,
  });
  const readRecord = vi.spyOn(runtime.host, 'readRecord');
  const render = () => {
    return context.run(async () => {
      requirePublication(runtime, ROUTE);
      const selected = await serveFromGeneration(
        input,
        store,
        { ...descriptor, url: ROUTE, representation: 'html', onMiss: 'build' },
        handler,
      );
      if (selected === undefined) throw new Error('The seeded generation must answer.');
      return admitRequestPublication(selected, context);
    });
  };
  return { context, render, readRecord };
}

describe('publication of seeded build generations', () => {
  beforeEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps a complete independently proven build response without a live grant', async () => {
    const test = await scenario(false);
    const response = await test.render();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('seeded shell');
    expect(invokeNodeHandler).not.toHaveBeenCalled();
    expect(test.readRecord).not.toHaveBeenCalled();
  });

  it('keeps a seeded partial HEAD independent when it renders no live suffix', async () => {
    const test = await scenario(true, 1, 'HEAD');
    const response = await test.render();

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
    expect(test.readRecord).not.toHaveBeenCalled();
  });

  it('refuses an ungranted live continuation instead of exempting the combined response', async () => {
    const test = await scenario(true);
    vi.mocked(invokeNodeHandler).mockResolvedValueOnce(new Response('ungranted live suffix'));

    const response = await test.render();

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Publication unavailable');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(test.readRecord).not.toHaveBeenCalled();
  });

  it('streams the seeded shell before its existing resume resolves and fences expired suffix bytes', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(NOW - performance.timeOrigin);
    const test = await scenario(true, 2);
    const pending = Promise.withResolvers<Response>();
    const suffix = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    vi.mocked(invokeNodeHandler).mockReturnValueOnce(pending.promise);
    const response = await test.render();
    const reader = response.body!.getReader();

    expect(response.status).toBe(200);
    await expect(reader.read()).resolves.toMatchObject({ value: bytes('seeded shell') });
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(test.readRecord).not.toHaveBeenCalled();

    await test.context.run(() => {
      observeFreshPublication([GRANT], NOW);
      return Promise.resolve();
    });

    pending.resolve(new Response(new ReadableStream<Uint8Array>({ start: suffix.resolve })));
    const controller = await suffix.promise;
    controller.enqueue(bytes('current suffix'));

    await expect(reader.read()).resolves.toMatchObject({ value: bytes('current suffix') });

    clock.mockReturnValue(NOW + 1000 - performance.timeOrigin);
    controller.enqueue(bytes('expired suffix'));
    controller.close();

    await expect(reader.read()).rejects.toThrow('Publication unavailable');
  });
});
