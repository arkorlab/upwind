import { describe, expect, it, vi } from 'vitest';

import { NodeLifetime } from '../src/node-lifetime.ts';

describe('node container lifetime', () => {
  it('keeps requests and tasks until both settle, including tasks registered by tasks', async () => {
    const lifetime = new NodeLifetime();
    const end = lifetime.beginRequest();
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    async function initialTask(): Promise<void> {
      await first.promise;
      lifetime.waitUntil(second.promise);
    }
    const initial = initialTask();
    lifetime.waitUntil(initial);
    const drained = lifetime.drain(1000);
    first.resolve(undefined);
    await initial;
    end();

    expect(lifetime.snapshot()).toStrictEqual({
      activeRequests: 0,
      backgroundTasks: 1,
      draining: false,
    });

    second.resolve(undefined);

    await expect(drained).resolves.toBe(true);
    expect(lifetime.snapshot()).toStrictEqual({
      activeRequests: 0,
      backgroundTasks: 0,
      draining: false,
    });
  });

  it('reports a bounded incomplete drain without dropping unfinished work', async () => {
    const lifetime = new NodeLifetime();
    const task = Promise.withResolvers<undefined>();
    lifetime.waitUntil(task.promise);
    lifetime.startDraining();

    await expect(lifetime.drain(0)).resolves.toBe(false);
    expect(lifetime.snapshot()).toStrictEqual({
      activeRequests: 0,
      backgroundTasks: 1,
      draining: true,
    });

    task.resolve(undefined);

    await expect(lifetime.drain(1000)).resolves.toBe(true);
  });

  it('rechecks idle after a later settlement reaction retains another task', async () => {
    const lifetime = new NodeLifetime();
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    lifetime.waitUntil(first.promise);
    async function registerLater(): Promise<void> {
      await first.promise;
      lifetime.waitUntil(second.promise);
    }
    const later = registerLater();
    const observed = vi.fn<(drained: boolean) => void>();
    const drained = lifetime.drain(1000);
    async function observe(): Promise<void> {
      observed(await drained);
    }
    const observation = observe();
    try {
      first.resolve(undefined);
      await later;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(observed).not.toHaveBeenCalled();
      expect(lifetime.snapshot().backgroundTasks).toBe(1);

      second.resolve(undefined);

      await expect(drained).resolves.toBe(true);

      await observation;
    } finally {
      second.resolve(undefined);
      await observation;
    }
  });

  it('keeps the original drain deadline when a late settlement reaction adds work', async () => {
    vi.useFakeTimers();
    const lifetime = new NodeLifetime();
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    lifetime.waitUntil(first.promise);
    async function registerLater(): Promise<void> {
      await first.promise;
      lifetime.waitUntil(second.promise);
    }
    const later = registerLater();
    const drained = lifetime.drain(50);
    const observed = vi.fn<(value: boolean) => void>();
    async function observe(): Promise<void> {
      observed(await drained);
    }
    const observation = observe();
    try {
      await vi.advanceTimersByTimeAsync(40);
      first.resolve(undefined);
      await later;
      await vi.advanceTimersByTimeAsync(0);

      expect(observed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);

      await expect(drained).resolves.toBe(false);
      expect(lifetime.snapshot().backgroundTasks).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      second.resolve(undefined);
      await observation;
      vi.useRealTimers();
    }
  });

  it('reports an already idle zero-budget drain without leaving a timer', async () => {
    const lifetime = new NodeLifetime();

    await expect(lifetime.drain(0)).resolves.toBe(true);
  });

  it('accounts for rejected background tasks without an unhandled rejection or double request end', async () => {
    const lifetime = new NodeLifetime();
    const end = lifetime.beginRequest();
    lifetime.waitUntil(Promise.reject(new Error('synthetic task failure')));
    end();
    end();

    await expect(lifetime.drain(1000)).resolves.toBe(true);
    expect(lifetime.snapshot()).toStrictEqual({
      activeRequests: 0,
      backgroundTasks: 0,
      draining: false,
    });
  });
});
