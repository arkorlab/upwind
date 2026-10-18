/**
 * Room an isolate keeps for bytes it holds whole, one for every request it serves: the Function's
 * for the artifacts and records it reads (`function/read-budget.ts`), the gateway's for the bodies
 * of the writes it reads (`gateway/body-room.ts`), and a scope object's for the records its settle
 * runs build (`scope/projection-memory.ts`), shared by the objects of an isolate. Each read, write
 * or chunk claims its bytes before it holds any of them, and claims are let in in the order they
 * were made.
 *
 * A claim that waits asks again on a timer of its own request every few milliseconds; it is not
 * woken by the claim that gives room back. A request can be cancelled — its caller gone — and an
 * object reset, at the next thing its work waits on, and the code after that `await` never runs:
 * room it holds would never be given back, and room given to it as it waits would never be given
 * back either, since it is given to a request that can no longer use it. So a claim is renewed by
 * its own request for as long as it waits or holds — as it asks again, and on a timer as it holds —
 * and lapses once nothing has renewed it for a while: a cancelled request's claim leaves the line,
 * and its room comes back.
 *
 * "A while" is counted in timer firings, not read from a clock: on a Workers host a request's clock
 * stands still while its code runs and moves only with its I/O, which leaves a clock nothing to
 * judge a lapse by. Each waiting claim counts its own askings, which come no more often than every
 * `ASK_AGAIN_MS`, and every `ASKS_A_LOOK` of them it looks at the others: one it saw renewed by
 * none of `LOOKS_TO_LAPSE` looks in a row is let go. Each waiter keeps its own count, so a crowd of
 * them lets nothing go sooner than one would, and one whose own request is gone looks no more and
 * is let go by those behind it. A read that needs room always ends up waiting for it, so there is a
 * waiter to look for as long as anyone needs the room a lapsed claim held.
 */

/** How often a claim waiting for room asks again, which renews it. */
const ASK_AGAIN_MS = 20;
/** How often the request of a claim that holds room renews it. */
const RENEW_MS = 1000;
/** How many times a waiting claim asks again between its looks at the others: a second or more. */
const ASKS_A_LOOK = 50;
/** How many looks in a row a claim goes unrenewed before it is let go: five seconds or more. */
const LOOKS_TO_LAPSE = 5;

/** A claim on the room: its bytes, whether they are held yet, and how often it has been renewed. */
interface Claim {
  readonly bytes: number;
  holding: boolean;
  renewals: number;
}

/** What a waiting claim last saw of another: how often it was renewed, and since how many looks. */
interface Seen {
  readonly renewals: number;
  looks: number;
}

/** What gives a claim's room back: called by the request that holds it, whose timer it clears. */
export type GiveBack = () => void;

/** One re-check, woken by its own timer or abort, with nothing kept once either has happened. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const waiting: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (): void => {
      if (waiting.timer !== undefined) {
        clearTimeout(waiting.timer);
      }
      signal.removeEventListener('abort', finish);
      resolve();
    };
    waiting.timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * The bytes an isolate holds whole at once, and the claims waiting for room, in the order they
 * asked. A claim takes as many bytes as it says it holds, the whole room at the most, so one alone
 * always has room; one that has none, or that comes while another waits, waits for room to come
 * back, or until it is called off.
 */
export class IsolateRoom {
  readonly #limit: number;
  /** The claims of every request the isolate serves, in the order they were made. */
  readonly #claims: Claim[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** A claim on `bytes`, the whole room at the most; one that is no number at all, the whole room. */
  #claimOf(bytes: number): Claim {
    return {
      bytes: Number.isFinite(bytes) ? Math.min(bytes, this.#limit) : this.#limit,
      holding: false,
      renewals: 0,
    };
  }

