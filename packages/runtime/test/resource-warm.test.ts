import { AsyncLocalStorage } from 'node:async_hooks';

import { installResourcePrimaryReadStorage } from '@stayingupwind/core/paas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { resourceWarmOf, warmResourceRoute } from '../src/resource-warm.ts';
import { getStore } from '../src/store.ts';

vi.mock(import('../src/serve.ts'), () => {
  return {
    bypassesPrerender: () => false,
  };
});
vi.mock(import('../src/generations.ts'), () => {
  return {
    descriptorFor: (_store: unknown, route: string, pathname: string) => {
      return {
        kind: 'app-page',
        route,
        pathname,
      };
    },
  };
});
vi.mock(import('../src/cache/regenerate.ts'), () => {
  return {
    regenerate: vi.fn(),
  };
});
vi.mock(import('../src/entries.ts'), () => {
  return {
    nodeHandlerOf: vi.fn(),
  };
});
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  // What the route's parameters are read with (`routingParameters`) is the store's own, and so is
  // whether an entry varies on a query its pathname leaves unnamed (`variesOnQuery`).
  const { entrypointKindOf, unlocalizedRouteOf, variesOnQuery } = await importOriginal();
  return {
    getStore: vi.fn(),
    findShell: vi.fn(),
    isClassShell: (path: string) => path.includes('['),
    entrypointKindOf,
    unlocalizedRouteOf,
    variesOnQuery,
  };
});

const SCOPE = 'dpl_resource_warm';
const entry = { kind: 'app-page', route: '/', pathname: '/' } as const;
const props = { v: 1, scopeId: SCOPE, entry } as const;
const handler: NodeHandler = () => Promise.reject(new Error('unused'));
const runtime = { scopeId: SCOPE, clockOf: vi.fn() } as unknown as CacheRuntime;
const input = {
  props,
  runtime,
  request: new Request('https://app.test/'),
  tables: { app: { entries: {} }, edge: { entries: {} } },
  waitUntil: vi.fn(),
};

describe('trusted resource regeneration', () => {
  beforeEach(() => {
    installResourcePrimaryReadStorage(new AsyncLocalStorage<true>());
    vi.clearAllMocks();
    vi.mocked(getStore).mockReturnValue({
      manifest: {
        deploymentId: SCOPE,
        entrypoints: [{ pathname: '/', kind: 'app-page' }],
        config: { basePath: '', i18n: null },
        bypassToken: 'secret',
      },
      prerendersByPathname: new Map(),
      shellsByRoute: new Map(),
    } as unknown as ReturnType<typeof getStore>);
    vi.mocked(nodeHandlerOf).mockResolvedValue(handler);
  });

  it('selects only validated execution props, with no URL or header trigger', () => {
    expect(resourceWarmOf(undefined)).toBeUndefined();
    expect(resourceWarmOf({ 'x-upwind-resource-warm': '1' })).toBeUndefined();
    expect(resourceWarmOf({ resourceWarm: { ...props, v: 2 } })).toBeUndefined();
    expect(
      resourceWarmOf({ resourceWarm: { ...props, entry: { ...entry, kind: 'fetch' } } }),
    ).toBeUndefined();
    expect(resourceWarmOf({ resourceWarm: props })).toStrictEqual(props);
  });

  it('rejects another scope before loading or rendering the application', async () => {
    const result = await warmResourceRoute({ ...input, props: { ...props, scopeId: 'other' } });

    expect(result.kind).toBe('unsupported');
    expect(nodeHandlerOf).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('awaits committed publication instead of acknowledging the captured render', async () => {
    const publish = Promise.withResolvers<{ kind: 'published'; generationId: string }>();
    vi.mocked(regenerate).mockResolvedValue({
      kind: 'accepted',
      render: {} as never,
      published: publish.promise,
    });
    let settled = false;
    const result = (async () => {
      const publication = await warmResourceRoute(input);
      settled = true;
      return publication;
    })();
    await vi.waitFor(() => {
      expect(regenerate).toHaveBeenCalledExactlyOnceWith(expect.any(Object));
    });

    expect(settled).toBe(false);
    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target).toStrictEqual({
      descriptor: entry,
      isClass: false,
      reason: 'invalidated',
      allowHeader: undefined,
    });

    publish.resolve({ kind: 'published', generationId: 'gen_new' });

    await expect(result).resolves.toStrictEqual({
      v: 1,
      kind: 'published',
      generationId: 'gen_new',
    });
  });

  it('keeps a failed or busy publication retryable', async () => {
    vi.mocked(regenerate).mockResolvedValueOnce({ kind: 'busy' });

    await expect(warmResourceRoute(input)).resolves.toStrictEqual({ v: 1, kind: 'busy' });

    vi.mocked(regenerate).mockResolvedValueOnce({
      kind: 'accepted',
      render: {} as never,
      published: Promise.resolve({ kind: 'refused', reason: 'lease_lost' }),
    });

    await expect(warmResourceRoute(input)).resolves.toStrictEqual({
      v: 1,
      kind: 'failed',
      error: 'lease_lost',
    });
  });
});
