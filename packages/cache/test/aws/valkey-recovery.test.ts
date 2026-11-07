import { createCluster } from 'redis';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { VALKEY_STARTUP_MS, ValkeyAuthorityStore } from '../../src/aws/valkey.ts';

const fake = vi.hoisted(() => {
  const client = {
    isOpen: false,
    connect: vi.fn<() => Promise<void>>(),
    destroy: vi.fn<() => void>(),
    on: vi.fn(),
    get: vi.fn<() => Promise<string | null>>(),
    withCommandOptions: vi.fn<(_options: unknown) => unknown>(),
  };
  return { client };
});

vi.mock('redis', () => ({ createCluster: vi.fn(() => fake.client) }));

beforeEach(() => {
  vi.clearAllMocks();
  fake.client.isOpen = false;
  fake.client.connect.mockImplementation(() => {
    fake.client.isOpen = true;
    return Promise.resolve();
  });
  fake.client.destroy.mockImplementation(() => {
    fake.client.isOpen = false;
  });
  fake.client.withCommandOptions.mockReturnValue(fake.client);
  fake.client.get.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AWS Valkey connection recovery', () => {
  test('keeps reconnecting beyond a long failover and continues reading on the same store', async () => {
    const store = new ValkeyAuthorityStore('rediss://cache.example:6379', 'scope');
    await store.connect();
    try {
      const options = vi.mocked(createCluster).mock.calls[0]?.[0];
      const reconnect = options?.defaults?.socket?.reconnectStrategy;
      if (typeof reconnect !== 'function') throw new Error('reconnect strategy missing');
      let waited = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const delay = reconnect(attempt, new Error('failover in progress'));
        if (typeof delay !== 'number') throw new Error('reconnection stopped permanently');
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(1000);
        waited += delay;
      }
      expect(waited).toBeGreaterThan(60_000);
      expect(options?.defaults?.disableOfflineQueue).toBe(true);
      expect(options?.defaults?.commandOptions?.timeout).toBe(1000);
      fake.client.get.mockRejectedValueOnce(new Error('temporarily offline'));
      await expect(store.read('scope')).rejects.toThrow('temporarily offline');
      fake.client.get.mockResolvedValueOnce('{"revision":2}');
      expect((await store.read<{ revision: number }>('scope'))?.value.revision).toBe(2);
      expect(fake.client.destroy).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  test('bounds initial connection and destroys its retries before readiness can be published', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    fake.client.connect.mockImplementation(() => {
      fake.client.isOpen = true;
      return pending.promise;
    });
    const store = new ValkeyAuthorityStore('rediss://cache.example:6379', 'scope');
    const rejected = expect(store.connect()).rejects.toThrow('AWS Valkey startup timed out');
    await vi.advanceTimersByTimeAsync(VALKEY_STARTUP_MS);
    await rejected;
    expect(fake.client.destroy).toHaveBeenCalledOnce();
    expect(fake.client.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // A connection finishing after its owner's deadline stays observed rather than unhandled.
    pending.reject(new Error('late connection failure'));
    await Promise.resolve();
  });

  test('clears the startup budget after a successful connection', async () => {
    vi.useFakeTimers();
    const store = new ValkeyAuthorityStore('rediss://cache.example:6379', 'scope');
    await store.connect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(VALKEY_STARTUP_MS * 2);
    expect(fake.client.destroy).not.toHaveBeenCalled();
    await store.close();
  });

  test('preserves an authentication rejection while disposing a closed partial connection', async () => {
    const denied = new Error('WRONGPASS invalid username-password pair');
    fake.client.connect.mockRejectedValueOnce(denied);
    const store = new ValkeyAuthorityStore('rediss://cache.example:6379', 'scope');
    await expect(store.connect()).rejects.toBe(denied);
    expect(fake.client.isOpen).toBe(false);
    expect(fake.client.destroy).toHaveBeenCalledOnce();
  });

  test('bounds a command stalled before node routing completes without stopping reconnection', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<string | null>();
    fake.client.get.mockReturnValueOnce(pending.promise);
    const store = new ValkeyAuthorityStore('rediss://cache.example:6379', 'scope');
    await store.connect();
    const rejected = expect(store.read('scope')).rejects.toThrow('AWS Valkey command timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    const options = fake.client.withCommandOptions.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
    };
    expect(options.abortSignal.aborted).toBe(true);
    expect(fake.client.destroy).not.toHaveBeenCalled();
    pending.reject(new Error('late routing failure'));
    fake.client.get.mockResolvedValueOnce('{"revision":3}');
    expect((await store.read<{ revision: number }>('scope'))?.value.revision).toBe(3);
    await store.close();
  });
});
