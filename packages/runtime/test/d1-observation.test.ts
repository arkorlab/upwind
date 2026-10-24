import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { resourceCacheBridge } from '../../core/src/next/resource-cache-bridge.ts';
import { DEFAULT_D1_CACHE_TAG, observeD1 } from '../../core/src/paas/d1-observation.ts';
import {
  installNextCacheRegistry,
  type NextCacheStore,
  type NextWorkStore,
  revalidateNextResource,
} from '../../core/src/paas/next-cache-registry.ts';
import {
  installResourcePrimaryReadStorage,
  withPrimaryResourceReads,
} from '../../core/src/paas/resource-read-context.ts';
import {
  formatResourcesManifest,
  publishedD1BindingCount,
  RESOURCES_MANIFEST_BINDING,
  resourcesOf,
} from '../../core/src/paas/resources.ts';
import { sqlEffect } from '../../core/src/paas/sql-effect.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

const require = createRequire(import.meta.url);
const PRIMARY = new AsyncLocalStorage<true>();

function binarySnapshot(value: ArrayBufferView): unknown[] {
  // eslint-disable-next-line unicorn/prefer-spread -- Match native bind for non-iterable DataView as well as typed arrays.
  return Array.from(value as unknown as ArrayLike<unknown>);
}

function database() {
  const queries: string[] = [];
  const bindings: { source: string; values: unknown[] }[] = [];
  const raw = [
    ['id', 'id', '2', '1'],
    [1, 2, 'second', 'first'],
  ];
  let result: unknown = { success: true, results: [{ id: 1 }], meta: { changed_db: false } };
  function prepare(sql: string, source: string) {
    const statement = {
      bind(...values: unknown[]) {
        bindings.push({
          source,
          values: values.map((value) =>
            ArrayBuffer.isView(value) ? binarySnapshot(value) : value,
          ),
        });
        return statement;
      },
      all() {
        queries.push(`${source}:${sql}:all`);
        return Promise.resolve(result);
      },
      run() {
        queries.push(`${source}:${sql}:run`);
        return Promise.resolve(result);
      },
      raw() {
        queries.push(`${source}:${sql}:raw`);
        return Promise.resolve(raw);
      },
      first: vi.fn<(column?: string) => Promise<never>>(() =>
        Promise.reject(new Error('first must use one metadata-bearing query')),
      ),
    };
    return statement;
  }
  const replica = {
    prepare: (sql: string) => prepare(sql, 'replica'),
    batch: vi.fn<(statements: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([result])),
    exec: vi.fn<(sql: string) => Promise<{ count: number; duration: number }>>(() =>
      Promise.resolve({ count: 1, duration: 0 }),
    ),
    getBookmark: () => 'old-bookmark',
  };
  const primary = { ...replica, prepare: (sql: string) => prepare(sql, 'primary') };
  const native = {
    prepare: (sql: string) => prepare(sql, 'primary'),
    batch: (statements: unknown[]) => Promise.resolve(statements.map(() => result)),
    exec: vi.fn<(sql: string) => Promise<{ count: number; duration: number }>>(() =>
      Promise.resolve({ count: 1, duration: 0 }),
    ),
    withSession: (constraint?: string) => (constraint === 'first-primary' ? primary : replica),
  };
  return {
    native,
    raw,
    queries,
    bindings,
    setResult: (value: unknown) => {
      result = value;
    },
  };
}

