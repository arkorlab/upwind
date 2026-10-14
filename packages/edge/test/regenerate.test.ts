import { DEFAULT_RUNTIME_CACHE_SETTINGS } from '@stayingupwind/host/delivery';
import { describe, expect, it } from 'vitest';

import { shouldAsk } from '../src/cache/regenerate.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

/**
 * How often an isolate asks for an entry's regeneration (`shouldAsk`): once per the policy's
 * cooldown, however long the policy makes it.
 */

const HOUR = 3_600_000;

/** What `shouldAsk` reads of a request: the manifest, the isolate's clock and its memory. */
function edgeAt(clock: { now: number }): EdgeContext {
  const now = (): number => clock.now;
  const runtime: EdgeRuntime = {
    fetchImpl: (request) => fetch(request),
    now,
    memory: createEdgeMemory(now),
    dispatchApp: undefined,
    transformImage: undefined,
    blobWorker: undefined,
  };
  return { manifestId: 'manifest', runtime } as EdgeContext;
}

describe('a regeneration asked for', () => {
  it('is not asked for again within a cooldown longer than an hour, and is once it is over', () => {
    const clock = { now: 1_800_000_000_000 };
    const edge = edgeAt(clock);
    const settings = { ...DEFAULT_RUNTIME_CACHE_SETTINGS, regenerateCooldownMs: 2 * HOUR };

    const first = shouldAsk(edge, 'entry', settings);
    clock.now += HOUR + 1;
    const within = shouldAsk(edge, 'entry', settings);
    clock.now += HOUR;
    const past = shouldAsk(edge, 'entry', settings);

    expect([first, within, past]).toStrictEqual([true, false, true]);
  });
});
