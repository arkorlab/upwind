import { fileURLToPath } from 'node:url';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bundleInlineWorker } from './inline-worker.ts';

// The time each test had where this suite ran before: it starts workerd and Miniflare, which a
// loaded machine can take longer than the default to have ready (Sentry).
vi.setConfig({ testTimeout: 60_000 });

/**
 * A task queue that stops pumping, which is how a request ends up waiting on nothing at all.
 *
 * `TaskScope` runs its queue from an immediate and keeps one in flight at a time: `#schedulePump`
 * returns without scheduling while `#pumping` is set, and only the immediate it scheduled clears
 * it. workerd cancels an immediate when the request that scheduled it is over, and a cancelled
 * immediate never runs its callback — so a pump scheduled by a request that then finishes leaves
 * `#pumping` set for good. Every later `#schedulePump` on that scope returns at once, nothing is
 * scheduled, and a task queued behind it waits forever with no timer and no I/O outstanding.
 * That is what workerd reports as a Worker whose "code had hung and would never generate a
 * response", and what the edge answered 502 for on 2026-09-23.
 *
 * The scope this can happen to is the one shared between requests: `#scope()` falls back to it
 * for anything scheduled outside `runWithTaskScheduler`, which is every entrypoint on Next.js's
 * edge runtime — a graph that lives in the same isolate as the Node.js one.
 *
 * The Worker below drives that scope from two requests: the first leaves a pump in flight and
 * ends, the second queues a task on it and waits.
 */

const REQUEST_TIMEOUT_MS = 5000;
const SCHEDULER = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));

const WORKER = `
import { installTaskScheduler } from ${JSON.stringify(SCHEDULER)};
const scheduler = installTaskScheduler();

/**
 * Nothing here runs inside \`runWithTaskScheduler\`, so every task and immediate below belongs to
 * the scope shared between requests — the one an edge-runtime entrypoint uses.
 */
export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/leave-a-pump-in-flight') {
      // An immediate is always outstanding, as React's work is while a render is going: \`#pump\`
      // keeps finding \`#pending\` non-empty, so it keeps setting \`#pumping\` and scheduling the
      // pump that would clear it. Answering now ends the request, and workerd cancels both the
      // chain and the pump in flight — neither callback ever runs again.
      const chain = () => { setImmediate(chain); };
      chain();
      scheduler.taskTimer(() => {}, 0);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return new Response('left');
    }

    // A later request queues a task of its own on the same scope and waits for it.
    const ran = await new Promise((resolve) => {
      scheduler.taskTimer(() => { resolve(true); }, 0);
      setTimeout(() => { resolve(false); }, 1000);
    });
    return Response.json({ ran });
  },
};
`;

describe('the shared task scope after a request leaves a pump in flight', () => {
  let runtime: Miniflare | undefined;
  let origin: URL;

  beforeEach(async () => {
    const bundled = await bundleInlineWorker({
      stdin: {
        contents: WORKER,
        sourcefile: 'task-pump-latch.mjs',
        resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2024',
      external: ['node:*'],
    });
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({
        workers: [
          {
            name: 'task-pump-latch',
            modulesRoot: '/task-pump-latch',
            modules: [
              {
                type: 'ESModule',
                path: '/task-pump-latch/index.mjs',
                contents: bundled.outputFiles[0]!.text,
              },
            ],
            compatibilityDate: '2026-09-15',
            compatibilityFlags: ['nodejs_compat'],
            unsafeDirectSockets: [{ proxy: false }],
          },
        ],
      }),
      log: new Log(LogLevel.NONE),
    });
    await runtime.ready;
    origin = await runtime.unsafeGetDirectURL('task-pump-latch');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  function request(path: string): Promise<Response> {
    return fetch(new URL(path, origin), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  it('still runs the next request’s task', async () => {
    await expect((await request('/leave-a-pump-in-flight')).text()).resolves.toBe('left');

    const next = await request('/task');

    await expect(next.json()).resolves.toStrictEqual({ ran: true });
  });
});
