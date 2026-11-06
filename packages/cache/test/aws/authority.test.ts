import { describe, expect, test } from 'vitest';

import { AwsAuthority } from '../../src/aws/authority.ts';
import type { ScopeState } from '../../src/aws/model.ts';
import { TRANSIENT_RETENTION_MS } from '../../src/aws/types.ts';
import { DEFAULT_CACHE_VARS } from '../../src/env.ts';
import { cacheContract } from './contract.ts';
import { MemoryAuthorityStore, MemoryObjects, options, pair } from './support.ts';

for (const kind of ['valkey', 'dynamodb'] as const)
  cacheContract(`AWS ${kind} authority`, () => Promise.resolve(new MemoryAuthorityStore(kind)));

describe('DynamoDB projection recovery', () => {
  test('a partially projected 128-tag event remains completely visible and replay is idempotent', async () => {
    const store = new MemoryAuthorityStore('dynamodb');
    const host = await pair(store);
    const partial = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    store.afterChange = async (keys) => {
      if (!paused && keys.some((key) => key.startsWith('tag:'))) {
        paused = true;
        partial.resolve();
        await resume.promise;
      }
    };
    try {
      const tags = Array.from({ length: 128 }, (_, index) => `product-${index}`);
      const invalidated = await host.first.invalidate({ tags, api: 'updateTag' });
      await partial.promise;
      expect((await host.second.getTags(tags)).tags).toHaveLength(128);
      expect((await store.read<ScopeState>('scope'))?.value.pending).toBe(1);
      resume.resolve();
      await host.first.close();
      expect((await host.second.getTags(tags)).tags).toHaveLength(128);
      expect((await host.second.tagsDelta(invalidated.revision ?? 0)).tags).toHaveLength(0);
      expect(store.maximumTransaction).toBeLessThanOrEqual(100);
    } finally {
      resume.resolve();
      await host.close();
    }
  });

  test('a failed artifact upload publishes no data value', async () => {
    const store = new MemoryAuthorityStore('dynamodb');
    const host = await pair(store);
    try {
      host.objects.failWrites = true;
      await expect(
        host.first.setData({
          key: 'key',
          entry: {
            kind: 'data:fetch',
            tags: [],
            stale: 0,
            timestamp: Date.now(),
            revalidate: 60,
            expire: 3600,
          },
          valueBase64: 'eA==',
        }),
      ).rejects.toThrow('object upload failed');
      expect(await host.second.getData({ key: 'key', kind: 'data:fetch' })).toBeUndefined();
    } finally {
      await host.close();
    }
  });
});

