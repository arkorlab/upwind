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
    const letGo = retain(KEPT_BYTES, Symbol('kept'));
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
   * Beside a chunk building, which gives its room back whatever is kept, what a run keeps counts
   * though that run is waiting for room: its own chunk waits for the room it leaves, and builds
   * alone once the chunk ahead of it is over.
   */
  it('counts what a waiting run keeps against what is let in beside a chunk', async () => {
    vi.useFakeTimers();
    const run = Symbol('waiting');
    const letGo = retain(KEPT_BYTES, run);
    const built: string[] = [];
    const held = Promise.withResolvers<undefined>();

    const chunks = [
      withProjectionMemory(PROJECTION_MEMORY_BYTES - KEPT_BYTES, async () => {
        built.push('building');
        await held.promise;
      }),
      withProjectionMemory(
        1,
        () => {
          built.push('its own');
          return Promise.resolve();
        },
        run,
      ),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const whileBuilding = [...built];
    held.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(chunks);
    letGo();

    expect(whileBuilding).toStrictEqual(['building']);
    expect(built).toStrictEqual(['building', 'its own']);
  });

  /**
   * What a run not waiting for room keeps goes as that run goes on, which needs no room: a chunk
   * that would build alone waits for it where it leaves the chunk no room, as long as it is kept,
   * and what several runs keep counts together.
   */
  it('holds a chunk that would build alone back for what other runs keep, until it goes', async () => {
    vi.useFakeTimers();
    const letGoOne = retain(KEPT_BYTES, Symbol('one'));
    const letGoOther = retain(KEPT_BYTES, Symbol('other'));
    let built = false;

    const chunk = withProjectionMemory(
      PROJECTION_MEMORY_BYTES - KEPT_BYTES,
      () => {
        built = true;
        return Promise.resolve();
      },
      Symbol('alone'),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const whileBothAreKept = built;
    letGoOne();
    await vi.advanceTimersByTimeAsync(1000);
    const onceOneGoes = built;
    letGoOther();
    await vi.advanceTimersByTimeAsync(1000);
    await chunk;

    expect(whileBothAreKept).toBe(false);
    expect(onceOneGoes).toBe(true);
  });

  /**
   * What a run keeps goes only as that run goes on, which it does only once its next chunk is let
   * in: that chunk is let in alone however much its own run keeps.
   */
  it('lets the chunk of a run build alone however much that run keeps', async () => {
    vi.useFakeTimers();
    const run = Symbol('run');
    const letGo = retain(PROJECTION_MEMORY_BYTES, run);
    let built = false;

    const chunk = withProjectionMemory(
      PROJECTION_MEMORY_BYTES,
      () => {
        built = true;
        return Promise.resolve();
      },
      run,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const whileKept = built;
    letGo();
    await vi.advanceTimersByTimeAsync(1000);
    await chunk;

    expect(whileKept).toBe(true);
  });

  /**
   * Two runs that each keep a record and wait for room, the first in line with no room beside what
   * the other keeps: counted, the other's record would hold the first back until the other run went
   * on, and that run waits behind it. Neither holds the other back, and each builds in its turn.
   */
  it('lets the first of two runs that each keep a record and wait build, then the other', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    // A chunk of a third run takes the whole of it, so that both runs wait.
    const ahead = Promise.withResolvers<undefined>();
    const first = withProjectionMemory(PROJECTION_MEMORY_BYTES, () => ahead.promise);
    const runs = { one: Symbol('one'), other: Symbol('other') };
    const letGoOne = retain(KEPT_BYTES, runs.one);
    const letGoOther = retain(KEPT_BYTES, runs.other);
    // Each run lets its record go as it goes on, once its chunk has built.
    const chunkOf = (name: 'one' | 'other', letGo: () => void): Promise<void> => {
      return withProjectionMemory(
        PROJECTION_MEMORY_BYTES,
        () => {
          built.push(name);
          letGo();
          return Promise.resolve();
        },
        runs[name],
      );
    };

    const chunks = [chunkOf('one', letGoOne), chunkOf('other', letGoOther)];
    await vi.advanceTimersByTimeAsync(1000);
    const whileAheadBuilds = [...built];
    ahead.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    const onceAheadIsOver = [...built];
    // Whatever is still kept is let go of, so that every chunk ends either way.
    letGoOne();
    letGoOther();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, ...chunks]);

    expect(whileAheadBuilds).toStrictEqual([]);
    expect(onceAheadIsOver).toStrictEqual(['one', 'other']);
  });

  /**
   * A record an object kept when it was reset is renewed no more, and its room lapses with it: until
   * then it holds back even a chunk that would build alone, as its run is not waiting for room.
   */
  it('takes back the room of a record whose object was reset as it kept it', async () => {
    vi.useFakeTimers();
    retain(PROJECTION_MEMORY_BYTES, Symbol('reset'));
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

    expect(beforeLapse).toStrictEqual([]);
    expect(afterLapse).toStrictEqual(['building', 'beside']);
  });
});
