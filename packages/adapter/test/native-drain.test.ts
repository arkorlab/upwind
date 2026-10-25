import { setImmediate as tick } from 'node:timers/promises';

import { createNodeBridge, TaskGroup } from '@stayingupwind/runtime/native';
import { describe, expect, it } from 'vitest';

import { drainNativeWork } from '../src/native/drain.ts';

describe('native shutdown resource lifetime', () => {
  it('waits for late background work from a disconnected GET before closing resources', async () => {
    const bridge = createNodeBridge();
    const tasks = new TaskGroup(() => {
      // This fixture's tasks settle successfully.
    });
    const requests = new TaskGroup(() => {
      // The public request has already disconnected before shutdown begins.
    });
    const disconnected = Promise.withResolvers<undefined>();
    const releaseHandler = Promise.withResolvers<undefined>();
    const registered = Promise.withResolvers<undefined>();
    const releaseBackground = Promise.withResolvers<undefined>();
    const bridgeStarted = Promise.withResolvers<undefined>();
    const bridgeEnded = Promise.withResolvers<undefined>();
    let cacheOpen = true;
    let usedOpenCache = false;
    let completed = false;
    let draining: Promise<boolean> | undefined;
    const background = async (): Promise<void> => {
      registered.resolve(undefined);
      await releaseBackground.promise;
      usedOpenCache = cacheOpen;
    };
    try {
      const response = await bridge.invokeNodeHandler({
        request: new Request('https://app.test/disconnected'),
        requestMeta: {},
        waitUntil: tasks.waitUntil,
        handler: async (_req, res, ctx) => {
          res.once('close', () => {
            disconnected.resolve(undefined);
          });
          res.write('accepted');
          await releaseHandler.promise;
          ctx.waitUntil?.(background());
        },
      });
      await response.body?.cancel();
      await disconnected.promise;

      expect(tasks.size).toBe(0);

      const shutdown = async (): Promise<boolean> => {
        const result = await drainNativeWork({
          requests,
          tasks,
          remaining: () => 2000,
          closeBridge: async (timeout) => {
            bridgeStarted.resolve(undefined);
            const bridgeClosed = await bridge.close(timeout);
            bridgeEnded.resolve(undefined);
            return bridgeClosed;
          },
        });
        cacheOpen = false;
        completed = true;
        return result;
      };
      draining = shutdown();
      await bridgeStarted.promise;
      releaseHandler.resolve(undefined);
      await registered.promise;
      await bridgeEnded.promise;
      await tick();

      expect(completed).toBe(false);
      expect(cacheOpen).toBe(true);

      releaseBackground.resolve(undefined);

      await expect(draining).resolves.toBe(true);
      expect(usedOpenCache).toBe(true);
      expect(cacheOpen).toBe(false);
    } finally {
      releaseHandler.resolve(undefined);
      releaseBackground.resolve(undefined);
      await bridge.close(2000);
      await tasks.drain(2000);
      await draining;
    }
  });
});
