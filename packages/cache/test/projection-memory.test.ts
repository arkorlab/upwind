import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECTION_MEMORY_BYTES,
  retain,
  withProjectionMemory,
} from '../src/scope/projection-memory.ts';

/** How long a claim lasts without its object renewing it (`CLAIM_LAPSE_MS`). */
const CLAIM_LAPSE_MS = 5000;
const MINUTE_MS = 60_000;
/** The bytes of a record a run keeps past its chunk, as a commit's is. */
const KEPT_BYTES = 1024;

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

  /**
   * A record a run keeps past the chunk that built it holds its bytes all the while: they count
   * against what is let in beside a chunk building, until the run lets them go.
   */
  it('counts a kept record against what is let in beside a chunk, until it is let go', async () => {
    vi.useFakeTimers();
    const letGo = retain(KEPT_BYTES);
    const built: string[] = [];
    const held = Promise.withResolvers<undefined>();

    const chunks = [
      withProjectionMemory(PROJECTION_MEMORY_BYTES - KEPT_BYTES, async () => {
        built.push('building');
        await held.promise;
      }),
      withProjectionMemory(1, () => {
        built.push('beside');
        return Promise.resolve();
      }),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const whileKept = [...built];
    letGo();
    await vi.advanceTimersByTimeAsync(1000);
    const onceLetGo = [...built];
    held.resolve(undefined);
    await Promise.all(chunks);

    expect(whileKept).toStrictEqual(['building']);
    expect(onceLetGo).toStrictEqual(['building', 'beside']);
  });

  /**
   * What runs keep goes only as those runs go on, and one of them may be the run waiting: a chunk
   * that would build alone is let in however much is kept, and every run goes on.
   */
  it('lets a chunk build alone however much runs keep', async () => {
    vi.useFakeTimers();
    const letGo = retain(PROJECTION_MEMORY_BYTES);
    let built = false;

    await withProjectionMemory(PROJECTION_MEMORY_BYTES, () => {
      built = true;
      return Promise.resolve();
    });
    letGo();

    expect(built).toBe(true);
  });

  /** A record an object kept when it was reset is renewed no more, and its room lapses with it. */
  it('takes back the room of a record whose object was reset as it kept it', async () => {
    vi.useFakeTimers();
    retain(PROJECTION_MEMORY_BYTES);
    // Its object reset: the timer that renewed its claim never fires again.
    vi.clearAllTimers();
    const built: string[] = [];
    const held = Promise.withResolvers<undefined>();

    const chunks = [
      withProjectionMemory(1, async () => {
        built.push('building');
        await held.promise;
      }),
      withProjectionMemory(1, () => {
        built.push('beside');
        return Promise.resolve();
      }),
    ];
    await vi.advanceTimersByTimeAsync(CLAIM_LAPSE_MS - 1000);
    const beforeLapse = [...built];
    await vi.advanceTimersByTimeAsync(2000);
    const afterLapse = [...built];
    held.resolve(undefined);
    await Promise.all(chunks);

    expect(beforeLapse).toStrictEqual(['building']);
    expect(afterLapse).toStrictEqual(['building', 'beside']);
  });
});
