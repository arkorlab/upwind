import type { Prerender } from '@stayingupwind/core/bundle';
import { observePublicationTags } from '@stayingupwind/core/paas';
import { describe, expect, it, vi } from 'vitest';

import { answerWith } from '../src/answers.ts';
import { publicationRun, requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { notFound } from '../src/documents.ts';
import { entryFor } from '../src/entries.ts';
import { admitRequestPublication, requirePublication } from '../src/publication.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/entries.ts'), () => {
  return {
    entryFor: vi.fn((_input: unknown, route: string) =>
      Promise.resolve(route === '/404' ? { kind: 'node' as const, handler: vi.fn() } : undefined),
    ),
  };
});

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const GRANT = `upwind:publication:v1:${ID}:${String(NOW + 60_000)}`;

function context(route: string, independent = false, rsc = false) {
  const cache = {
    host: {
      publication: {
        version: 1,
        identities: [ID],
        routes: [route],
        ...(independent && { independentBuild: [route] }),
      },
    },
  } as unknown as CacheRuntime;
  const request = new Request('https://fixture.test/missing', { headers: rsc ? { RSC: '1' } : {} });
  const state = requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime: cache,
    request,
    startedAt: NOW,
    clock: NOW,
    waitUntil: vi.fn(),
  });
  const input = { request, cache, run: state.run, waitUntil: vi.fn() } as RoutedInput;
  return { state, input };
}

describe('publication of the selected output', () => {
  it('observes a fresh route-body grant before response header filtering loses it', async () => {
    const { state, input } = context('/api/items');
    const answer = await state.run(async () => {
      requirePublication(input.cache, '/api/items');
      const headers = await publicationRun(state.run)(() => {
        observePublicationTags([GRANT]);
        return Promise.resolve({ 'x-next-cache-tags': GRANT, 'content-type': 'application/json' });
      });

      expect(state.publication.size).toBe(0);

      return admitRequestPublication(
        answerWith(input, vi.fn(), {
          representation: 'route-body',
          url: '/api/items',
          body: new TextEncoder().encode('fresh'),
          postponed: undefined,
          partial: false,
          status: 200,
          cache: 'MISS',
          headers,
        }),
        state,
      );
    });

    expect(answer.status).toBe(200);
    await expect(answer.text()).resolves.toBe('fresh');
  });

  it.each([false, true])(
    'preserves only the selected not-found RSC independent proof (independent=%s)',
    async (independent) => {
      const route = '/_not-found';
      const { state, input } = context(route, independent, true);
      vi.mocked(entryFor).mockResolvedValueOnce({ kind: 'node', handler: vi.fn() });
      const built: Prerender = {
        id: 'not-found',
        route,
        pathname: route,
        parentOutputId: 'not-found',
        groupId: 0,
        body: { sha256: 'html', byteLength: 4, contentType: 'text/html' },
      };
      const payload: Prerender = {
        ...built,
        id: 'not-found-rsc',
        pathname: `${route}.rsc`,
        body: { sha256: 'rsc', byteLength: 7, contentType: 'text/x-component' },
      };
      const store = {
        manifest: {
          config: { basePath: '' },
          bypassToken: 'draft',
          routing: {
            rsc: { prefetchSegmentHeader: 'next-router-segment-prefetch', varyHeader: 'RSC' },
          },
        },
        shellsByRoute: new Map([[route, { pages: new Map([[route, built]]), patterns: [] }]]),
        prerendersByPathname: new Map([[`${route}.rsc`, payload]]),
        readBlob: () => new TextEncoder().encode('404 RSC'),
      } as unknown as Store;
      const response = await state.run(async () =>
        admitRequestPublication(await notFound(input, store, new URL(input.request.url)), state),
      );

      expect(response.status).toBe(independent ? 404 : 503);
      await expect(response.text()).resolves.toBe(
        independent ? '404 RSC' : 'Publication unavailable',
      );
    },
  );

  it.each([false, true])(
    'protects an unrouted custom 404 and honors only its actual independent build proof (independent=%s)',
    async (independent) => {
      const { state, input } = context('/404', independent);
      const built: Prerender = {
        id: 'not-found',
        route: '/404',
        pathname: '/404',
        parentOutputId: 'not-found',
        groupId: 0,
        body: { sha256: 'body', byteLength: 14, contentType: 'text/html' },
        initialStatus: 404,
      };
      const store = {
        manifest: { config: { basePath: '' }, bypassToken: 'draft' },
        staticFiles: new Map(),
        prerendersByPathname: new Map([['/404', built]]),
        readBlob: () => new TextEncoder().encode('custom 404 data'),
      } as unknown as Store;
      const answer = await state.run(async () => {
        return admitRequestPublication(
          await notFound(input, store, new URL(input.request.url)),
          state,
        );
      });

      expect(answer.status).toBe(independent ? 404 : 503);
      await expect(answer.text()).resolves.toBe(
        independent ? 'custom 404 data' : 'Publication unavailable',
      );
    },
  );
});
