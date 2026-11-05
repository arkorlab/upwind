import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { resourceCacheBridge } from '../../core/src/next/resource-cache-bridge.ts';
import {
  installNextCacheRegistry,
  type NextCacheStore,
  type NextWorkStore,
} from '../../core/src/paas/next-cache-registry.ts';
import { observePrivatePublication } from '../../core/src/paas/publication-read.ts';
import { observePublicationGrant } from '../../core/src/paas/publication.ts';
import { observeResourceSnapshot } from '../../core/src/paas/resource-snapshot.ts';

const require = createRequire(import.meta.url);
const grant = {
  scope: 'scope',
  dataGeneration: '1',
  publicationEpoch: 1,
  release: { id: 'release', digest: 'a'.repeat(64) },
};

function nativeCache() {
  installNextCacheRegistry();
  const work = new AsyncLocalStorage<NextWorkStore>();
  const unit = new AsyncLocalStorage<NextCacheStore>();
  const set = vi.fn(() => Promise.resolve());
  const incrementalCache = {
    generateSimpleCacheKey: () => Promise.resolve('key'),
    get: () => Promise.resolve(null),
    set,
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read the installed, literal Next module in the compatibility harness.
  const source = readFileSync(
    require.resolve('next/dist/server/web/spec-extension/unstable-cache'),
    'utf8',
  );
  const load = (id: string): unknown => {
    if (id.endsWith('work-async-storage.external')) return { workAsyncStorage: work };
    if (id.endsWith('work-unit-async-storage.external'))
      return { workUnitAsyncStorage: unit, getCacheSignal: () => null };
    if (id.endsWith('patch-fetch'))
      return { validateTags: (tags: string[]) => tags, validateRevalidate: () => false };
    if (id.endsWith('encode-header-safe')) return { encodeHeaderSafe: (value: string) => value };
    if (id.endsWith('response-cache'))
      return { CachedRouteKind: { FETCH: 'FETCH' }, IncrementalCacheKind: { FETCH: 'FETCH' } };
    return { CACHE_ONE_YEAR_SECONDS: 31_536_000 };
  };
  const module = {
    exports: {} as Partial<
      Record<'unstable_cache', (callback: () => Promise<string>) => () => Promise<string>>
    >,
  };
  // eslint-disable-next-line sonarjs/code-eval -- Execute only installed Next source with test-owned cache/storage dependencies.
  const evaluate = new Script(
    `(function(require,module,exports){${resourceCacheBridge(source).contents}\n})`,
  ).runInThisContext() as (
    loader: typeof load,
    record: typeof module,
    exports: typeof module.exports,
  ) => void;
  evaluate(load, module, module.exports);
  if (module.exports.unstable_cache === undefined) throw new Error('Native cache export missing');
  return { work, unit, set, incrementalCache, cache: module.exports.unstable_cache };
}

function coldSharedCache(
  unit: AsyncLocalStorage<NextCacheStore>,
  read: () => Promise<string>,
): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exercise the installed native cache entry's exact work-unit transition.
  const source = readFileSync(
    require.resolve('next/dist/server/use-cache/use-cache-wrapper'),
    'utf8',
  );
  const load = (id: string): unknown => {
    if (id.endsWith('work-async-storage.external'))
      return {
        workAsyncStorage: {
          run: (_store: unknown, callback: (...args: unknown[]) => unknown, ...args: unknown[]) =>
            callback(...args),
        },
      };
    if (id.endsWith('work-unit-async-storage.external'))
      return {
        workUnitAsyncStorage: unit,
        getHmrRefreshHash: vi.fn(),
        getServerComponentsHmrCache: vi.fn(),
        getDraftModeProviderForCacheScope: vi.fn(),
      };
    if (id.endsWith('dynamic-access-async-storage.external'))
      return { dynamicAccessAsyncStorage: { run: read } };
    return {};
  };
  // The real native wrapper creates the cache store and enters it. Serialization is outside this boundary regression.
  // eslint-disable-next-line sonarjs/code-eval -- Trusted installed Next source, with test-owned serializer and exact shared storage.
  const entry = new Script(`(function(require,exports){${resourceCacheBridge(source).contents}
return generateCacheEntry;})`).runInThisContext() as (
    loader: typeof load,
    exports: Record<string, unknown>,
  ) => (work: Record<string, unknown>, context: Record<string, unknown>) => Promise<string>;
  return entry(load, {})(
    {
      cacheLifeProfiles: { default: { revalidate: 100, expire: 100, stale: 100 } },
      runInCleanSnapshot: (restore: (...args: unknown[]) => Promise<string>, ...args: unknown[]) =>
        unit.exit(() => restore(...args)),
    },
    { kind: 'default', outerWorkUnitStore: unit.getStore() },
  );
}

async function protectedValue(): Promise<string> {
  await observePublicationGrant({ ...grant, validUntil: 1_900_000_000_000 });
  return 'protected nested value';
}

describe('native unstable_cache publication boundary', () => {
  it.each(['publication', 'resource'] as const)(
    'refuses a %s dependency that native unstable_cache cannot persist',
    async (dependency) => {
      const { work, set, incrementalCache, cache } = nativeCache();
      const read = cache(async () => {
        if (dependency === 'publication')
          await observePublicationGrant({ ...grant, validUntil: 1_900_000_000_000 });
        else
          observeResourceSnapshot({
            resourceId: 'a'.repeat(64),
            version: 1,
            tag: 'resource:example',
          });
        return 'public value';
      });

      await expect(work.run({ incrementalCache }, read)).rejects.toThrow(
        'unstable_cache cannot preserve publication dependencies.',
      );
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])(
    'refuses a protected cold shared fill at depth %s inside the native legacy cache',
    async (depth) => {
      const { work, unit, set, incrementalCache, cache } = nativeCache();
      const read = cache(() => {
        return coldSharedCache(
          unit,
          depth === 1 ? protectedValue : () => coldSharedCache(unit, protectedValue),
        );
      });

      await expect(work.run({ incrementalCache }, read)).rejects.toThrow(
        'unstable_cache cannot preserve publication dependencies.',
      );
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps ordinary native unstable_cache callbacks cacheable with nested=%s',
    async (nested) => {
      const { work, unit, set, incrementalCache, cache } = nativeCache();

      await expect(
        work.run(
          { incrementalCache },
          cache(() => {
            return nested
              ? coldSharedCache(unit, () => Promise.resolve('ordinary value'))
              : Promise.resolve('ordinary value');
          }),
        ),
      ).resolves.toBe('ordinary value');
      expect(set).toHaveBeenCalledExactlyOnceWith(
        'key',
        expect.objectContaining({ kind: 'FETCH' }),
        expect.objectContaining({ tags: [] }),
      );
    },
  );

  it('refuses authenticated private values before the native cache can persist them', async () => {
    const { work, set, incrementalCache, cache } = nativeCache();
    const read = cache(async () => {
      await observePrivatePublication(grant);
      return 'private value';
    });

    await expect(work.run({ incrementalCache }, read)).rejects.toThrow(
      'Private publication cannot enter a shared cache.',
    );
    expect(set).not.toHaveBeenCalled();
  });
});
