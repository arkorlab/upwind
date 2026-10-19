import { describe, expect, it, vi } from 'vitest';

import { type LocalWorker, miniflareHookFound, runWorkers } from '../src/miniflare.ts';

/**
 * Who handles the stopping signals while stacks run: Miniflare's exit hook is one set of handlers
 * for the process, whatever instances it serves, so a stack whose caller handles the signals has
 * to hold the set aside for as long as it runs, however many other stacks start or stop meanwhile.
 */

const START_MS = 60_000;
const WORKER: LocalWorker = {
  name: 'quiet',
  modules: [
    {
      type: 'ESModule',
      name: 'index.mjs',
      contents: 'export default { fetch: () => new Response("quiet") };',
    },
  ],
  compatibilityDate: '2026-09-15',
};

function ignore(): void {
  // Nothing the Worker logs is read here.
}

/** Whether Miniflare's handler of `SIGTERM`, which exits the process at once, is on it. */
function miniflareHandles(): boolean {
  const handlers = process.listeners('SIGTERM');
  return handlers.some(
    (each) => each.name === 'onSignalTerm' && String(each).includes('runCallbacks'),
  );
}

describe('the stopping signals, where a caller handles them', () => {
  it(
    'find the exit hook of the Miniflare this package runs, and say nothing of it missing',
    async () => {
      // Were Miniflare's hook to read otherwise, a caller's stack would find none of it, say so,
      // and leave the process to exit at once on a signal: this fails before that ships.
      const said: string[] = [];
      const heard = (message: string): void => {
        said.push(message);
      };
      const caller = await runWorkers([WORKER], heard, 'caller');
      const found = miniflareHookFound();
      await caller.dispose();

      expect(found).toBe(true);
      expect(said).toStrictEqual([]);
    },
    START_MS,
  );

  it(
    "are the caller's while its stack runs beside another, and Miniflare's again after",
    async () => {
      const other = await runWorkers([WORKER], ignore);
      const handled = [miniflareHandles()];
      const caller = await runWorkers([WORKER], ignore, 'caller');
      handled.push(miniflareHandles());
      // A stack started meanwhile leaves them the caller's.
      const meanwhile = await runWorkers([WORKER], ignore);
      handled.push(miniflareHandles());
      await caller.dispose();
      handled.push(miniflareHandles());
      await other.dispose();
      await meanwhile.dispose();
      handled.push(miniflareHandles());

      expect(handled).toStrictEqual([true, false, false, true, false]);
    },
    START_MS,
  );

  it(
    "are Miniflare's again for a stack started after the caller's, once the caller's is gone",
    async () => {
      const caller = await runWorkers([WORKER], ignore, 'caller');
      const handled = [miniflareHandles()];
      const later = await runWorkers([WORKER], ignore);
      handled.push(miniflareHandles());
      await caller.dispose();
      handled.push(miniflareHandles());
      await later.dispose();
      handled.push(miniflareHandles());

      expect(handled).toStrictEqual([false, false, true, false]);
    },
    START_MS,
  );

  it(
    "are Miniflare's again after the caller's stack, though a stack beside it was let go of first",
    async () => {
      const other = await runWorkers([WORKER], ignore);
      const caller = await runWorkers([WORKER], ignore, 'caller');
      // Miniflare's hook keeps its handlers while any instance holds it: the caller's stack still does.
      await other.dispose();
      const handled = [miniflareHandles()];
      const later = await runWorkers([WORKER], ignore);
      handled.push(miniflareHandles());
      await caller.dispose();
      handled.push(miniflareHandles());
      await later.dispose();
      handled.push(miniflareHandles());

      expect(handled).toStrictEqual([false, false, true, false]);
    },
    START_MS,
  );

  it(
    "leave a caller's own handler of the name Miniflare gives its own where it is",
    async () => {
      // The caller's, named as Miniflare names its own.
      const onSignalTerm = (): void => {
        process.exitCode = 0;
      };
      process.on('SIGTERM', onSignalTerm);
      try {
        const caller = await runWorkers([WORKER], ignore, 'caller');
        const kept = [process.listeners('SIGTERM').includes(onSignalTerm), miniflareHandles()];
        await caller.dispose();
        kept.push(process.listeners('SIGTERM').includes(onSignalTerm));

        expect(kept).toStrictEqual([true, false, true]);
      } finally {
        process.removeListener('SIGTERM', onSignalTerm);
      }
    },
    START_MS,
  );

  it(
    "are the caller's while one of two such stacks runs, however often the other is let go of",
    async () => {
      const first = await runWorkers([WORKER], ignore, 'caller');
      const second = await runWorkers([WORKER], ignore, 'caller');
      await Promise.all([first.dispose(), first.dispose()]);
      await first.dispose();
      const handled = [miniflareHandles()];
      await second.dispose();
      handled.push(miniflareHandles());

      expect(handled).toStrictEqual([false, false]);
    },
    START_MS,
  );

  it(
    'are put back where saying the hook is missing throws, the stack let go of',
    async () => {
      // No hook of Miniflare's to be found, and a caller whose own log throws at saying so.
      const listeners = vi.spyOn(process, 'listeners').mockReturnValue([]);
      const thrown = runWorkers(
        [WORKER],
        () => {
          throw new Error('the log is closed');
        },
        'caller',
      );

      await expect(thrown).rejects.toThrow('the log is closed');

      listeners.mockRestore();
      // Let go of: a stack started after it, whose caller leaves the signals to Miniflare, finds
      // no caller's stack running, and leaves them Miniflare's.
      const after = await runWorkers([WORKER], ignore);
      const handled = miniflareHandles();
      await after.dispose();

      expect(handled).toBe(true);
    },
    START_MS,
  );
});
