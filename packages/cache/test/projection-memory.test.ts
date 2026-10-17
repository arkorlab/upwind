import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROJECTION_MEMORY_BYTES, withProjectionMemory } from '../src/scope/projection-memory.ts';

/** How long a claim lasts without its object renewing it (`CLAIM_LAPSE_MS`). */
const CLAIM_LAPSE_MS = 5000;
const MINUTE_MS = 60_000;

/** The memory the settle runs of an isolate build delivery records in, one budget for them all. */
describe('the memory an isolate builds records in', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets chunks that each take the whole of it build one at a time, in the order they asked', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    const first = Promise.withResolvers<undefined>();

    const chunks = [
      withProjectionMemory(PROJECTION_MEMORY_BYTES, async () => {
        built.push('first');
        await first.promise;
      }),
      withProjectionMemory(PROJECTION_MEMORY_BYTES, () => {
        built.push('second');
        return Promise.resolve();
      }),
      withProjectionMemory(1, () => {
        built.push('third');
        return Promise.resolve();
      }),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const whileFirstBuilds = [...built];
    first.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(chunks);

    expect(whileFirstBuilds).toStrictEqual(['first']);
    expect(built).toStrictEqual(['first', 'second', 'third']);
  });

  /** A record the run cannot reckon the memory of is still built, as the whole budget's worth. */
  it('lets a chunk it cannot reckon build alone, as one that takes the whole of it', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    const first = Promise.withResolvers<undefined>();

    const chunks = [
      withProjectionMemory(NaN, async () => {
        built.push('unreckoned');
        await first.promise;
      }),
      withProjectionMemory(1, () => {
        built.push('small');
        return Promise.resolve();
      }),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const whileFirstBuilds = [...built];
    first.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(chunks);

    expect(whileFirstBuilds).toStrictEqual(['unreckoned']);
    expect(built).toStrictEqual(['unreckoned', 'small']);
  });

  /**
   * A build that takes long — a read of storage that does not answer for minutes, say — is still
   * its object's: the object renews its claim for as long as the build runs, and the room stays
   * taken.
   */
  it('keeps the room of a chunk that builds for longer than a claim lasts unrenewed', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    const slow = Promise.withResolvers<undefined>();
    const first = withProjectionMemory(PROJECTION_MEMORY_BYTES, async () => {
      built.push('slow');
      await slow.promise;
    });
    // Two minutes on, and the build has not ended.
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    const next = withProjectionMemory(PROJECTION_MEMORY_BYTES, () => {
      built.push('next');
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(1000);
    const whileSlowBuilds = [...built];
    slow.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, next]);

    expect(whileSlowBuilds).toStrictEqual(['slow']);
    expect(built).toStrictEqual(['slow', 'next']);
  });

  /**
   * An object reset while its chunk builds never comes back to give its room back, and its timers
   * go with it: nothing renews its claim, which lapses rather than holding every other scope's
   * records for good.
   */
  it('takes back the room of a chunk whose object was reset as it built', async () => {
    vi.useFakeTimers();
    void withProjectionMemory(
      PROJECTION_MEMORY_BYTES,
      () =>
        new Promise(() => {
          // Never settles, as the build of an object reset under it does not.
        }),
    ).catch(() => {
      // Nor fails: nothing of it is heard again.
    });
    // Its object reset: the timer that renewed its claim never fires again.
    vi.clearAllTimers();
    let built = false;

    const next = withProjectionMemory(PROJECTION_MEMORY_BYTES, () => {
      built = true;
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(CLAIM_LAPSE_MS - 1000);
    const beforeLapse = built;
    await vi.advanceTimersByTimeAsync(2000);
    await next;

    expect(beforeLapse).toBe(false);
    expect(built).toBe(true);
  });
});
