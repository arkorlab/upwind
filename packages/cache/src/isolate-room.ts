/**
 * Room an isolate keeps for bytes it holds whole, one for every request it serves: the Function's
 * for the artifacts and records it reads (`function/read-budget.ts`), the gateway's for the bodies
 * of the writes it reads (`gateway/body-room.ts`). Each read or write claims its bytes before it
 * holds any of them, and claims are let in in the order they were made.
 *
 * A claim that waits asks again on a timer of its own request every few milliseconds; it is not
 * woken by the claim that gives room back. A request can be cancelled — its caller gone — at the
 * next thing its work waits on, and the code after that `await` never runs: room it holds would
 * never be given back, and room given to it as it waits would never be given back either, since it
 * is given to a request that can no longer use it. So a claim is renewed by its own request for as
 * long as it waits or holds — as it asks again, and on a timer as it holds — and lapses once
 * nothing has renewed it for a while: a cancelled request's claim leaves the line, and its room
 * comes back. The settle runs of a scope's object wait for theirs the same way
 * (`scope/projection-memory.ts`).
 *
 * The time is read from `performance`, not `Date`: the Function claims room from inside renders,
 * where Next.js extends `Date`.
 */

/** How often a claim waiting for room asks again, which renews it. */
const ASK_AGAIN_MS = 20;
/** How often the request of a claim that holds room renews it. */
const RENEW_MS = 1000;
/** How long a claim lasts without its request renewing it: past it, that request is gone. */
const CLAIM_LAPSE_MS = 5000;

/** A claim on the room: its bytes, whether they are held yet, and until when it holds unrenewed. */
interface Claim {
  readonly bytes: number;
  holding: boolean;
  until: number;
}

/** What gives a claim's room back: called by the request that holds it, whose timer it clears. */
export type GiveBack = () => void;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

  #claimOf(bytes: number): Claim {
    return { bytes: Math.min(bytes, this.#limit), holding: false, until: 0 };
  }

  /**
   * Renew `claim`, as its own request's work. One that lapsed while its request still waits or
   * holds — its timers held up past the lapse — is counted again, as one made last.
   */
  #renew(claim: Claim): void {
    claim.until = performance.now() + CLAIM_LAPSE_MS;
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

  /**
   * Whether `claim` may hold its bytes at `now`: it is the first that waits, and there is room for
   * it beside the claims held. What has lapsed is let go of first.
   */
  #admits(claim: Claim, now: number): boolean {
    for (let index = this.#claims.length - 1; index >= 0; index -= 1) {
      if ((this.#claims[index]?.until ?? now) <= now) {
        this.#claims.splice(index, 1);
      }
    }
    let held = 0;
    for (const other of this.#claims) {
      held += other.holding ? other.bytes : 0;
    }
    return (
      this.#claims.find((other) => !other.holding) === claim && held + claim.bytes <= this.#limit
    );
  }

  /** Hold `claim`, renewed on a timer of the request that holds it, until it is given back. */
  #hold(claim: Claim): GiveBack {
    claim.holding = true;
    const renewal = setInterval(() => {
      this.#renew(claim);
    }, RENEW_MS);
    return () => {
      clearInterval(renewal);
      this.#remove(claim);
    };
  }

  /**
   * `claim` held once it is first in line and there is room for it, asked again on a timer of its
   * own request, and at once as `woken` settles; `undefined`, and its place given up, once
   * `givenUp()` says so.
   */
  async #waitFor(
    claim: Claim,
    givenUp: () => boolean,
    woken: Promise<unknown>,
  ): Promise<GiveBack | undefined> {
    this.#renew(claim);
    while (!this.#admits(claim, performance.now())) {
      await Promise.race([pause(ASK_AGAIN_MS), woken]);
      if (givenUp()) {
        this.#remove(claim);
        return undefined;
      }
      this.#renew(claim);
    }
    return this.#hold(claim);
  }

  /** Room for `bytes` where there is room for them now and no claim waits ahead, or none. */
  takeAtOnce(bytes: number): GiveBack | undefined {
    const claim = this.#claimOf(bytes);
    this.#renew(claim);
    if (!this.#admits(claim, performance.now())) {
      this.#remove(claim);
      return undefined;
    }
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
    const aborted = Promise.withResolvers<undefined>();
    const leave = (): void => {
      if (!claim.holding) {
        this.#remove(claim);
      }
      aborted.resolve(undefined);
    };
    signal.addEventListener('abort', leave, { once: true });
    try {
      const given = await this.#waitFor(claim, () => signal.aborted, aborted.promise);
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
    const late = Promise.withResolvers<undefined>();
    let over = false;
    const timer = setTimeout(() => {
      over = true;
      late.resolve(undefined);
    }, ms);
    try {
      return await this.#waitFor(this.#claimOf(bytes), () => over, late.promise);
    } finally {
      clearTimeout(timer);
    }
  }
}
