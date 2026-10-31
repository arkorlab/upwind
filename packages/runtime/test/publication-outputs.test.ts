import type { Prerender } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { servePagesData, serveRouteHandler } from '../src/outputs.ts';
import { admitRequestPublication, requirePublication } from '../src/publication.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

vi.mock(import('../src/entries.ts'), () => {
  return {
    entryFor: vi.fn(() => Promise.resolve({ kind: 'node' as const, handler: vi.fn() })),
    deferredEntryFor: vi.fn(),
  };
});
// The absent generation is a storage boundary; actual output selection and final admission run.
vi.mock(import('../src/generations.ts'), () => {
  return {
    serveFromGeneration: vi.fn(() => Promise.resolve(undefined)),
    speculative: vi.fn(),
  };
});
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: vi.fn(() => {
      return Promise.resolve(
        new Response('live ungranted output', {
          headers: { 'cache-control': 'public,s-maxage=3600' },
        }),
      );
    }),
  };
});

const ROUTE = '/items';
const DATA = '/_next/data/build/items.json';
const NOW = 1_800_000_000_000;
const IDENTITY = 'a'.repeat(64);

function scenario(data: boolean, independent: boolean, draft: boolean, tagged = false) {
  const path = data ? DATA : ROUTE;
  const built = {
    id: 'items',
    route: ROUTE,
    pathname: path,
    routeType: 'route',
    body: { sha256: 'built' },
    initialRevalidate: false,
    initialHeaders: tagged
      ? { 'x-next-cache-tags': `upwind:publication:v1:${IDENTITY}:${String(NOW + 1000)}` }
      : {},
  } as Prerender;
  const shell = { ...built, pathname: ROUTE };
  const store = {
    manifest: { buildId: 'build', config: { basePath: '' }, bypassToken: 'draft' },
    prerendersByPathname: new Map([[path, built]]),
    shellsByRoute: new Map([[ROUTE, { pages: new Map([[ROUTE, shell]]), patterns: [] }]]),
    readBlob: () => new TextEncoder().encode('shipped output'),
  } as unknown as Store;
  const publication = {
    version: 1 as const,
    identities: [IDENTITY],
    routes: [ROUTE],
    ...(independent && { independentBuild: [ROUTE] }),
  };
  const cache = { host: { publication } } as unknown as CacheRuntime;
  const request = new Request(`https://fixture.test${path}`, {
    headers: draft ? { cookie: '__prerender_bypass=draft' } : {},
  });
  const tables = { app: { entries: {} }, edge: { entries: {} } };
  const context = requestContextFor({
    tables,
    runtime: cache,
    request,
    startedAt: NOW,
    waitUntil: vi.fn(),
    clock: NOW,
  });
  const input: RoutedInput = {
    ...tables,
    request,
    cache,
    waitUntil: vi.fn(),
    run: context.run,
    initURL: request.url,
  };
  const resolved = { route: path, pathname: path, url: path };
  return {
    answer: () => {
      return context.run(async () => {
        // This is handle.serveResolved's existing initial check, before canonical data selection.
        requirePublication(cache, resolved.route);
        const response = await (data
          ? servePagesData(input, store, resolved)
          : serveRouteHandler(input, store, resolved));
        return admitRequestPublication(response, context);
      });
    },
  };
}

describe('publication admission for direct shipped output', () => {
  it.each([false, true])(
    'protects canonical Pages data before shipped or draft fallback (draft=%s)',
    async (draft) => {
      const response = await scenario(true, false, draft).answer();

      expect(response.status).toBe(503);
    },
  );

  it('does not let an independent shipped data proof exempt a live draft output', async () => {
    expect((await scenario(true, true, true).answer()).status).toBe(503);
  });

  it.each([false, true])(
    'admits only the selected independent shipped representation (data=%s)',
    async (data) => {
      const response = await scenario(data, true, false).answer();

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('shipped output');
    },
  );

  it('does not let an independent route-handler proof exempt a live draft output', async () => {
    expect((await scenario(false, true, true).answer()).status).toBe(503);
  });

  it('accepts an actual matching grant on a protected shipped data response', async () => {
    expect((await scenario(true, false, false, true).answer()).status).toBe(200);
  });
});
