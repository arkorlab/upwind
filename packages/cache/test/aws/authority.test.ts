import { describe, expect, test } from 'vitest';

import type { ScopeState } from '../../src/aws/model.ts';
import { cacheContract } from './contract.ts';
import { MemoryAuthorityStore, pair } from './support.ts';

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
