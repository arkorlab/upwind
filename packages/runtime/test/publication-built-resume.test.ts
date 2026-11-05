import type { Prerender } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import { observeFreshPublication } from '../src/cache/publication.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { rscFromBuild } from '../src/documents.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { admitRequestPublication, requirePublication } from '../src/publication.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const ROUTE = '/items';
const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const WITNESS = `upwind:resource-snapshot:v1:${ID}:4`;
const grant = (expires: number) => `upwind:publication:v1:${ID}:${String(expires)}`;

function scenario(
  source: 'shell' | 'twin',
  expires = NOW + 1000,
  movingClock = false,
  additional: readonly string[] = [],
) {
  const tags = [grant(expires), 'resource:items', WITNESS, ...additional];
  const shell: Prerender = {
    id: 'items',
    route: ROUTE,
    pathname: ROUTE,
    parentOutputId: 'items',
    groupId: 0,
    ...(source === 'shell' && {
      postponed: { sha256: 'state', byteLength: 5, contentType: 'application/json' },
      initialHeaders: { 'x-next-cache-tags': tags },
    }),
  };
  const twin: Prerender = {
    id: 'items-rsc',
    route: ROUTE,
    pathname: `${ROUTE}.rsc`,
    parentOutputId: 'items',
    groupId: 0,
    ...(source === 'twin' && {
      postponed: { sha256: 'state', byteLength: 5, contentType: 'application/json' },
      initialHeaders: { 'x-next-cache-tags': tags },
    }),
  };
  const readBlob = vi.fn(() => new TextEncoder().encode('state'));
  const store = {
    manifest: {
      config: { basePath: '' },
      routing: { rsc: { prefetchSegmentHeader: 'next-router-segment-prefetch' } },
    },
    shellsByRoute: new Map([[ROUTE, { pages: new Map([[ROUTE, shell]]), patterns: [] }]]),
    prerendersByPathname: new Map([[`${ROUTE}.rsc`, twin]]),
    readBlob,
  } as unknown as Store;
  const request = new Request(`https://fixture.test${ROUTE}`, { headers: { RSC: '1' } });
  const cache = {
    host: {
      publication: {
        version: 3,
        valueObservers: true,
        resourceSnapshots: true,
        identities: [ID],
        routes: [ROUTE],
      },
    },
  } as unknown as CacheRuntime;
  const tables = { app: { entries: {} }, edge: { entries: {} } };
  const context = requestContextFor({
    tables,
    runtime: cache,
    request,
    startedAt: NOW,
    clock: movingClock ? undefined : NOW,
    waitUntil: vi.fn(),
  });
  const input: RoutedInput = {
    ...tables,
    request,
    initURL: request.url,
    cache,
    run: context.run,
    waitUntil: vi.fn(),
  };
  const render = () => {
    return context.run(async () => {
      requirePublication(cache, ROUTE);
      const response = await rscFromBuild(input, store, {
        entry: { kind: 'node', handler: vi.fn() },
        resolved: { route: ROUTE, pathname: ROUTE, url: ROUTE },
      });
      return admitRequestPublication(response, context);
    });
  };
  return { context, readBlob, render, tags };
}

describe('publication of saved build state on ordinary RSC navigation', () => {
  it('keeps valid local proof larger than the transport header limit', async () => {
    const additional = Array.from(
      { length: 100 },
      (_, index) => `resource:${String(index)}:${'x'.repeat(100)}`,
    );
    const test = scenario('twin', NOW + 1000, false, additional);
    vi.mocked(invokeNodeHandler).mockImplementationOnce(() => {
      expect(test.context.publication).toContain(test.tags[0]);
      expect(test.context.resourceTags).toContain(additional.at(-1));
      expect(test.context.resourceTags).toContain(WITNESS);

      return Promise.resolve(new Response('saved values from a large local tag set'));
    });

    const response = await test.render();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('saved values from a large local tag set');
  });

  it.each(['shell', 'twin'] as const)(
    'observes the selected %s grant and resource witness before a resume reads saved values',
    async (source) => {
      const test = scenario(source);
      vi.mocked(invokeNodeHandler).mockImplementationOnce(({ requestMeta }) => {
        expect(requestMeta['postponed']).toBe('state');
        expect(test.context.publication).toContain(test.tags[0]);
        expect(test.context.resourceTags).toContain(WITNESS);

        return Promise.resolve(new Response('saved values without another data read'));
      });

      const response = await test.render();

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('saved values without another data read');
    },
  );

  it.each(['shell', 'twin'] as const)(
    'renders whole instead of resuming an expired %s',
    async (source) => {
      const test = scenario(source, NOW);
      vi.mocked(invokeNodeHandler).mockImplementationOnce(({ requestMeta }) => {
        expect(requestMeta['postponed']).toBeUndefined();
        expect(test.context.publication.size).toBe(0);

        observeFreshPublication([grant(NOW + 2000), 'resource:items', WITNESS], NOW);
        return Promise.resolve(new Response('fresh whole render'));
      });

      const response = await test.render();

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('fresh whole render');
      expect(test.readBlob).not.toHaveBeenCalled();
    },
  );

  it('keeps the original earlier deadline when a suffix observes a newer grant', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(NOW - performance.timeOrigin);
    const test = scenario('twin', NOW + 1000, true);
    let suffix: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.mocked(invokeNodeHandler).mockImplementationOnce(() => {
      observeFreshPublication([grant(NOW + 2000), 'resource:items', WITNESS], NOW);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              suffix = controller;
            },
          }),
        ),
      );
    });
    try {
      const response = await test.render();

      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      suffix!.enqueue(new TextEncoder().encode('current suffix'));
      const first = await reader.read();

      expect(new TextDecoder().decode(first.value)).toBe('current suffix');

      clock.mockReturnValue(NOW + 1000 - performance.timeOrigin);
      suffix!.enqueue(new TextEncoder().encode('saved values after their original deadline'));
      suffix!.close();

      await expect(reader.read()).rejects.toThrow('Publication unavailable');
    } finally {
      clock.mockRestore();
    }
  });
});
