import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROJECTION_MEMORY_BYTES, withProjectionMemory } from '../src/scope/projection-memory.ts';

/** Past what a chunk's room is held for without word from it (`BUILDING_LAPSE_MS`). */
const BUILDING_LAPSE_MS = 60_000;

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
   * An object reset while its chunk builds never comes back to give its room back: what nothing has
   * been heard of for long enough lapses, rather than holding every other scope's records for good.
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
    let built = false;

    const next = withProjectionMemory(PROJECTION_MEMORY_BYTES, () => {
      built = true;
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(BUILDING_LAPSE_MS - 1000);
    const beforeLapse = built;
    await vi.advanceTimersByTimeAsync(2000);
    await next;

    expect(beforeLapse).toBe(false);
    expect(built).toBe(true);
  });
});