function nextContext() {
  installNextCacheRegistry();
  const work = new AsyncLocalStorage<NextWorkStore>();
  const unit = new AsyncLocalStorage<NextCacheStore>();
  const primary = PRIMARY;
  installResourcePrimaryReadStorage(primary);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolve only installed Next source for the native compatibility harness.
  const source = readFileSync(
    require.resolve('next/dist/server/use-cache/use-cache-wrapper'),
    'utf8',
  );
  const module = { exports: {} };
  const mocks = (id: string): unknown => {
    if (id.endsWith('work-async-storage.external')) return { workAsyncStorage: work };
    if (id.endsWith('work-unit-async-storage.external')) return { workUnitAsyncStorage: unit };
    return {};
  };
  // Execute the real installed wrapper's module registration, without rendering or invoking caches.
  // eslint-disable-next-line sonarjs/code-eval -- Evaluate trusted installed Next source in the controlled compatibility harness.
  const evaluate = new Script(
    `(function(require,module,exports){${resourceCacheBridge(source).contents}\nreturn {generateCacheEntry,propagateCacheEntryMetadata};})`,
  ).runInThisContext() as (
    req: typeof mocks,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => {
    generateCacheEntry: (store: NextWorkStore) => unknown;
    propagateCacheEntryMetadata: (
      context: Record<string, unknown>,
      metadata: Record<string, unknown>,
    ) => void;
  };
  const exposed = evaluate(mocks, module, module.exports);
  return { work, unit, primary, exposed, mocks };
}

describe('automatic default D1 cache dependencies', () => {
  it('preserves native constructor identity on databases and statements', () => {
    const native = database();
    const db = observeD1(native.native, 'ORDERS') as typeof native.native;

    expect(db.constructor).toBe(native.native.constructor);
    expect(db.prepare('SELECT 1').constructor).toBe(native.native.prepare('SELECT 1').constructor);
    expect(observeD1({ kind: 'database' }, 'ORDERS')).toStrictEqual({ kind: 'database' });
  });

  it('tags at query execution, including pre-created statements, and isolates concurrent fills', async () => {
    const { unit } = nextContext();
    const db = observeD1(database().native, 'ORDERS') as ReturnType<typeof database>['native'];
    const statement = db.prepare('SELECT id FROM orders');
    const first: NextCacheStore = { type: 'cache', tags: null };
    const second: NextCacheStore = { type: 'cache', tags: ['manual'] };
    await Promise.all([
      unit.run(first, async () => {
        await statement.all();
        await statement.all();
      }),
      unit.run(second, async () => {
        await Promise.resolve();
        await statement.all();
      }),
    ]);

    expect(first.tags).toStrictEqual([DEFAULT_D1_CACHE_TAG]);
    expect(second.tags).toStrictEqual(['manual', DEFAULT_D1_CACHE_TAG]);

    const request: NextCacheStore = { type: 'request', tags: null };
    await unit.run(request, () => statement.all());

    expect(request.tags).toBeNull();
  });

  it('tags legacy dump reads while preserving the native receiver, promise and buffer', async () => {
    const { unit } = nextContext();
    const snapshot = new Uint8Array([1, 2]).buffer;
    const result = Promise.resolve(snapshot);
    const native = {
      ...database().native,
      result,
      dump: vi.fn(function dumpSnapshot(this: { result: Promise<ArrayBuffer> }) {
        return this.result;
      }),
    };
    const changed = vi.fn(() => Promise.resolve());
    const db = observeD1(native, 'ORDERS', { changed }) as typeof native;
    const dump = db.dump;
    const cache: NextCacheStore = { type: 'cache', tags: ['manual'] };
    const request: NextCacheStore = { type: 'request', tags: null };

    expect(unit.run(cache, dump)).toBe(result);
    await expect(unit.run(cache, dump)).resolves.toBe(snapshot);

    await unit.run(request, dump);

    expect(cache.tags).toStrictEqual(['manual', DEFAULT_D1_CACHE_TAG]);
    expect(request.tags).toBeNull();
    expect(native.dump).toHaveBeenCalledTimes(3);
    expect(changed).not.toHaveBeenCalled();
  });

  it('preserves unsupported native dump errors and does not add dump to sessions', async () => {
    const { unit } = nextContext();
    const failure = new Error('D1_DUMP_ERROR: unsupported database version');
    const native = {
      ...database().native,
      dump: vi.fn(() => Promise.reject(failure)),
    };
    const changed = vi.fn(() => Promise.resolve());
    const db = observeD1(native, 'ORDERS', { changed }) as typeof native;
    const cache: NextCacheStore = { type: 'cache', tags: null };

    await expect(unit.run(cache, () => db.dump())).rejects.toBe(failure);

    expect(cache.tags).toStrictEqual([DEFAULT_D1_CACHE_TAG]);
    expect(native.dump).toHaveBeenCalledExactlyOnceWith();
    expect(changed).not.toHaveBeenCalled();
    expect(Reflect.get(db.withSession(), 'dump')).toBeUndefined();
  });

  it('awaits one mutation report from metadata, and keeps raw duplicate columns in native order', async () => {
    const native = database();
    const accepted = Promise.withResolvers<undefined>();
    const changed = vi.fn(() => accepted.promise);
    const db = observeD1(native.native, 'ORDERS', { changed }) as typeof native.native;
    native.setResult({ results: [{ id: 2 }], meta: { changed_db: true } });
    let settled = false;
    const mutation = (async () => {
      const value = await db.prepare('UPDATE orders SET id=2 RETURNING id').all();
      settled = true;
      return value;
    })();
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
    });

    expect(settled).toBe(false);

    accepted.resolve(undefined);
    await mutation;

    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
    await expect(db.prepare('SELECT id,id,2,1 FROM orders').raw()).resolves.toBe(native.raw);
  });

  it('lets actual Next metadata propagation carry a D1 dependency through nested caches and prerenders, including hits', async () => {
    const { unit, exposed } = nextContext();
    const db = observeD1(database().native, 'ORDERS') as ReturnType<typeof database>['native'];
    const inner: NextCacheStore = { type: 'cache', tags: null };
    await unit.run(inner, () => db.prepare('SELECT id FROM orders').all());
    const outer = { type: 'cache', tags: ['manual'], stale: 600, revalidate: 600, expire: 600 };
    const metadata = { tags: inner.tags, stale: 60, revalidate: 60, expire: 600 };
    exposed.propagateCacheEntryMetadata({ kind: 'public', outerWorkUnitStore: outer }, metadata);

    expect(outer.tags).toStrictEqual(['manual', DEFAULT_D1_CACHE_TAG]);

    for (const type of ['prerender', 'prerender-runtime', 'prerender-legacy']) {
      const prerender = {
        type,
        tags: null as string[] | null,
        stale: 600,
        revalidate: 600,
        expire: 600,
      };
      const cached = { ...metadata, tags: outer.tags };
      exposed.propagateCacheEntryMetadata(
        { kind: 'public', outerWorkUnitStore: prerender },
        cached,
      );
      exposed.propagateCacheEntryMetadata(
        { kind: 'public', outerWorkUnitStore: prerender },
        cached,
      );

      expect(prerender.tags).toStrictEqual(['manual', DEFAULT_D1_CACHE_TAG]);
    }
  });

  it('first reports a successful write before column shaping throws, using only one query', async () => {
    const native = database();
    native.setResult({ results: [{ id: 2 }], meta: { changed_db: true } });
    const changed = vi.fn(() => Promise.resolve());
    const db = observeD1(native.native, 'ORDERS', { changed }) as typeof native.native;

    await expect(
      db.prepare('UPDATE orders SET id=2 RETURNING id').first('missing'),
    ).rejects.toThrow('D1_COLUMN_NOTFOUND');
    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
    expect(native.queries).toHaveLength(1);
  });

  it('unwraps bound statements for atomic batch and reports once; failed queries never report', async () => {
    const native = database();
    native.setResult({ results: [], meta: { changed_db: true } });
    const changed = vi.fn(() => Promise.resolve());
    const batch = vi.spyOn(native.native, 'batch');
    const db = observeD1(native.native, 'ORDERS', { changed }) as typeof native.native;
    const statement = db.prepare('UPDATE orders SET id=?').bind(2);
    await db.batch([statement, statement]);

    expect(batch.mock.calls[0]?.[0][0]).not.toBe(statement);
    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');

    batch.mockRejectedValueOnce(new Error('transaction rolled back'));

    await expect(db.batch([statement])).rejects.toThrow('transaction rolled back');
    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
  });

  it('conservatively reports a mixed native batch without mutation metadata, but respects explicit read metadata', async () => {
    const native = database();
    const changed = vi.fn(() => Promise.resolve());
    const db = observeD1(native.native, 'ORDERS', { changed }) as typeof native.native;
    const foreign = native.native.prepare('UPDATE orders SET id=2');
    const observed = db.prepare('SELECT id FROM orders');
    const batch = vi.spyOn(native.native, 'batch');
    native.setResult({ success: true, results: [] });
    await db.batch([observed, foreign]);

    expect(batch).toHaveBeenCalledExactlyOnceWith([expect.any(Object), foreign]);
    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');

    native.setResult({ success: true, results: [], meta: { changed_db: false } });
    await db.batch([foreign]);

    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
  });

  it('observes a distinct published D1 even when other declarations are duplicate, missing, invalid or inherited', async () => {
    const { unit } = nextContext();
    const native = database();
    const env = {
      ORDERS: native.native,
      TEXT: 'not a binding',
      NULL: null,
      [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest([
        { name: 'ORDERS', type: 'd1' },
        { name: 'ORDERS', type: 'd1' },
        { name: 'GONE', type: 'd1' },
        { name: 'TEXT', type: 'd1' },
        { name: 'NULL', type: 'd1' },
        { name: '__proto__', type: 'd1' },
      ]),
    };
    const published = resourcesOf(env);
    const db = published.resources['ORDERS']?.binding as typeof native.native;
    const store: NextCacheStore = { type: 'cache', tags: null };
    await unit.run(store, () => db.prepare('SELECT id FROM orders').all());

    expect(publishedD1BindingCount(env)).toBe(1);
    expect(Object.keys(published.resources)).toStrictEqual(['ORDERS']);
    expect(store.tags).toStrictEqual([DEFAULT_D1_CACHE_TAG]);
  });

  it('keeps multiple published D1s unobserved and follows the last declaration of a name', () => {
    const first = database().native;
    const second = database().native;
    const env = {
      FIRST: first,
      SECOND: second,
      [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest([
        { name: 'FIRST', type: 'd1' },
        { name: 'SECOND', type: 'd1' },
      ]),
    };

    expect(publishedD1BindingCount(env)).toBe(2);
    expect(resourcesOf(env).resources['FIRST']?.binding).toBe(first);

    const overwritten = {
      ...env,
      [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest([
        { name: 'FIRST', type: 'd1' },
        { name: 'FIRST', type: 'r2_bucket' },
      ]),
    };

    expect(publishedD1BindingCount(overwritten)).toBe(0);
    expect(resourcesOf(overwritten).resources['FIRST']).toStrictEqual({
      type: 'r2_bucket',
      binding: first,
    });
  });

  it.each(['all', 'run', 'first', 'raw', 'batch'] as const)(
    'keeps the committed %s result when notification fails, without replaying SQL',
    async (kind) => {
      const native = database();
      native.setResult({ results: [{ id: 2 }], meta: { changed_db: true } });
      const changed = vi.fn(() => Promise.reject(new Error('Control is unavailable')));
      const failed = vi.fn();
      const db = observeD1(native.native, 'ORDERS', { changed, failed }) as typeof native.native;
      const statement = db.prepare('UPDATE orders SET id=2 RETURNING id');

      await expect(
        kind === 'batch' ? db.batch([statement]) : statement[kind](),
      ).resolves.toBeDefined();
      expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
      expect(failed).toHaveBeenCalledExactlyOnceWith('ORDERS', expect.any(Error));
      expect(native.queries).toHaveLength(kind === 'batch' ? 0 : 1);
    },
  );

  it('reports possible partial exec writes while retaining the original SQL error', async () => {
    const native = database();
    const original = new Error('second statement failed after first committed');
    vi.spyOn(native.native, 'exec').mockRejectedValueOnce(original);
    const changed = vi.fn(() => Promise.reject(new Error('report also failed')));
    const db = observeD1(native.native, 'ORDERS', { changed }) as typeof native.native;

    await expect(db.exec('UPDATE orders SET id=2; this is invalid SQL')).rejects.toBe(original);
    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
  });

  it('reports native newline-separated exec writes without requiring a semicolon', async () => {
    const native = database();
    const changed = vi.fn(() => Promise.resolve());
    const db = observeD1(native.native, 'ORDERS', { changed }) as typeof native.native;
    await db.exec('SELECT 1\nUPDATE orders SET id=2');

    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');

    await db.exec('SELECT 1\nSELECT 2');

    expect(changed).toHaveBeenCalledExactlyOnceWith('ORDERS');
  });

  it('forces primary execution after Next clears ambient ALS, even for an old bound session statement', async () => {
    const { work, unit, primary, exposed } = nextContext();
    const native = database();
    const db = observeD1(native.native, 'ORDERS') as typeof native.native;
    const statement = db.withSession('old-bookmark').prepare('SELECT id FROM orders').bind(1);
    const clean = AsyncLocalStorage.snapshot();
    const store: NextWorkStore & { runInCleanSnapshot: (...args: unknown[]) => unknown } = {
      incrementalCache: {},
      runInCleanSnapshot: (_restore, restored) => {
        return clean(() => {
          expect(primary.getStore()).toBeUndefined();

          return work.run(restored as NextWorkStore, () =>
            unit.run({ type: 'cache', tags: null }, () => statement.raw()),
          );
        });
      },
    };
    await withPrimaryResourceReads(() => exposed.generateCacheEntry(store));

    expect(native.queries).toStrictEqual(['primary:SELECT id FROM orders:raw']);

    await statement.raw();

    expect(native.queries.at(-1)).toBe('replica:SELECT id FROM orders:raw');
  });

  it.each(['statement', 'batch'] as const)(
    'preserves bind-time binary snapshots when warming a pre-created session %s',
    async (kind) => {
      nextContext();
      const native = database();
      const db = observeD1(native.native, 'ORDERS') as typeof native.native;
      const session = db.withSession('old-bookmark');
      const bytes = new Uint8Array([1, 2]);
      const statement = session.prepare('SELECT ?').bind(bytes);
      bytes[0] = 99;
      await withPrimaryResourceReads(() =>
        kind === 'statement' ? statement.raw() : session.batch([statement]),
      );

      expect(native.bindings.at(-1)).toStrictEqual({ source: 'primary', values: [[1, 2]] });
    },
  );

  it('enqueues action SWR on cache hits without importing next/cache, and skips invalid Next contexts', () => {
    const { work, unit } = nextContext();
    const store: NextWorkStore = { incrementalCache: {} };
    work.run(store, () => {
      unit.run({ type: 'request', phase: 'action' }, () => {
        expect(revalidateNextResource(DEFAULT_D1_CACHE_TAG)).toBe(true);
        expect(revalidateNextResource(DEFAULT_D1_CACHE_TAG)).toBe(true);
      });
    });

    const revalidatedAt: unknown = expect.any(Number);

    expect(store.pendingRevalidatedTags).toStrictEqual([
      { tag: DEFAULT_D1_CACHE_TAG, profile: 'max', revalidatedAt },
    ]);
    expect(store).not.toHaveProperty('pathWasRevalidated');

    for (const invalid of [
      { type: 'cache', phase: 'render' },
      { type: 'request', phase: 'render' },
      { type: 'prerender', phase: 'action' },
    ]) {
      expect(
        work.run(store, () =>
          unit.run(invalid, () => revalidateNextResource(DEFAULT_D1_CACHE_TAG)),
        ),
      ).toBe(false);
    }

    expect(revalidateNextResource(DEFAULT_D1_CACHE_TAG)).toBe(false);
  });

  it('prefers the actual Next revalidateTag provider when its module is in the graph', () => {
    const { work, unit, mocks } = nextContext();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolve only installed Next source for the native compatibility harness.
    const source = readFileSync(
      require.resolve('next/dist/server/web/spec-extension/revalidate'),
      'utf8',
    );
    const exported = {};
    const load = (id: string): unknown => {
      return id.endsWith('encode-header-safe')
        ? { encodeHeaderSafe: vi.fn((tag: string) => tag) }
        : mocks(id);
    };
    // eslint-disable-next-line sonarjs/code-eval -- Evaluate trusted installed Next source in the controlled compatibility harness.
    const evaluate = new Script(
      `(function(require,module,exports){${resourceCacheBridge(source).contents}\n})`,
    ).runInThisContext() as (
      req: typeof load,
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>,
    ) => void;
    evaluate(load, { exports: exported }, exported);
    const store: NextWorkStore & { cacheLifeProfiles: Record<string, { expire: number }> } = {
      incrementalCache: {},
      cacheLifeProfiles: { max: { expire: 31_536_000 } },
    };
    work.run(store, () => {
      return unit.run({ type: 'request', phase: 'action' }, () =>
        revalidateNextResource(DEFAULT_D1_CACHE_TAG),
      );
    });

    expect(store.pendingRevalidatedTags).toHaveLength(1);
    expect(store.pendingRevalidatedTags?.[0]?.profile).toBe('max');
  });
});

describe('metadata-free D1 SQL effects', () => {
  it.each([
    ['SELECT "UPDATE", \'DELETE\' /* INSERT */ FROM orders', 'read'],
    ['-- UPDATE\nWITH x AS (SELECT 1) SELECT * FROM x', 'read'],
    ['WITH x AS (SELECT 1) UPDATE orders SET id=2 RETURNING id', 'write'],
    ['WITH x AS (SELECT 1) VALUES (1)', 'read'],
    ['WITH RECURSIVE x AS (VALUES (1)) VALUES (2)', 'read'],
    ['SELECT 1; DELETE FROM orders', 'write'],
    ['EXPLAIN QUERY PLAN DELETE FROM orders', 'read'],
    ['PRAGMA table_info(orders)', 'read'],
    ['PRAGMA user_version=3', 'unknown'],
  ])('classifies %s as %s', (sql, effect) => {
    expect(sqlEffect(sql)).toBe(effect);
  });
});
