import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ScopeState } from '../../src/aws/model.ts';
import {
  INVALIDATION_BACKPRESSURE_MS,
  MAX_PENDING_EVENTS,
  PROJECTOR_KEY,
  PROJECTOR_LEASE_MS,
} from '../../src/aws/types.ts';
import { MemoryAuthorityStore, pair } from './support.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function fullTail(leaseMs: number) {
  const store = new MemoryAuthorityStore('dynamodb');
  const host = await pair(store);
  await store.change(
    new Map(),
    new Map([
      [PROJECTOR_KEY, { owner: 'stalled-task', fence: 1, expiresAt: Date.now() + leaseMs }],
    ]),
  );
  for (let index = 0; index < MAX_PENDING_EVENTS; index += 1)
    await host.first.invalidate({ tags: [`queued-${index}`], api: 'updateTag' });
  return { store, host };
}

describe('DynamoDB invalidation backpressure', () => {
  test('waits beyond short CAS retry loops and takes over an abandoned projector lease', async () => {
    const { store, host } = await fullTail(PROJECTOR_LEASE_MS);
    let maximumPending = 0;
    store.afterChange = async () => {
      maximumPending = Math.max(
        maximumPending,
        (await store.read<ScopeState>('scope'))?.value.pending ?? 0,
      );
    };
    let settled = false;
    const waiting = host.second.invalidate({ tags: ['next'], api: 'updateTag' }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      expect((await store.read<ScopeState>('scope'))?.value.pending).toBe(MAX_PENDING_EVENTS);
      await vi.advanceTimersByTimeAsync(PROJECTOR_LEASE_MS + 1000);
      expect((await waiting).invalidations).toHaveLength(1);
      expect(maximumPending).toBeLessThanOrEqual(MAX_PENDING_EVENTS);
      expect(store.maximumTransaction).toBeLessThanOrEqual(100);
    } finally {
      await host.close();
    }
  });

  test('has a separate bounded pressure deadline when the tail cannot drain', async () => {
    const { store, host } = await fullTail(INVALIDATION_BACKPRESSURE_MS * 10);
    const rejected = expect(
      host.second.invalidate({ tags: ['next'], api: 'updateTag' }),
    ).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    try {
      expect(INVALIDATION_BACKPRESSURE_MS).toBeGreaterThan(PROJECTOR_LEASE_MS);
      await vi.advanceTimersByTimeAsync(INVALIDATION_BACKPRESSURE_MS + 1000);
      await rejected;
      expect((await store.read<ScopeState>('scope'))?.value.pending).toBe(MAX_PENDING_EVENTS);
      expect((await host.second.getTags(['next'])).tags).toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});
