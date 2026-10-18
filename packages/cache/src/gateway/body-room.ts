/**
 * The room an isolate of the gateway keeps for the bodies it reads whole for a write: a value to
 * store (`PUT /data`) and an artifact's upload (`PUT /attempts/:attemptId/artifacts/:sha256`). Each
 * may be as long as an artifact may be, 25 MiB by default, and is held until storage has it —
 * hashed first, since its key there is its digest, and an upload counted against its scope by the
 * authority. An isolate serves every deployment whose requests reach it: six such writes at once,
 * whoever made them, held more than its 128 MB, and its reset failed every request it was
 * answering. Every other body the gateway reads is bounded by the contract at a mebibyte or less —
 * a commit, a batch of small artifacts — and is read beside these as before.
 *
 * A write waits for room in its own request's time, asking again every few milliseconds, and is not
 * woken by the write that gives the room back: the runtime refuses to settle one request's promise
 * from another's ("Cannot perform I/O on behalf of a different request"), and the waiting write
 * would never go on. A request the runtime cancels, its sender gone, may never run the code after
 * its `await`, so a claim is renewed by its own request for as long as it waits or holds, and
 * lapses once nothing has renewed it for a while: a cancelled write does not hold the room for
 * good. The records a settle builds wait for theirs the same way (`projection-memory.ts`).
 */

const KIB = 1024;
const BODY_ROOM_MIB = 32;
/**
 * As much as one write alone holds of a body, near enough, and no more: the largest value's body,
 * some 33 MiB, is parsed whole into as much again twice over before its value is decoded, which
 * leaves the isolate no room for a second beside it. A write alone always has room, whatever its
 * body's length: its claim is the whole budget at the most.
 */
export const BODY_ROOM_BYTES = BODY_ROOM_MIB * KIB * KIB;
/** How often a write waiting for room asks again, which renews its claim. */
const ASK_AGAIN_MS = 20;
/** How often the request of a write that holds room renews its claim. */
const RENEW_MS = 1000;
/** How long a claim lasts without its request renewing it: past it, that request is gone. */
const CLAIM_LAPSE_MS = 5000;

/** A claim on the room: its bytes, whether they are held yet, and until when it holds unrenewed. */
interface Claim {
  readonly bytes: number;
  holding: boolean;
  until: number;
}

/** The claims of every write in the isolate, in the order they were made: the module's. */
const claims: Claim[] = [];

/**
 * Renew `claim`, as its own request's work. A claim that lapsed while its request still waits or
 * holds — its timers held up past the lapse — is counted again, as one made last.
 */
function renew(claim: Claim): void {
  claim.until = Date.now() + CLAIM_LAPSE_MS;
  if (!claims.includes(claim)) {
    claims.push(claim);
  }
}

function remove(claim: Claim): void {
  const at = claims.indexOf(claim);
  if (at !== -1) {
    claims.splice(at, 1);
  }
}

/**
 * Whether `claim` may be held at `now`: it is the first that waits, and there is room for it beside
 * the claims held. What has lapsed is let go of first.
 */
function admits(claim: Claim, now: number): boolean {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if ((claims[index]?.until ?? now) <= now) {
      claims.splice(index, 1);
    }
  }
  let held = 0;
  for (const other of claims) {
    held += other.holding ? other.bytes : 0;
  }
  return claims.find((other) => !other.holding) === claim && held + claim.bytes <= BODY_ROOM_BYTES;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * What `write` comes to, made once the isolate has room for the `bytes` its body may hold, and the
 * room given back as it ends, whatever it came to; what `refuse` makes, and nothing written, where
 * none came within `waitMs`. Room is taken at once where there is some and no write waits ahead;
 * otherwise the write waits in the order it asked.
 */
export async function withBodyRoom<T>(
  bytes: number,
  waitMs: number,
  write: () => Promise<T>,
  refuse: () => T,
): Promise<T> {
  const claim: Claim = { bytes: Math.min(bytes, BODY_ROOM_BYTES), holding: false, until: 0 };
  const givenUpAt = Date.now() + waitMs;
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    renew(claim);
    while (!admits(claim, Date.now())) {
      await pause(ASK_AGAIN_MS);
      if (Date.now() >= givenUpAt) {
        return refuse();
      }
      renew(claim);
    }
    claim.holding = true;
    renewal = setInterval(() => {
      renew(claim);
    }, RENEW_MS);
    return await write();
  } finally {
    clearInterval(renewal);
    remove(claim);
  }
}
