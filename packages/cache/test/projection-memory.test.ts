import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECTION_MEMORY_BYTES,
  retain,
  withProjectionMemory,
  withProjectionMemoryAtOnce,
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
   * And against a chunk that would build alone: no run waits with a record kept, so what runs keep
   * goes as they go on, which needs no room. What several runs keep counts together.
   */
  it('holds a chunk that would build alone back for what runs keep, until it goes', async () => {
    vi.useFakeTimers();
    const letGoOne = retain(KEPT_BYTES);
    const letGoOther = retain(KEPT_BYTES);
    let built = false;

    const chunk = withProjectionMemory(PROJECTION_MEMORY_BYTES - KEPT_BYTES, () => {
      built = true;
      return Promise.resolve();
    });
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

  /** A chunk let in at once asks nothing of its run, which keeps what it keeps. */
  it('asks nothing of the run of a chunk let in at once', async () => {
    vi.useFakeTimers();
    const letGo = retain(KEPT_BYTES);
    const beforeWait = vi.fn();

    await withProjectionMemory(
      PROJECTION_MEMORY_BYTES - KEPT_BYTES,
      () => Promise.resolve(),
      beforeWait,
    );
    letGo();

    expect(beforeWait).not.toHaveBeenCalled();
  });

  /**
   * A chunk with no room at once has its run let go of what it keeps before it waits: no record
   * waits with a run, and what the run kept may be all that stood in the chunk's way.
   */
  it('has the run of a chunk with no room let go of what it keeps before it waits', async () => {
    vi.useFakeTimers();
    const letGo = retain(KEPT_BYTES);
    const events: string[] = [];
    const held = Promise.withResolvers<undefined>();

    const chunks = [
      withProjectionMemory(PROJECTION_MEMORY_BYTES - KEPT_BYTES, async () => {
        events.push('building');
        await held.promise;
      }),
      withProjectionMemory(
        1,
        () => {
          events.push('its own');
          return Promise.resolve();
        },
        () => {
          events.push('let go');
          letGo();
        },
      ),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const whileBuilding = [...events];
    held.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(chunks);
    letGo();

    // Let in beside the chunk building once its run's record was gone.
    expect(whileBuilding).toStrictEqual(['building', 'let go', 'its own']);
  });

  /**
   * Two runs that each keep a record and then wait for room. Kept on, the records would hold the
   * first in line back for good — one its own, the other the run's waiting behind it. Each run lets
   * go of its record before it waits, once however long it waits, and both go on in turn: the first
   * is let in alone with the whole budget, which no record kept would leave it.
   */
  it('lets two runs that each keep a record and wait both go on, neither keeping it', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const kept: (() => void)[] = [];
    // A chunk of a third run takes the whole of it, so that both runs wait.
    const ahead = Promise.withResolvers<undefined>();
    const first = withProjectionMemory(PROJECTION_MEMORY_BYTES, () => ahead.promise);
    const runOf = (name: string): Promise<void> => {
      const letGo = retain(KEPT_BYTES);
      kept.push(letGo);
      return withProjectionMemory(
        PROJECTION_MEMORY_BYTES,
        () => {
          events.push(`${name} builds`);
          return Promise.resolve();
        },
        () => {
          events.push(`${name} lets go`);
          letGo();
        },
      );
    };

    const runs = [runOf('one'), runOf('other')];
    await vi.advanceTimersByTimeAsync(1000);
    const whileAheadBuilds = [...events];
    ahead.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    const onceAheadIsOver = [...events];
    // Whatever is still kept is let go of, so that every chunk ends either way.
    for (const letGo of kept) {
      letGo();
    }
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, ...runs]);

    expect(whileAheadBuilds).toStrictEqual(['one lets go', 'other lets go']);
    expect(onceAheadIsOver).toStrictEqual([
      'one lets go',
      'other lets go',
      'one builds',
      'other builds',
    ]);
  });

  /**
   * What an answer builds waits for no room: it is built where there is room for it at once, beside
   * a chunk building, and not at all where there is none. Its room is held while it builds.
   */
  it('builds what an answer asks for only where there is room at once, and holds it as it builds', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    const held = Promise.withResolvers<undefined>();
    const building = withProjectionMemory(PROJECTION_MEMORY_BYTES - 2, async () => {
      built.push('building');
      await held.promise;
    });

    const beside = await withProjectionMemoryAtOnce(1, () => {
      built.push('beside');
      return Promise.resolve('record');
    });
    const tooMuch = await withProjectionMemoryAtOnce(3, () => {
      built.push('too much');
      return Promise.resolve('record');
    });
    held.resolve(undefined);
    await building;
    const answered = Promise.withResolvers<undefined>();
    const answering = withProjectionMemoryAtOnce(PROJECTION_MEMORY_BYTES, async () => {
      built.push('answering');
      await answered.promise;
    });
    const chunk = withProjectionMemory(1, () => {
      built.push('chunk');
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(1000);
    const whileAnswering = [...built];
    answered.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([answering, chunk]);

    expect([beside, tooMuch]).toStrictEqual(['record', undefined]);
    expect(whileAnswering).toStrictEqual(['building', 'beside', 'answering']);
    expect(built).toStrictEqual(['building', 'beside', 'answering', 'chunk']);
  });

  /**
   * Nor is it let in ahead of a chunk that waits for room, though there is room for it beside the
   * chunks building: a chunk let in at once is the first in line. Turned away, it leaves nothing
   * in the line, and the next chunk with room is let in at once.
   */
  it('lets nothing an answer asks for in ahead of a chunk that waits, and leaves nothing in line', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    const held = Promise.withResolvers<undefined>();
    const building = withProjectionMemory(PROJECTION_MEMORY_BYTES - 2, async () => {
      built.push('building');
      await held.promise;
    });
    const waiting = withProjectionMemory(3, () => {
      built.push('waiting');
      return Promise.resolve();
    });

    const answer = await withProjectionMemoryAtOnce(1, () => {
      built.push('answer');
      return Promise.resolve('record');
    });
    held.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([building, waiting]);
    const next = withProjectionMemory(1, () => {
      built.push('next');
      return Promise.resolve();
    });
    const atOnce = [...built];
    await next;

    expect(answer).toBeUndefined();
    expect(atOnce).toStrictEqual(['building', 'waiting', 'next']);
  });

  /**
   * A record an object kept when it was reset is renewed no more, and its room lapses with it: until
   * then it holds back even a chunk that would build alone.
   */
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

    expect(beforeLapse).toStrictEqual([]);
    expect(afterLapse).toStrictEqual(['building', 'beside']);
  });
});