  /**
   * Renew `claim`, as its own request's work. One that lapsed while its request still waits or
   * holds — its timers held up past the lapse — is counted again, as one made last.
   */
  #renew(claim: Claim): void {
    claim.renewals += 1;
    if (!this.#claims.includes(claim)) {
      this.#claims.push(claim);
    }
  }

  #remove(claim: Claim): void {
    const at = this.#claims.indexOf(claim);
    if (at !== -1) {
      this.#claims.splice(at, 1);
    }
  }

  /** Whether `claim` may hold its bytes: it is the first that waits, with room beside those held. */
  #admits(claim: Claim): boolean {
    let held = 0;
    for (const other of this.#claims) {
      held += other.holding ? other.bytes : 0;
    }
    return (
      this.#claims.find((other) => !other.holding) === claim && held + claim.bytes <= this.#limit
    );
  }

  /**
   * Look at every other claim as `waiter`, which waits, last saw it (`seen`): one renewed since is
   * seen afresh, and one that none of `LOOKS_TO_LAPSE` looks in a row saw renewed is let go — its
   * request is gone.
   */
  #look(waiter: Claim, seen: Map<Claim, Seen>): void {
    const lapsed: Claim[] = [];
    for (const other of this.#claims) {
      const last = seen.get(other);
      if (other === waiter) {
        // Its own claim, renewed as it looks.
      } else if (last?.renewals === other.renewals) {
        last.looks += 1;
        if (last.looks >= LOOKS_TO_LAPSE) {
          lapsed.push(other);
        }
      } else {
        seen.set(other, { renewals: other.renewals, looks: 0 });
      }
    }
    for (const other of lapsed) {
      this.#remove(other);
    }
    const standing = new Set(this.#claims);
    for (const known of seen.keys()) {
      if (!standing.has(known)) {
        seen.delete(known);
      }
    }
  }

  /**
   * Hold `claim`, renewed on a timer of the request that holds it, until it is given back. The
   * same kind of timer as a waiting claim asks again on, so that the two are counted alike: a
   * renewal is set again each time it fires, rather than on an interval.
   */
  #hold(claim: Claim): GiveBack {
    claim.holding = true;
    const renewal: { timer?: ReturnType<typeof setTimeout> } = {};
    const renewLater = (): void => {
      renewal.timer = setTimeout(() => {
        this.#renew(claim);
        renewLater();
      }, RENEW_MS);
    };
    renewLater();
    return () => {
      if (renewal.timer !== undefined) {
        clearTimeout(renewal.timer);
      }
      this.#remove(claim);
    };
  }

  /**
   * `claim` held once it is first in line and there is room for it, asked again on a timer of its
   * own request, and at once as `signal` aborts; `undefined`, and its place given up, once
   * it has aborted. Every `ASKS_A_LOOK` askings it looks at the others (`#look`), as it last
   * saw them.
   */
  async #waitFor(claim: Claim, signal: AbortSignal): Promise<GiveBack | undefined> {
    const seen = new Map<Claim, Seen>();
    let asked = 0;
    this.#renew(claim);
    this.#look(claim, seen);
    while (!this.#admits(claim)) {
      // Repeated races against one pending abort promise would keep every completed check alive.
      await pause(ASK_AGAIN_MS, signal);
      if (signal.aborted) {
        this.#remove(claim);
        return undefined;
      }
      this.#renew(claim);
      asked += 1;
      if (asked % ASKS_A_LOOK === 0) {
        this.#look(claim, seen);
      }
    }
    return this.#hold(claim);
  }

  /** Most one claim can hold: an artifact's two candidates share no more than the whole room. */
  get capacity(): number {
    return this.#limit;
  }

  /** Room for `bytes` where there is room for them now and no claim waits ahead, or none. */
  takeAtOnce(bytes: number): GiveBack | undefined {
    const claim = this.#claimOf(bytes);
    this.#renew(claim);
    if (!this.#admits(claim)) {
      this.#remove(claim);
      return undefined;
    }
    return this.#hold(claim);
  }

  /**
   * Room for `bytes` that are held already, counted at once whatever else holds room, until what
   * is returned gives it back: bytes taken in without waiting, that what is let in after them must
   * leave room for.
   */
  charge(bytes: number): GiveBack {
    const claim = this.#claimOf(bytes);
    this.#renew(claim);
    return this.#hold(claim);
  }

  /**
   * Room for `bytes`, once there is room for them; rejects with `signal`'s reason where it aborts
   * first, and the place in line is given up as it does. Room held just as it aborts is what it
   * resolves with all the same, for its caller to give back.
   */
  async take(bytes: number, signal: AbortSignal): Promise<GiveBack> {
    const now = this.takeAtOnce(bytes);
    if (now !== undefined) {
      return now;
    }
    signal.throwIfAborted();
    const claim = this.#claimOf(bytes);
    const leave = (): void => {
      if (!claim.holding) {
        this.#remove(claim);
      }
    };
    signal.addEventListener('abort', leave, { once: true });
    try {
      const given = await this.#waitFor(claim, signal);
      if (given === undefined) {
        // Given up only as the signal aborted.
        throw signal.reason;
      }
      return given;
    } finally {
      signal.removeEventListener('abort', leave);
    }
  }

  /**
   * Room for `bytes`, taken at once where there is room, and otherwise waited for no longer than
   * `ms`: what gives it back, or `undefined` where none came in time — and the place in line given
   * up with it. For a read or a write that has a deadline of its own to keep.
   */
  async takeWithin(bytes: number, ms: number): Promise<GiveBack | undefined> {
    const now = this.takeAtOnce(bytes);
    if (now !== undefined) {
      return now;
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, ms);
    try {
      return await this.#waitFor(this.#claimOf(bytes), deadline.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
