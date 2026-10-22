import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactRoom, ReadBudget } from '../src/function/read-budget.ts';

const LIMIT = 32 * 1024 * 1024;
/**
 * How long a claim nothing renews lasts at the least: five looks of a read that waits, each fifty
 * of its askings 20 ms apart (`LOOKS_TO_LAPSE`, `ASKS_A_LOOK`).
 */
const LAPSE_MS = 5000;
/** Where the clock stands while the timers here fire. */
const FROZEN_AT = 1_800_000_000_000;
/** How long the reads here wait for room before they give up, as the Function's reads have one. */
const WAIT_MS = 10_000;
/** Several requests in one isolate: their observations must not combine into a shorter lapse. */
const WAITERS = 8;

/** A signal that aborts once `WAIT_MS` have gone by, as a read's deadline does. */
function deadline(): AbortSignal {
  const given = new AbortController();
  setTimeout(() => {
    given.abort(new Error('no room in time'));
  }, WAIT_MS);
  return given.signal;
}

/** Room for a read of `bytes`, as the Function's reads ask for it (`ArtifactRoom`). */
function hold(budget: ReadBudget, bytes: number, signal: AbortSignal): Promise<() => void> {
  return new ArtifactRoom(budget).hold(bytes, signal);
}

/**
 * Timers that fire as time is moved on, under a clock that does not move with them: as a request's
 * stands still on a Workers host while its code runs, moved only by its I/O. Whatever lapses here
 * lapses by the timers alone.
 */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(Date, 'now').mockReturnValue(FROZEN_AT);
  vi.spyOn(performance, 'now').mockReturnValue(0);
}

/** What a hold has come to so far: held, given up, or still waiting. */
function watched(held: Promise<() => void>): { readonly now: () => string } {
  let state = 'waiting';
  const watch = async (): Promise<void> => {
    try {
      await held;
      state = 'held';
    } catch {
      state = 'given up';
    }
  };
  void watch().catch(() => {
    // Never rejects: what it waits on is caught inside.
  });
  return { now: () => state };
}

/** One table case finishes the copy before asking whether its authority answer can proceed. */
function finishCopy(state: string, release: () => void): void {
  if (state === 'finished') release();
}

