import { AsyncLocalStorage } from 'node:async_hooks';

import { CACHE_ROUTE_HEADER, installResourcePrimaryReadStorage } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestContextFor, withRequestContext } from '../src/cache/context.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { handleDetached, handleForeground } from '../src/generations.ts';
import { warmResourceRoute } from '../src/resource-warm.ts';
import type { RoutedInput } from '../src/serve.ts';
import { getStore, type Store } from '../src/store.ts';
import { DESCRIPTOR, SCOPE, manifestOf, runtimeOf } from './pages-isr-fixtures.ts';

vi.mock(import('../src/cache/regenerate.ts'), () => ({ regenerate: vi.fn() }));
vi.mock(import('../src/entries.ts'), () => ({ nodeHandlerOf: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

function storeOf(): Store {
  const manifest = manifestOf();
  const prerenders = new Map(manifest.prerenders.map((page) => [page.pathname, page]));
  return {
    manifest,
    prerendersById: new Map(manifest.prerenders.map((page) => [page.id, page])),
    prerendersByPathname: prerenders,
    shellsByRoute: new Map([[DESCRIPTOR.route, { pages: prerenders, patterns: [] }]]),
    staticFiles: new Map(),
    pathnames: ['/something'],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    renderedPages: new Set(['/something']),
    readBlob: () => new Uint8Array(),
    tryReadBlob: () => {
      // These caller tests never read build bytes.
    },
  };
}

function inputOf(): { input: RoutedInput; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const request = new Request('https://app.test/something', {
    headers: { [CACHE_ROUTE_HEADER]: '/something' },
  });
  return {
    pending,
    input: {
      app: { entries: {} },
      edge: { entries: {} },
      request,
      initURL: request.url,
      cache: runtimeOf([]),
      waitUntil: (promise) => {
        pending.push(promise);
      },
      run: (work) => work(),
    },
  };
}

describe('the existing regeneration callers carry immutable build context', () => {
  beforeEach(() => {
    installResourcePrimaryReadStorage(new AsyncLocalStorage<true>());
    vi.mocked(nodeHandlerOf).mockResolvedValue(() => Promise.resolve());
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'accepted',
      render: {
        html: new TextEncoder().encode('<main>new</main>'),
        postponed: undefined,
        rscData: undefined,
        segments: new Map(),
        headers: { 'content-type': 'text/html' },
        status: 200,
        cacheControl: { revalidate: 2 },
        data: undefined,
      },
      published: Promise.resolve({ kind: 'published', generationId: 'new' }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { mode: 'detached', run: handleDetached },
    { mode: 'foreground', run: handleForeground },
  ])('carries Store.manifest through $mode runJob', async ({ run }) => {
    const store = storeOf();
    const { input, pending } = inputOf();

    await run(input, store);
    await Promise.all(pending);

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].staticPagesManifest).toBe(store.manifest);
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual(DESCRIPTOR);
  });

  it('carries the same manifest through the local manual revalidation path', async () => {
    const store = storeOf();
    const { input, pending } = inputOf();
    vi.mocked(getStore).mockReturnValue(store);
    const context = requestContextFor({
      tables: input,
      runtime: input.cache,
      request: input.request,
      startedAt: 0,
      clock: undefined,
      waitUntil: input.waitUntil,
    });

    await withRequestContext(context, () => platformRevalidate({ urlPath: '/something' }));
    await Promise.all(pending);

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].staticPagesManifest).toBe(store.manifest);
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.reason).toBe('manual');
  });

  it('re-resolves resource warm against the local Store instead of trusting incoming props', async () => {
    const store = storeOf();
    const { input, pending } = inputOf();
    vi.mocked(getStore).mockReturnValue(store);

    await expect(
      warmResourceRoute({
        props: { v: 1, scopeId: SCOPE, entry: DESCRIPTOR },
        tables: input,
        request: input.request,
        runtime: input.cache,
        waitUntil: input.waitUntil,
      }),
    ).resolves.toStrictEqual({ v: 1, kind: 'published', generationId: 'new' });

    await Promise.all(pending);

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].staticPagesManifest).toBe(store.manifest);
  });

  it('rejects foreign resource-warm scope before reaching regeneration', async () => {
    const { input } = inputOf();

    await expect(
      warmResourceRoute({
        props: { v: 1, scopeId: 'other', entry: DESCRIPTOR },
        tables: input,
        request: input.request,
        runtime: input.cache,
        waitUntil: input.waitUntil,
      }),
    ).resolves.toStrictEqual({ v: 1, kind: 'unsupported' });
    expect(regenerate).not.toHaveBeenCalled();
  });
});
