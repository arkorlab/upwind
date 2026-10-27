import { describe, expect, it } from 'vitest';

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
