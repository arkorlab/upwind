import { describe, expect, it } from 'vitest';

import { NodeLifetime } from '../src/node-lifetime.ts';

describe('Node container lifetime', () => {
  it('keeps requests and tasks until both settle, including tasks registered by tasks', async () => {
    const lifetime = new NodeLifetime();
    const end = lifetime.beginRequest();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const initial = first.promise.then(() => {
      lifetime.waitUntil(second.promise);
    });
    lifetime.waitUntil(initial);
    const drained = lifetime.drain(1000);
    first.resolve();
    await initial;
    end();

    expect(lifetime.snapshot()).toEqual({ activeRequests: 0, backgroundTasks: 1, draining: false });

    second.resolve();

    expect(await drained).toBe(true);
    expect(lifetime.snapshot()).toEqual({ activeRequests: 0, backgroundTasks: 0, draining: false });
  });

  it('reports a bounded incomplete drain without dropping unfinished work', async () => {
    const lifetime = new NodeLifetime();
    const task = Promise.withResolvers<void>();
    lifetime.waitUntil(task.promise);
    lifetime.startDraining();

    expect(await lifetime.drain(0)).toBe(false);
    expect(lifetime.snapshot()).toEqual({ activeRequests: 0, backgroundTasks: 1, draining: true });

    task.resolve();

    expect(await lifetime.drain(1000)).toBe(true);
  });

  it('accounts for rejected background tasks without an unhandled rejection or double request end', async () => {
    const lifetime = new NodeLifetime();
    const end = lifetime.beginRequest();
    lifetime.waitUntil(Promise.reject(new Error('synthetic task failure')));
    end();
    end();

    expect(await lifetime.drain(1000)).toBe(true);
    expect(lifetime.snapshot()).toEqual({ activeRequests: 0, backgroundTasks: 0, draining: false });
  });
});