for (const kind of ['valkey', 'dynamodb'] as const) {
  test(`${kind} releases a failed lease without advancing the scope publication revision`, async () => {
    const store = new MemoryAuthorityStore(kind);
    const host = await pair(store);
    try {
      const entry = { kind: 'app-page' as const, route: '/', pathname: '/' };
      const lease = await host.first.startAttempt({ entry, reason: 'miss' });
      if (lease.kind !== 'leased') throw new Error('lease missing');
      const before = await store.read<ScopeState>('scope');
      await host.first.fail(lease.attemptId, {
        fencingToken: lease.fencingToken,
        outcome: 'failed',
      });
      expect((await store.read('scope'))?.raw).toBe(before?.raw);
      const retried = await host.second.startAttempt({ entry, reason: 'manual' });
      expect(retried.kind).toBe('leased');
      if (retried.kind === 'leased')
        expect(retried.fencingToken).toBeGreaterThan(lease.fencingToken);
    } finally {
      await host.close();
    }
  });

  test(`${kind} retires an unopened scope idempotently without seeding it`, async () => {
    const store = new MemoryAuthorityStore(kind);
    const objects = new MemoryObjects();
    const host = new AwsAuthority(options(kind), store, objects);
    await objects.put(new Uint8Array([1]), 'blobs');
    try {
      expect(await store.read('scope')).toBeUndefined();
      await host.retire();
      const tombstone = await store.read<ScopeState>('scope');
      expect(tombstone?.value.status).toBe('retired');
      expect(objects.values.size).toBe(0);
      await host.retire();
      expect((await store.read('scope'))?.raw).toBe(tombstone?.raw);
      await expect(host.initialize()).rejects.toThrow('scope is unavailable');
      expect([...store.values.keys()]).toEqual(['scope']);
    } finally {
      await host.close();
    }
  });

  test(`${kind} accounts for referenced data bodies and rejects new entries at the scope quota`, async () => {
    const store = new MemoryAuthorityStore(kind);
    const host = await pair(store);
    try {
      const write = (valueBase64: string) =>
        host.first.setData({
          key: 'quota-value',
          entry: {
            kind: 'data:fetch',
            tags: [],
            timestamp: Date.now(),
            stale: 0,
            revalidate: 60,
            expire: 3600,
          },
          valueBase64,
        });
      await write(Buffer.alloc(70_000).toString('base64'));
      const large = await store.read<ScopeState>('scope');
      expect(large?.value.bodyBytes).toBeGreaterThanOrEqual(70_000);
      await write('eA==');
      const small = await store.read<ScopeState>('scope');
      expect(small?.value.bodyBytes).toBeLessThan(70_000);
      if (small === undefined) throw new Error('scope missing');
      await store.change(
        new Map([['scope', small.raw]]),
        new Map([
          ['scope', { ...small.value, entries: DEFAULT_CACHE_VARS.QUOTA_ENTRIES_PER_SCOPE }],
        ]),
      );
      await expect(
        host.first.startAttempt({
          entry: { kind: 'app-page', route: '/new', pathname: '/new' },
          reason: 'miss',
        }),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
      await write('eQ==');
      expect(
        (await host.second.getData({ key: 'quota-value', kind: 'data:fetch' }))?.value,
      ).toEqual({ kind: 'inline', base64: 'eQ==' });
    } finally {
      await host.close();
    }
  });

  test(`${kind} expires repeated renderer bookkeeping while current values and artifact access remain`, async () => {
    const store = new MemoryAuthorityStore(kind);
    const host = await pair(store);
    try {
      for (let index = 0; index < 12; index += 1) {
        const lease = await host.first.startAttempt({
          entry: { kind: 'app-page', route: '/', pathname: '/' },
          reason: 'miss',
        });
        if (lease.kind !== 'leased') throw new Error('lease missing');
        await host.first.uploadArtifact({
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          role: 'html',
          contentType: 'text/html',
          bytes: new TextEncoder().encode(`body-${index}`),
        });
        await host.first.fail(lease.attemptId, {
          fencingToken: lease.fencingToken,
          outcome: 'skipped',
        });
        await host.first.setData({
          key: 'key',
          entry: {
            kind: 'data:fetch',
            tags: [],
            stale: 0,
            timestamp: Date.now(),
            revalidate: 60,
            expire: 3600,
          },
          valueBase64: Buffer.alloc(70_000, index).toString('base64'),
          order: { writer: `writer-${index}`, seq: 1 },
        });
      }
      const current = await host.second.getData({ key: 'key', kind: 'data:fetch' });
      expect(current?.value.kind).toBe('ref');
      store.clockOffset = TRANSIENT_RETENTION_MS + 1000;
      await store.sweepExpired();
      expect(
        [...store.values.keys()].some((key) => /^(attempt:|upload:|writer:|artifact:)/u.test(key)),
      ).toBe(false);
      expect((await host.second.getData({ key: 'key', kind: 'data:fetch' }))?.generationId).toBe(
        current?.generationId,
      );
      if (current?.value.kind === 'ref')
        expect((await host.second.readArtifact(current.value.artifactId))?.byteLength).toBe(70_000);
    } finally {
      await host.close();
    }
  });
}
