import { afterEach, describe, expect, it, vi } from 'vitest';

import { BODY_ROOM_BYTES, withBodyRoom } from '../src/gateway/body-room.ts';

/** How long a claim lasts without its request renewing it (`CLAIM_LAPSE_MS`). */
const CLAIM_LAPSE_MS = 5000;
/** How long the writes here wait for room before they are refused. */
const WAIT_MS = 10_000;
const MINUTE_MS = 60_000;

/** What a write refused for want of room comes to here. */
function refused(): string {
  return 'refused';
}

/** A write that records its name as it is made, and ends once `ended` settles, if given. */
function writing(made: string[], name: string, ended?: Promise<undefined>): () => Promise<string> {
  return async () => {
    made.push(name);
    await ended;
    return name;
  };
}

/** The room an isolate of the gateway reads the bodies of its writes in, one for them all. */
describe('the room for the bodies of writes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a write alone hold it, however long its body', async () => {
    vi.useFakeTimers();
    const made: string[] = [];

    const answer = await withBodyRoom(
      2 * BODY_ROOM_BYTES,
      WAIT_MS,
      writing(made, 'alone'),
      refused,
    );

    expect(answer).toBe('alone');
  });

  it('lets writes that do not fit together hold it in turn, in the order they asked', async () => {
    vi.useFakeTimers();
    const made: string[] = [];
    const first = Promise.withResolvers<undefined>();

    const writes = [
      withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, writing(made, 'first', first.promise), refused),
      withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, writing(made, 'second'), refused),
      // Room for it beside nothing but the first, and it waits behind the second all the same.
      withBodyRoom(1, WAIT_MS, writing(made, 'third'), refused),
    ];
    await vi.advanceTimersByTimeAsync(1000);
    const whileFirstHolds = [...made];
    first.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(Promise.all(writes)).resolves.toStrictEqual(['first', 'second', 'third']);
    expect(whileFirstHolds).toStrictEqual(['first']);
    expect(made).toStrictEqual(['first', 'second', 'third']);
  });

  it('lets a write that fits beside those holding it in at once', async () => {
    vi.useFakeTimers();
    const made: string[] = [];
    const first = Promise.withResolvers<undefined>();

    const holding = withBodyRoom(
      BODY_ROOM_BYTES - 1,
      WAIT_MS,
      writing(made, 'first', first.promise),
      refused,
    );
    const beside = await withBodyRoom(1, WAIT_MS, writing(made, 'beside'), refused);
    first.resolve(undefined);

    expect(beside).toBe('beside');
    await expect(holding).resolves.toBe('first');
  });

  /**
   * A write that waits past its wait is refused, unmade, and the one after it goes on: it holds
   * nothing it did not have, and is no longer first in line.
   */
  it('refuses a write given no room within its wait, and lets the next one in', async () => {
    vi.useFakeTimers();
    const made: string[] = [];
    const first = Promise.withResolvers<undefined>();

    const holding = withBodyRoom(
      BODY_ROOM_BYTES,
      2 * WAIT_MS,
      writing(made, 'first', first.promise),
      refused,
    );
    const waiting = withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, writing(made, 'waiting'), refused);
    const after = withBodyRoom(1, 2 * WAIT_MS, writing(made, 'after'), refused);
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1000);
    const beforeItsWaitEnds = [...made];
    await vi.advanceTimersByTimeAsync(2000);
    const answered = await waiting;
    first.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);

    expect(beforeItsWaitEnds).toStrictEqual(['first']);
    expect(answered).toBe('refused');
    await expect(Promise.all([holding, after])).resolves.toStrictEqual(['first', 'after']);
    expect(made).toStrictEqual(['first', 'after']);
  });

  /** A write whose storage takes minutes still holds its room: its request renews its claim. */
  it('keeps the room of a write that holds it past what a claim lasts unrenewed', async () => {
    vi.useFakeTimers();
    const made: string[] = [];
    const slow = Promise.withResolvers<undefined>();
    const holding = withBodyRoom(
      BODY_ROOM_BYTES,
      WAIT_MS,
      writing(made, 'slow', slow.promise),
      refused,
    );
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    const next = withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, writing(made, 'next'), refused);
    await vi.advanceTimersByTimeAsync(1000);
    const whileSlowHolds = [...made];
    slow.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);

    expect(whileSlowHolds).toStrictEqual(['slow']);
    await expect(Promise.all([holding, next])).resolves.toStrictEqual(['slow', 'next']);
  });

  /** The room goes back whatever the write came to: one that throws gives it back as it does. */
  it('takes back the room of a write that failed', async () => {
    vi.useFakeTimers();
    const made: string[] = [];

    const failing = withBodyRoom(
      BODY_ROOM_BYTES,
      WAIT_MS,
      () => Promise.reject(new Error('storage refused it')),
      refused,
    );

    await expect(failing).rejects.toThrow('storage refused it');

    const next = await withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, writing(made, 'next'), refused);

    expect(next).toBe('next');
  });

  /**
   * A request the runtime cancelled while its write held room never comes back to give it back,
   * and its timers go with it: nothing renews its claim, which lapses rather than holding every
   * other deployment's writes for good.
   */
  it('takes back the room of a write whose request was cancelled as it held it', async () => {
    vi.useFakeTimers();
    void withBodyRoom(
      BODY_ROOM_BYTES,
      WAIT_MS,
      () =>
        new Promise<string>(() => {
          // Never settles, as the write of a request cancelled under it does not.
        }),
      refused,
    ).catch(() => {
      // Nor fails: nothing of it is heard again.
    });
    // Its request cancelled: the timer that renewed its claim never fires again.
    vi.clearAllTimers();
    const made: string[] = [];

    const next = withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, writing(made, 'next'), refused);
    await vi.advanceTimersByTimeAsync(CLAIM_LAPSE_MS - 1000);
    const beforeLapse = [...made];
    await vi.advanceTimersByTimeAsync(2000);

    expect(beforeLapse).toStrictEqual([]);
    await expect(next).resolves.toBe('next');
  });
});
