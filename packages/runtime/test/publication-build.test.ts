import type { Prerender } from '@stayingupwind/core/bundle';
import type { PublicationRequirement } from '@stayingupwind/core/cache';
import { observePublicationTags } from '@stayingupwind/core/paas';
import { describe, expect, it, vi } from 'vitest';

import { afterBody } from '../src/after-body.ts';
import type { NodeHandler } from '../src/app-module.ts';
import { requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { documentFromBuild } from '../src/documents.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { admitRequestPublication, requirePublication } from '../src/publication.ts';
import { withHeadersChanged } from '../src/reframe.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

// The live edge handler is real; the unused Workers-only Node bridge is not started.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const ROUTE = '/items';
const NOW = 1_800_000_000_000;
const publication = {
  version: 1 as const,
  identities: ['a'.repeat(64)],
  routes: [ROUTE],
  independentBuild: [ROUTE],
};

function scenario(
  draft: boolean,
  required: PublicationRequirement = publication,
  postponed = false,
) {
  const shell = {
    id: 'items',
    route: ROUTE,
    pathname: ROUTE,
    body: { sha256: 'shell' },
    ...(postponed && { postponed: '{}' }),
  } as Prerender;
  const store = {
    manifest: { config: { basePath: '' }, bypassToken: 'draft' },
    shellsByRoute: new Map([[ROUTE, { pages: new Map([[ROUTE, shell]]), patterns: [] }]]),
    readBlob: () => new TextEncoder().encode('independent shell'),
  } as unknown as Store;
  const request = new Request(`https://fixture.test${ROUTE}`, {
    headers: draft ? { cookie: '__prerender_bypass=draft' } : {},
  });
  // This boundary reads only the sealed host metadata, never a cache backend.
  const cache = { host: { publication: required } } as unknown as CacheRuntime;
  const tables = { app: { entries: {} }, edge: { entries: {} } };
  const waitUntil = vi.fn();
  const context = requestContextFor({
    tables,
    runtime: cache,
    request,
    startedAt: NOW,
    waitUntil,
    clock: postponed ? undefined : NOW,
  });
  const input: RoutedInput = {
    ...tables,
    request,
    cache,
    waitUntil,
    run: context.run,
    initURL: request.url,
  };
  const handler = vi.fn(() => {
    return Promise.resolve(
      new Response('live data without a grant', {
        headers: { 'cache-control': 'public,s-maxage=3600' },
      }),
    );
  });
  const render = () => {
    return documentFromBuild(
      input,
      store,
      {
        route: ROUTE,
        pathname: ROUTE,
        url: ROUTE,
      },
      {
        entry: postponed
          ? { kind: 'node', handler: vi.fn<NodeHandler>() }
          : { kind: 'edge', handler },
        status: 200,
      },
    );
  };
  return { context, input, handler, render };
}

describe('independent build publication proof', () => {
  it('keeps a selected independent v2 shell cacheable despite an unresolved live-read capability', async () => {
    const test = scenario(false, { ...publication, version: 2, valueObservers: true });

    await test.context.run(async () => {
      requirePublication(test.input.cache, ROUTE);
      const built = await test.render();
      const original = built.headers.get('cache-control');
      const admitted = admitRequestPublication(built, test.context);

      expect(test.context.publicationReadStarted).toBe(true);
      expect(admitted.headers.get('cache-control')).toBe(original);
      await expect(admitted.text()).resolves.toBe('independent shell');
    });
  });

  it('never treats a postponed suffix as static proof after its live grant expires', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(NOW - performance.timeOrigin);
    const test = scenario(false, { ...publication, version: 2, valueObservers: true }, true);
    let suffix: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.mocked(invokeNodeHandler).mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            suffix = controller;
          },
        }),
      ),
    );
    try {
      const response = await test.context.run(async () => {
        requirePublication(test.input.cache, ROUTE);
        observePublicationTags([
          `upwind:publication:v1:${publication.identities[0]}:${String(NOW + 1000)}`,
        ]);
        return admitRequestPublication(await test.render(), test.context);
      });
      const reader = response.body!.getReader();
      const first = await reader.read();

      expect(new TextDecoder().decode(first.value)).toBe('independent shell');

      clock.mockReturnValue(NOW + 1000 - performance.timeOrigin);
      suffix!.enqueue(new TextEncoder().encode('expired live suffix'));
      suffix!.close();

      await expect(reader.read()).rejects.toThrow('Publication unavailable');
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves a current granted error and an unprotected error response', async () => {
    const test = scenario(false);
    const response = await test.context.run(() => {
      requirePublication(test.input.cache, ROUTE);
      const admitted = admitRequestPublication(
        new Response('current authorized error', {
          status: 403,
          headers: {
            'x-next-cache-tags': `upwind:publication:v1:${publication.identities[0]}:${String(NOW + 60_000)}`,
          },
        }),
        test.context,
      );
      return Promise.resolve(admitted);
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('current authorized error');

    const plain = scenario(false);
    const denied = new Response('plain error', { status: 404 });

    expect(admitRequestPublication(denied, plain.context)).toBe(denied);
  });

  it.each([403, 404, 500])(
    'requires a grant for protected live error output (status=%s)',
    async (status) => {
      const test = scenario(false);
      const response = await test.context.run(() => {
        requirePublication(test.input.cache, ROUTE);
        const admitted = admitRequestPublication(
          new Response('retired data in an error body', {
            status,
            headers: { 'cache-control': 'public,s-maxage=3600' },
          }),
          test.context,
        );
        return Promise.resolve(admitted);
      });

      expect(response.status).toBe(503);
      await expect(response.text()).resolves.not.toContain('retired data');
    },
  );

  it('does not exempt a live draft response merely because an independent shell exists', async () => {
    const test = scenario(true);
    const response = await test.context.run(async () => {
      requirePublication(test.input.cache, ROUTE);
      return admitRequestPublication(await test.render(), test.context);
    });

    expect(test.handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
  });

  it('exempts only the selected shipped response and leaves subsequent live output protected', async () => {
    const test = scenario(false);

    await test.context.run(async () => {
      requirePublication(test.input.cache, ROUTE);
      const built = await test.render();
      const ended = vi.fn();
      const rewrapped = withHeadersChanged(built, (headers) => {
        headers.set('x-test', 'preserved');
      });
      const response = admitRequestPublication(afterBody(rewrapped, ended), test.context);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('independent shell');
      expect(ended).toHaveBeenCalledTimes(1);
      expect(
        admitRequestPublication(new Response('different live output'), test.context).status,
      ).toBe(503);
    });

    expect(test.handler).not.toHaveBeenCalled();
  });
});
