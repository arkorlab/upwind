import { DEFAULT_RUNTIME_CACHE_SETTINGS } from '@stayingupwind/host/delivery';
import { describe, expect, it, vi } from 'vitest';

import { allowAnotherAsk, shouldAsk } from '../src/cache/regenerate.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { followClient, followResume, settle } from '../src/handlers/document-upstream.ts';
import type { DocumentInput } from '../src/handlers/document.ts';
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
  it.each([
    ['a', 'b:c', 'a:b', 'c'],
    ['a/', 'b:c', 'a/:b', 'c'],
    ['漢', '字:é', '漢:字', 'é'],
    ['\u{D800}', 'x:y', '\u{D800}:x', 'y'],
  ])('keeps distinct manifest/entry pairs on separate cooldowns: %j', (left, a, right, b) => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    const first = { ...edge, manifestId: left };
    const second = { ...edge, manifestId: right };
    const settings = DEFAULT_RUNTIME_CACHE_SETTINGS;

    expect([
      shouldAsk(first, a, settings),
      shouldAsk(second, b, settings),
      shouldAsk(first, a, settings),
      shouldAsk(second, b, settings),
    ]).toStrictEqual([true, true, false, false]);
  });

  it('returns only the abandoned pair while another pair keeps its reservation', () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    const first = { ...edge, manifestId: 'a' };
    const second = { ...edge, manifestId: 'a:b' };
    const settings = DEFAULT_RUNTIME_CACHE_SETTINGS;
    shouldAsk(first, 'b:c', settings);
    const abandonFirst = allowAnotherAsk(first, 'b:c');
    // A newer reservation at the same clock reading still belongs to the other pair.
    shouldAsk(second, 'c', { ...settings, regenerateCooldownMs: 0 });
    const abandonSecond = allowAnotherAsk(second, 'c');

    abandonFirst();
    const afterFirst = [shouldAsk(first, 'b:c', settings), shouldAsk(second, 'c', settings)];
    abandonSecond();
    const afterSecond = [shouldAsk(first, 'b:c', settings), shouldAsk(second, 'c', settings)];

    expect([afterFirst, afterSecond]).toStrictEqual([
      [true, false],
      [false, true],
    ]);
  });

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

  it.each(['rejection', 'clientAbort'] as const)(
    'returns a build-fallback ask after a pre-answer %s',
    async (failure) => {
      const edge = edgeAt({ now: 1_800_000_000_000 });
      shouldAsk(edge, 'build-key', DEFAULT_RUNTIME_CACHE_SETTINGS);
      const client = new AbortController();
      const input = {
        request: new Request('https://site.example/completed', { signal: client.signal }),
        generation: undefined,
        onBuildAbandoned: allowAnotherAsk(edge, 'build-key'),
      } as DocumentInput;
      const pending = Promise.withResolvers<Response>();
      const error = new Error('resume did not answer');
      const abort = vi.fn(() => {
        pending.reject(error);
      });
      const followed = followResume(input, { response: pending.promise, abort });

      const abandon = {
        rejection: () => {
          pending.reject(error);
        },
        clientAbort: () => {
          client.abort();
        },
      };
      abandon[failure]();
      await followed.upstream;
      followed.clientLeft();

      expect(shouldAsk(edge, 'build-key', DEFAULT_RUNTIME_CACHE_SETTINGS)).toBe(true);
      expect(abort).toHaveBeenCalledTimes(failure === 'clientAbort' ? 1 : 0);
    },
  );

  it('keeps an answered build-fallback ask when its client later leaves', async () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    shouldAsk(edge, 'build-key', DEFAULT_RUNTIME_CACHE_SETTINGS);
    const client = new AbortController();
    const input = {
      request: new Request('https://site.example/completed', { signal: client.signal }),
      generation: undefined,
      onBuildAbandoned: allowAnotherAsk(edge, 'build-key'),
    } as DocumentInput;
    const followed = followResume(input, {
      response: Promise.resolve(new Response()),
      abort: vi.fn(),
    });

    await followed.upstream;
    client.abort();
    followed.clientLeft();

    expect(shouldAsk(edge, 'build-key', DEFAULT_RUNTIME_CACHE_SETTINGS)).toBe(false);
  });

  it('keeps a newer build-fallback ask when an older resume rejects', async () => {
    const edge = edgeAt({ now: 1_800_000_000_000 });
    shouldAsk(edge, 'build-key', DEFAULT_RUNTIME_CACHE_SETTINGS);
    const input = {
      request: new Request('https://site.example/completed'),
      generation: undefined,
      onBuildAbandoned: allowAnotherAsk(edge, 'build-key'),
    } as DocumentInput;
    const pending = Promise.withResolvers<Response>();
    const followed = followResume(input, { response: pending.promise, abort: vi.fn() });
    shouldAsk(edge, 'build-key', { ...DEFAULT_RUNTIME_CACHE_SETTINGS, regenerateCooldownMs: 0 });

    pending.reject(new Error('older resume failed'));
    await followed.upstream;
    followed.clientLeft();

    expect(shouldAsk(edge, 'build-key', DEFAULT_RUNTIME_CACHE_SETTINGS)).toBe(false);
  });
});
