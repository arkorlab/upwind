/**
 * The room an isolate has for the artifacts it reads whole: the authority's answers, and its data
 * center's copies of them (`artifacts.ts`); for the delivery records it reads, from the gateways and
 * from its data center's copies of them (`gateway.ts`, `record-copies.ts`); and for its data
 * center's copies of the values it wrote (`data-copies.ts`). An artifact is read whole before it is
 * answered with — the runtime takes bytes, not a stream — and the reads of every request the
 * isolate serves would otherwise all be read at once, however many there were and however long.
 */

import { type GiveBack, type IsolateRoom } from '../isolate-room.ts';

/** What `promise` comes to, or `signal`'s reason where it aborts first. */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = (): void => {
    aborted.reject(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** The room a take was granted, given back once it is; rejects where it was called off first. */
async function giveBack(granted: Promise<GiveBack>): Promise<void> {
  (await granted)();
}

/** Room asked of the budget for an artifact's reads: what grants it, and how to call it off. */
interface Claim {
  readonly granted: Promise<GiveBack>;
  readonly abandoned: AbortController;
}

/**
 * The room one read of an artifact holds in the budget, for the two reads it may make of it: its
 * data center's copy, and the authority's answer asked beside a copy slower than its head start
 * (`artifacts.ts`). Taken by whichever first says how long the artifact is, and held by the other
 * as it stands, granted or still waiting: the two read the bytes the one id names, and neither
 * waits behind the other for room those bytes take. A copy that stalls with its room taken would
 * otherwise keep waiting the very read asked beside it to answer in its place. Both bodies are read
 * in it at once only until whichever answers first calls the other off. Given back once neither
 * holds it, so that a read after them takes room of its own.
 */
export class ArtifactRoom {
  readonly #budget: IsolateRoom;
  /** The room asked for, while a read holds it or waits for it; none once neither does. */
  #claim: Claim | undefined;
  #holders = 0;

  constructor(budget: IsolateRoom) {
    this.#budget = budget;
  }

  /** Room for `bytes` from the budget: at once where there is, otherwise in its place in line. */
  #ask(bytes: number): Claim {
    const abandoned = new AbortController();
    const now = this.#budget.takeAtOnce(bytes);
    const granted =
      now === undefined ? this.#budget.take(bytes, abandoned.signal) : Promise.resolve(now);
    return { granted, abandoned };
  }

  /**
   * One read fewer holds the room. Once none does, the room goes back, or a take still waiting
   * gives its place up — and room granted just as it did goes back as it comes.
   */
  #leave(): void {
    this.#holders -= 1;
    const claim = this.#claim;
    if (claim === undefined || this.#holders > 0) {
      return;
    }
    this.#claim = undefined;
    claim.abandoned.abort();
    void giveBack(claim.granted).catch(() => {
      // Called off before room came: nothing was taken.
    });
  }

  /**
   * Room for a read of `bytes` once there is, and what gives it back: the room the other read of
   * the artifact holds or waits for, where it does; otherwise taken from the budget, at once where
   * there is room. Given up, and the read's place in line with it, where `signal` aborts first.
   */
  async hold(bytes: number, signal: AbortSignal): Promise<() => void> {
    this.#claim ??= this.#ask(bytes);
    this.#holders += 1;
    try {
      await untilAborted(this.#claim.granted, signal);
    } catch (error) {
      this.#leave();
      throw error;
    }
    let holding = true;
    return () => {
      if (holding) {
        holding = false;
        this.#leave();
      }
    };
  }
}

/**
 * The bytes of artifacts an isolate reads at once, and the reads waiting for room, in the order
 * they asked: the isolate's room (`IsolateRoom`). A read takes as many bytes as it says it holds,
 * the whole budget at the most, so one alone always has room; one that has none, or that comes
 * while another waits, waits for bytes given back, or until its signal aborts. A read whose request
 * is cancelled as it waits or holds room gives its place and its room up once its claim lapses.
 */
export { IsolateRoom as ReadBudget } from '../isolate-room.ts';
