import { afterEach, describe, expect, it, vi } from 'vitest';

import { announceBehind, announceMoved } from '../src/announce.ts';
import type { AuthorityHost } from '../src/authority-host.ts';

/**
 * How long an invalidation's answer waits for the host to tell the scope's copies elsewhere that it
 * moved (`announce.ts`): a Function's, for 300 ms at the most, with whatever is left behind it; one
 * the host asks for itself, or a chunk that more follow, not at all.
 */

const SCOPE = 'scope_announce';
const NAMING = { tokenLabel: 'announce' };

function hostTelling(announce?: (scopeId: string) => Promise<undefined>): AuthorityHost {
  return { naming: NAMING, meter: { read: vi.fn(), write: vi.fn() }, announce };
}

/** A telling that lands only when `land` is called, and the `waitUntil` the answer hands it to. */
function pending() {
  const told = Promise.withResolvers<undefined>();
  const behind: Promise<void>[] = [];
  const announce = vi.fn(async () => told.promise);
  return {
    host: hostTelling(announce),
    announce,
    land: () => {
      told.resolve(undefined);
    },
    waitUntil: (work: Promise<void>) => {
      behind.push(work);
    },
    behind,
  };
}

interface Outcome {
  settled: boolean;
}

/** Keep in `outcome` whether `work` has settled, for a test to read without waiting for it. */
async function settle(work: Promise<unknown>, outcome: Outcome): Promise<void> {
  await work;
  outcome.settled = true;
}

describe('a Function’s invalidation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is answered as soon as the host has told the copies', async () => {
    vi.useFakeTimers();
    const telling = pending();
    const answer: Outcome = { settled: false };
    const answered = settle(announceMoved(telling.host, SCOPE, {}, telling.waitUntil), answer);
    await vi.advanceTimersByTimeAsync(100);

    expect(answer.settled).toBe(false);

    telling.land();
    await answered;

    expect(answer.settled).toBe(true);
    expect(telling.announce).toHaveBeenCalledWith(SCOPE, {});
    expect(telling.behind).toHaveLength(1);
  });

  it('is answered after 300 ms at the most, the telling left behind it', async () => {
    vi.useFakeTimers();
    const telling = pending();
    const answer: Outcome = { settled: false };
    const answered = settle(announceMoved(telling.host, SCOPE, {}, telling.waitUntil), answer);
    await vi.advanceTimersByTimeAsync(299);

    expect(answer.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(answer.settled).toBe(true);

    await answered;
    const told: Outcome = { settled: false };
    const toldBehind = settle(Promise.all(telling.behind), told);
    await vi.advanceTimersByTimeAsync(1000);

    expect(telling.behind).toHaveLength(1);
    expect(told.settled).toBe(false);

    telling.land();
    await toldBehind;

    expect(told.settled).toBe(true);
  });

  it('is answered at once where the host tells nothing', async () => {
    const behind: Promise<void>[] = [];

    await announceMoved(hostTelling(), SCOPE, {}, (work) => {
      behind.push(work);
    });

    expect(behind).toStrictEqual([]);
  });
});

describe('an invalidation told behind its answer', () => {
  it('hands the telling to waitUntil and waits for none of it', async () => {
    const telling = pending();

    announceBehind(telling.host, SCOPE, {}, telling.waitUntil);

    expect(telling.announce).toHaveBeenCalledWith(SCOPE, {});
    expect(telling.behind).toHaveLength(1);

    const told: Outcome = { settled: false };
    const toldBehind = settle(Promise.all(telling.behind), told);
    await Promise.resolve();

    expect(told.settled).toBe(false);

    telling.land();
    await toldBehind;

    expect(told.settled).toBe(true);
  });
});
