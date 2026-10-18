import { DEFAULT_RUNTIME_CACHE_SETTINGS } from '@stayingupwind/host/delivery';
import { describe, expect, it } from 'vitest';

import { allowAnotherAsk, shouldAsk } from '../src/cache/regenerate.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { followClient, settle } from '../src/handlers/document-upstream.ts';
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

  it('lets an abandoned ask be made again at once', () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    const settings = DEFAULT_RUNTIME_CACHE_SETTINGS;

    expect(shouldAsk(edge, 'entry', settings)).toBe(true);

    const abandoned = allowAnotherAsk(edge, 'entry');

    expect(shouldAsk(edge, 'entry', settings)).toBe(false);

    abandoned();

    expect(shouldAsk(edge, 'entry', settings)).toBe(true);
  });

  it('lets no older abandonment undo a newer ask, even with the same clock reading', () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    const immediate = { ...DEFAULT_RUNTIME_CACHE_SETTINGS, regenerateCooldownMs: 0 };
    shouldAsk(edge, 'entry', immediate);
    const older = allowAnotherAsk(edge, 'entry');
    shouldAsk(edge, 'entry', immediate);

    older();

    expect(shouldAsk(edge, 'entry', DEFAULT_RUNTIME_CACHE_SETTINGS)).toBe(false);
  });

  it('lets another ask through when a resume rejects before answering', async () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    shouldAsk(edge, 'entry', DEFAULT_RUNTIME_CACHE_SETTINGS);
    const regeneration = { onAbandoned: allowAnotherAsk(edge, 'entry') };
    const error = new Error('the Worker did not answer');

    const result = await settle(Promise.reject(error), regeneration);

    expect(result).toStrictEqual({ ok: false, error });
    expect(shouldAsk(edge, 'entry', DEFAULT_RUNTIME_CACHE_SETTINGS)).toBe(true);
  });

  it('keeps an answered resume on cooldown when the client leaves before the splice holds it', async () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    shouldAsk(edge, 'entry', DEFAULT_RUNTIME_CACHE_SETTINGS);
    const regeneration = { onAbandoned: allowAnotherAsk(edge, 'entry') };
    const response = Promise.resolve(new Response('suffix'));
    let aborted = false;
    const handle = {
      response,
      abort: () => {
        aborted = true;
      },
    };
    const client = new AbortController();
    const left = followClient(client.signal, handle, regeneration);
    await settle(response, regeneration);

    client.abort();

    expect(left()).toBe(true);
    expect(aborted).toBe(true);
    expect(shouldAsk(edge, 'entry', DEFAULT_RUNTIME_CACHE_SETTINGS)).toBe(false);
  });
});
