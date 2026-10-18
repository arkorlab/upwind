import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactRoom, ReadBudget } from '../src/function/read-budget.ts';

const LIMIT = 32 * 1024 * 1024;
/** How long a claim lasts without its request renewing it (`CLAIM_LAPSE_MS`). */
const CLAIM_LAPSE_MS = 5000;
/** How long the reads here wait for room before they give up, as the Function's reads have one. */
const WAIT_MS = 10_000;

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

/** The room a Function isolate reads artifacts and records in, one for every request it serves. */
describe('the room a Function isolate reads in', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  /**
   * A request cancelled as its read holds room — its caller gone — never runs the code that would
   * give it back, and its timers go with it.
   */
  it('takes back the room of a read whose request was cancelled as it held it', async () => {
    vi.useFakeTimers();
    const budget = new ReadBudget(LIMIT);
    await hold(budget, LIMIT, deadline());
    // Its request cancelled: the timers it set never fire again.
    vi.clearAllTimers();

    const next = watched(hold(budget, LIMIT, deadline()));
    await vi.advanceTimersByTimeAsync(CLAIM_LAPSE_MS - 1000);
    const beforeLapse = next.now();
    await vi.advanceTimersByTimeAsync(2000);

    expect(beforeLapse).toBe('waiting');
    expect(next.now()).toBe('held');
  });

  /**
   * A request cancelled as its read waits keeps its place in line, and room handed to it would
   * never come back.
   */
  it('takes a read whose request was cancelled as it waited out of line', async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(CLAIM_LAPSE_MS + 1000);

    expect(next.now()).toBe('held');
  });
});