/** The room a Function isolate reads artifacts and records in, one for every request it serves. */
describe('the room a Function isolate reads in', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets a read alone hold it, however long', async () => {
    const budget = new ReadBudget(LIMIT);

    const release = await hold(budget, 2 * LIMIT, deadline());

    expect(release).toBeTypeOf('function');
  });

  it('lets reads that do not fit together hold it in turn, in the order they asked', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    const first = await hold(budget, LIMIT, deadline());
    const second = hold(budget, LIMIT, deadline());
    // Room for it beside nothing but the first, and it waits behind the second all the same.
    const third = watched(hold(budget, 1, deadline()));
    const secondNow = watched(second);
    await vi.advanceTimersByTimeAsync(1000);
    const whileFirstHolds = [secondNow.now(), third.now()];

    first();
    await vi.advanceTimersByTimeAsync(100);
    const whileSecondHolds = [secondNow.now(), third.now()];
    (await second)();
    await vi.advanceTimersByTimeAsync(100);

    expect(whileFirstHolds).toStrictEqual(['waiting', 'waiting']);
    expect(whileSecondHolds).toStrictEqual(['held', 'waiting']);
    expect(third.now()).toBe('held');
  });

  /** A read given up as it waits leaves the line as it does: the read after it is not held up. */
  it('lets a read in at once beside one that holds it, once the read waiting ahead gives up', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    await hold(budget, LIMIT - 1, deadline());
    const given = new AbortController();
    const waiting = watched(hold(budget, LIMIT, given.signal));
    await vi.advanceTimersByTimeAsync(100);

    given.abort(new Error('called off'));
    // No time goes by: what is settled is settled by the abort alone.
    await vi.advanceTimersByTimeAsync(0);
    const beside = watched(hold(budget, 1, deadline()));
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.now()).toBe('given up');
    expect(beside.now()).toBe('held');
  });

  it('keeps a live holder renewed while several requests wait past a lapse', async () => {
    freezeClock();
    const budget = new ReadBudget(LIMIT);
    const first = await hold(budget, LIMIT, deadline());
    const queued = Array.from({ length: WAITERS }, () => hold(budget, 1, deadline()));
    const states = queued.map((held) => watched(held));
    await vi.advanceTimersByTimeAsync(LAPSE_MS + 1000);
    const whileFirstHolds = states.map((state) => state.now());
    first();
    await vi.advanceTimersByTimeAsync(100);
    const releases = await Promise.all(queued);
    for (const release of releases) {
      release();
    }

    expect(whileFirstHolds).toStrictEqual(Array.from({ length: WAITERS }, () => 'waiting'));
    expect(states.map((state) => state.now())).toStrictEqual(
      Array.from({ length: WAITERS }, () => 'held'),
    );
  });

  it('does not lapse an abandoned holder sooner when several requests wait', async () => {
    freezeClock();
    const budget = new ReadBudget(LIMIT);
    await hold(budget, LIMIT, deadline());
    // The holder's request is gone, including the timer that renewed its claim.
    vi.clearAllTimers();
    const queued = Array.from({ length: WAITERS }, () => hold(budget, 1, deadline()));
    const states = queued.map((held) => watched(held));
    await vi.advanceTimersByTimeAsync(LAPSE_MS - 1);
    const beforeLapse = states.map((state) => state.now());
    await vi.advanceTimersByTimeAsync(100);
    const releases = await Promise.all(queued);
    for (const release of releases) {
      release();
    }

    expect(beforeLapse).toStrictEqual(Array.from({ length: WAITERS }, () => 'waiting'));
    expect(states.map((state) => state.now())).toStrictEqual(
      Array.from({ length: WAITERS }, () => 'held'),
    );
  });

  /**
   * A request cancelled as its read holds room — its caller gone — never runs the code that would
   * give it back, and its timers go with it. The clock stands still all the while.
   */
  it('takes back the room of a read whose request was cancelled as it held it', async () => {
    freezeClock();
    const budget = new ReadBudget(LIMIT);
    await hold(budget, LIMIT, deadline());
    // Its request cancelled: the timers it set never fire again.
    vi.clearAllTimers();

    const next = watched(hold(budget, LIMIT, deadline()));
    await vi.advanceTimersByTimeAsync(LAPSE_MS - 1000);
    const beforeLapse = next.now();
    await vi.advanceTimersByTimeAsync(2000);

    expect(beforeLapse).toBe('waiting');
    expect(next.now()).toBe('held');
  });

  /**
   * A request cancelled as its read waits keeps its place in line, and room handed to it would
   * never come back. The clock stands still all the while.
   */
  it('takes a read whose request was cancelled as it waited out of line', async () => {
    freezeClock();
    const budget = new ReadBudget(LIMIT);
    const first = await hold(budget, LIMIT, deadline());
    void hold(budget, LIMIT, new AbortController().signal).catch(() => {
      // Nothing of it is heard again.
    });
    await vi.advanceTimersByTimeAsync(100);
    // Its request cancelled: the timers it set never fire again.
    vi.clearAllTimers();
    first();

    const next = watched(hold(budget, LIMIT, deadline()));
    await vi.advanceTimersByTimeAsync(LAPSE_MS + 1000);

    expect(next.now()).toBe('held');
  });

  it.each(['reading', 'finished'])(
    'grows an artifact ahead of a full-budget reader while its copy is %s',
    async (copyState) => {
      freezeClock();
      const budget = new ReadBudget(LIMIT);
      const room = new ArtifactRoom(budget);
      const stopped = new AbortController();
      const copy = await room.hold(1, stopped.signal);
      const next = hold(budget, LIMIT, deadline());
      const nextState = watched(next);
      const authority = room.hold(LIMIT / 2, stopped.signal);
      const authorityState = watched(authority);
      finishCopy(copyState, copy);
      await vi.advanceTimersByTimeAsync(100);
      const beforeRelease = [authorityState.now(), nextState.now()];

      // Release a completed read, or abort the old implementation's still-pending upgrade.
      stopped.abort(new Error('the read ended'));
      try {
        (await authority)();
      } catch {
        // The old source could not grow past the later full-budget reader.
      }
      copy();
      await vi.advanceTimersByTimeAsync(100);
      (await next)();

      expect(beforeRelease).toStrictEqual(['held', 'waiting']);
      expect(nextState.now()).toBe('held');
    },
  );

  it('grows a pending artifact at its original place ahead of a later full-budget reader', async () => {
    freezeClock();
    const budget = new ReadBudget(LIMIT);
    const blocking = await hold(budget, LIMIT, deadline());
    const room = new ArtifactRoom(budget);
    const stopped = new AbortController();
    const copy = room.hold(1, stopped.signal);
    const copyState = watched(copy);
    const next = hold(budget, LIMIT, deadline());
    const nextState = watched(next);
    const authority = room.hold(LIMIT / 2, stopped.signal);
    const authorityState = watched(authority);

    blocking();
    await vi.advanceTimersByTimeAsync(100);
    const beforeRelease = [copyState.now(), authorityState.now(), nextState.now()];
    stopped.abort(new Error('the read ended'));
    try {
      (await authority)();
    } catch {
      // As above, the old source left the larger answer behind its own base claim.
    }
    (await copy)();
    await vi.advanceTimersByTimeAsync(100);
    (await next)();

    expect(beforeRelease).toStrictEqual(['held', 'held', 'waiting']);
    expect(nextState.now()).toBe('held');
  });

  it('keeps a pending artifact and its growth behind an earlier full-budget reader', async () => {
    freezeClock();
    const budget = new ReadBudget(LIMIT);
    const blocking = await hold(budget, LIMIT, deadline());
    const next = hold(budget, LIMIT, deadline());
    const nextState = watched(next);
    const room = new ArtifactRoom(budget);
    const copy = room.hold(1, deadline());
    const copyState = watched(copy);
    const authority = room.hold(LIMIT / 2, deadline());
    const authorityState = watched(authority);

    blocking();
    await vi.advanceTimersByTimeAsync(100);
    const whileEarlierHolds = [nextState.now(), copyState.now(), authorityState.now()];
    (await next)();
    await vi.advanceTimersByTimeAsync(100);
    (await copy)();
    (await authority)();

    expect(whileEarlierHolds).toStrictEqual(['held', 'waiting', 'waiting']);
    expect([copyState.now(), authorityState.now()]).toStrictEqual(['held', 'held']);
  });

  it('waits for the extra room of an authority answer beside a copy that states fewer bytes', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    const other = await hold(budget, (3 * LIMIT) / 4, deadline());
    const room = new ArtifactRoom(budget);
    // The copy holds its stated length while its body stalls; the authority answers beside it.
    const copy = await room.hold(1, deadline());
    const authority = room.hold(LIMIT / 2, deadline());
    const state = watched(authority);
    await vi.advanceTimersByTimeAsync(100);
    const besideTheOtherRead = state.now();

    other();
    await vi.advanceTimersByTimeAsync(100);
    (await authority)();
    copy();

    expect(besideTheOtherRead).toBe('waiting');
    expect(state.now()).toBe('held');
  });

  it('gives up a larger answer waiting for extra room while the smaller copy still holds its room', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    const other = await hold(budget, (3 * LIMIT) / 4, deadline());
    const room = new ArtifactRoom(budget);
    const copy = await room.hold(1, deadline());
    const given = new AbortController();
    const authority = room.hold(LIMIT / 2, given.signal);
    const state = watched(authority);
    await vi.advanceTimersByTimeAsync(100);

    given.abort(new Error('the answer was called off'));
    await vi.advanceTimersByTimeAsync(0);
    other();
    const after = hold(budget, LIMIT - 1, deadline());
    const afterState = watched(after);
    await vi.advanceTimersByTimeAsync(100);
    (await after)();
    try {
      (await authority)();
    } catch {
      // The read gave up before it took room.
    }
    copy();

    expect(state.now()).toBe('given up');
    expect(afterState.now()).toBe('held');
  });

  it('takes no extra room for a larger answer already called off', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    const room = new ArtifactRoom(budget);
    const copy = await room.hold(1, deadline());
    const given = new AbortController();
    const error = new Error('the answer was called off');
    given.abort(error);

    await expect(room.hold(LIMIT / 2, given.signal)).rejects.toBe(error);

    const after = hold(budget, LIMIT - 1, deadline());
    const state = watched(after);
    await vi.advanceTimersByTimeAsync(100);
    (await after)();
    copy();

    expect(state.now()).toBe('held');
  });

  it('gives extra room back once the larger answer ends, while the smaller copy still holds', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    const room = new ArtifactRoom(budget);
    const copy = await room.hold(1, deadline());
    const authority = await room.hold(LIMIT / 2, deadline());

    authority();
    const after = hold(budget, LIMIT - 1, deadline());
    const state = watched(after);
    await vi.advanceTimersByTimeAsync(100);
    (await after)();
    copy();

    expect(state.now()).toBe('held');
  });

  it('keeps the larger answer charged after the smaller copy has gone', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    const room = new ArtifactRoom(budget);
    const copy = await room.hold(1, deadline());
    const authority = await room.hold(LIMIT / 2, deadline());
    copy();
    const after = hold(budget, (3 * LIMIT) / 4, deadline());
    const state = watched(after);
    await vi.advanceTimersByTimeAsync(100);
    const whileTheAnswerHolds = state.now();

    authority();
    await vi.advanceTimersByTimeAsync(100);
    (await after)();

    expect(whileTheAnswerHolds).toBe('waiting');
    expect(state.now()).toBe('held');
  });

  it('lets a larger answer alone take the whole room, however long it says it is', async () => {
    const budget = new ReadBudget(LIMIT);
    const room = new ArtifactRoom(budget);
    const copy = await room.hold(1, deadline());

    const authority = await room.hold(2 * LIMIT, deadline());

    authority();
    copy();

    expect(authority).toBeTypeOf('function');
  });
});
