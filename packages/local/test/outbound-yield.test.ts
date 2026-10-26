import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bundleWorker } from '../src/bundle.ts';
import { type RunningWorkers, runWorkers } from '../src/miniflare.ts';

/**
 * A Function that fetches its own site without pause, as an application polling its own data does
 * in the background: the stack goes on answering everyone else.
 *
 * Its self-fetches go to the edge by a binding, within the one runtime, and the edge answers them
 * there too. Each turn of such a loop puts the next on the runtime's queue before the queue empties,
 * and the runtime only asks the system for new connections and due timers once it has: the loop
 * shut the stack out of both for as long as it ran, which a timer of its own could not end. A
 * deployed Function's self-fetch leaves the process and comes back over the network.
 */

const START_MS = 60_000;
/** How long the background loop runs at the most: its own timer, which has to fire to end it. */
const SPIN_MS = 3000;
/** How long a request from outside may take while the loop runs. */
const ANSWER_MS = 2000;
/** How often the loop's state is asked for. */
const POLL_MS = 50;

interface LoopState {
  readonly spins: number;
  readonly ended: string;
}

async function spinningWorkers(): Promise<RunningWorkers> {
  const outbound = await bundleWorker(
    fileURLToPath(new URL('../src/workers/outbound.ts', import.meta.url)),
  );
  const site = 'https://site.test';
  return runWorkers(
    [
      {
        name: 'function',
        compatibilityDate: '2026-09-15',
        modules: [
          {
            type: 'ESModule',
            name: 'index.mjs',
            contents: `
let spins = 0;
let ended = 'running';
export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/spin') {
      const signal = AbortSignal.timeout(${String(SPIN_MS)});
      ctx.waitUntil((async () => {
        try {
          while (true) {
            const answer = await fetch(new URL('/data', env.SITE), { signal });
            await answer.text();
            spins += 1;
          }
        } catch (error) {
          ended = error.name;
        }
      })());
      return new Response('spinning');
    }
    return Response.json({ spins, ended });
  },
};`,
          },
        ],
        bindings: { SITE: site },
        outbound: 'outbound',
        socket: {},
      },
      {
        name: 'outbound',
        compatibilityDate: '2026-09-15',
        modules: [{ type: 'ESModule', name: 'index.mjs', contents: outbound.script }],
        bindings: { SITE_ORIGINS: site },
        services: { EDGE: 'edge' },
      },
      {
        name: 'edge',
        compatibilityDate: '2026-09-15',
        modules: [
          {
            type: 'ESModule',
            name: 'index.mjs',
            contents: `export default { fetch: () => new Response('pending') };`,
          },
        ],
      },
    ],
    () => {
      // Nothing the fixture Workers log is read here.
    },
  );
}

describe("a Function fetching its own site without pause, in the stack's background", () => {
  it(
    'leaves the stack answering others, and its own timer ending the loop',
    async () => {
      const running = await spinningWorkers();
      try {
        const url = await running.url('function');
        const started = await fetch(new URL('/spin', url), {
          signal: AbortSignal.timeout(ANSWER_MS),
        });

        await expect(started.text()).resolves.toBe('spinning');

        // Asked until the loop is seen running, each answer in time — the stack answering others
        // while the loop goes on — and then until the loop's own timer has ended it. Asked once, the
        // state could come before the loop's first fetch returned (greptile).
        const stateUntil = async (done: (state: LoopState) => boolean): Promise<LoopState> => {
          const end = Date.now() + SPIN_MS + ANSWER_MS;
          for (;;) {
            const answer = await fetch(new URL('/state', url), {
              signal: AbortSignal.timeout(ANSWER_MS),
            });
            const state = (await answer.json()) as LoopState;
            if (done(state) || Date.now() > end) {
              return state;
            }
            await sleep(POLL_MS);
          }
        };

        const during = await stateUntil((state) => state.spins > 0);
        const after = await stateUntil((state) => state.ended !== 'running');

        expect(during).toMatchObject({ ended: 'running' });
        expect(during.spins).toBeGreaterThan(0);
        expect(after).toMatchObject({ ended: 'TimeoutError' });
      } finally {
        await running.dispose();
      }
    },
    START_MS,
  );
});
