/**
 * The memory the delivery records a settle run builds may hold (`projectionChunk`, `settle.ts`), and
 * the one budget it is taken from: the isolate's. Durable Objects of one class can share an isolate,
 * and with it its 128 MiB, so a budget each scope kept would bound nothing: the runs of the scopes an
 * isolate holds, each within its own, could together build more than the isolate has, and its reset
 * would fail every request of every object in it.
 *
 * A chunk waits for room in its own object's time, asking again every few milliseconds, and is not
 * woken by the chunk that gives the room back: the runtime refuses to settle one object's promise
 * from another's ("Cannot perform I/O on behalf of a different Durable Object"), and the waiting run
 * would never go on. An object can be reset while its run waits or builds, and the code after its
 * `await` then never runs. So a claim is renewed by its own object for as long as it waits or
 * builds — as it asks again, and on a timer of its own as it builds — and lapses once nothing has
 * renewed it for a while: a reset object's claim does not hold the isolate's room for good, and a
 * build that takes long, a storage read that does not answer say, holds its room while it runs.
 *
 * A record a run keeps past the chunk that built it — the one a commit is answered with — holds its
 * bytes as long as it is kept, and is charged until the run lets it go (`retain`), renewed as a
 * building chunk's claim is. Every record kept counts against every chunk let in, beside a chunk
 * building or alone: nothing that holds bytes is left out of the budget. Nor does that hold a run
 * for good, as no run waits with a record kept: a run lets go of what it keeps before it waits for
 * room (`withProjectionMemory`), and keeps nothing as it waits, a record being kept only by a chunk
 * that builds. What the first in line waits for is held by chunks building, which end, and by
 * records of runs that are not waiting, which go on without room and let them go as their changes
 * are answered, or wait again and let them go first, or are reset, and the records lapse. Nothing is
 * let in before the first in line, so once the chunks building have ended nothing is kept anew, and
 * once what they left has gone it has room, as a claim takes the whole budget at the most.
 *
 * A record built for an answer rather than by a run — one a lease is answered with, or a commit
 * whose run handed back none (`commit-record.ts`) — is built within the same budget, but waits for
 * no room: it is let in only where it would be at once (`withProjectionMemoryAtOnce`), and the
 * answer goes without it otherwise. It takes no place in the line and goes ahead of no chunk that
 * waits, so the line goes on as above: let in, it is one more chunk building, which ends.
 */

const KIB = 1024;
const PROJECTION_MEMORY_MIB = 48;
/** Leave room in the 128 MiB isolate for scope state, other requests and a returned commit record. */
export const PROJECTION_MEMORY_BYTES = PROJECTION_MEMORY_MIB * KIB * KIB;
/** How often a chunk waiting for room asks again, which renews its claim. */
const ASK_AGAIN_MS = 20;
/** How often the object of a building chunk, or of a record kept, renews its claim. */
const RENEW_MS = 1000;
/** How long a claim lasts without its object renewing it: past it, that object is gone. */
const CLAIM_LAPSE_MS = 5000;

/** A claim on the isolate's room: the bytes, what holds them, and until when it holds unrenewed. */
interface Claim {
  readonly bytes: number;
  /** A chunk waiting for room, one building its records, or a record a run keeps past its chunk. */
  kind: 'waiting' | 'building' | 'kept';
  until: number;
}

/** The claims of every run in the isolate, in the order they were made: the module's, no scope's. */
const claims: Claim[] = [];

/**
 * Renew `claim`, as its own object's work. A claim that lapsed while its object still waits or
 * builds — its timers held up past the lapse — is counted again, as one made last.
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
 * Hold `claim`, renewed on a timer of the object that holds it, until the function returned lets it
 * go: called by that object, which set the timer, since a timer is its own object's.
 */
function hold(claim: Claim): () => void {
  renew(claim);
  const renewal = setInterval(() => {
    renew(claim);
  }, RENEW_MS);
  return () => {
    clearInterval(renewal);
    remove(claim);
  };
}

/**
 * Whether `claim` may begin at `now`: it is the first that waits, and there is room for it beside
 * the chunks building and the records kept. What has lapsed is let go of first.
 */
function admits(claim: Claim, now: number): boolean {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if ((claims[index]?.until ?? now) <= now) {
      claims.splice(index, 1);
    }
  }
  let building = 0;
  let kept = 0;
  for (const other of claims) {
    building += other.kind === 'building' ? other.bytes : 0;
    kept += other.kind === 'kept' ? other.bytes : 0;
  }
  return (
    claims.find((other) => other.kind === 'waiting') === claim &&
    building + kept + claim.bytes <= PROJECTION_MEMORY_BYTES
  );
}

/**
 * A claim on `bytes` that waits to be let in: one whose reckoning is no number at all is taken to
 * hold the whole budget, as a record it cannot reckon is, and none holds more.
 */
function waitingClaim(bytes: number): Claim {
  return {
    bytes: Number.isFinite(bytes)
      ? Math.min(bytes, PROJECTION_MEMORY_BYTES)
      : PROJECTION_MEMORY_BYTES,
    kind: 'waiting',
    until: 0,
  };
}

/**
 * `build`, once the isolate has room for the `bytes` it reckons it holds, given back as it ends. A
 * chunk that builds no record — a withdrawal's — holds nothing, and waits for nothing; one whose
 * reckoning is no number at all is taken to hold the whole budget, as a record it cannot reckon is.
 * A chunk not let in at once has its run let go of what it keeps (`beforeWait`) before it waits,
 * once, and asks again at once: what the run kept may have been all that stood in its way.
 */
export async function withProjectionMemory<T>(
  bytes: number,
  build: () => Promise<T>,
  beforeWait?: () => void,
): Promise<T> {
  if (bytes === 0) {
    return build();
  }
  const claim = waitingClaim(bytes);
  let release: (() => void) | undefined;
  try {
    renew(claim);
    if (!admits(claim, Date.now())) {
      beforeWait?.();
      while (!admits(claim, Date.now())) {
        await new Promise((resolve) => {
          setTimeout(resolve, ASK_AGAIN_MS);
        });
        renew(claim);
      }
    }
    claim.kind = 'building';
    release = hold(claim);
    return await build();
  } finally {
    release?.();
    remove(claim);
  }
}

/**
 * `build`, where the isolate has room for the `bytes` it reckons it holds at once — as a chunk is
 * let in: nothing waiting before it, and room beside the chunks building and the records kept —
 * given back as it ends; nothing built, and `undefined`, where it has not. For what is built on
 * the way of an answer, which waits for no room: it goes without what there is none for.
 */
export async function withProjectionMemoryAtOnce<T>(
  bytes: number,
  build: () => Promise<T>,
): Promise<T | undefined> {
  const claim = waitingClaim(bytes);
  renew(claim);
  if (!admits(claim, Date.now())) {
    remove(claim);
    return undefined;
  }
  claim.kind = 'building';
  const release = hold(claim);
  try {
    return await build();
  } finally {
    release();
  }
}

/**
 * Charge the `bytes` of a record a run keeps past the chunk that built it — one its change is
 * answered with — to the isolate's room, until the function returned lets them go: as the record
 * is handed off, as the run waits for room, or on any other way out of the run. Taken while the
 * chunk that built the record still holds its own room, so that its bytes are never uncounted
 * between the two.
 */
export function retain(bytes: number): () => void {
  return hold({ bytes, kind: 'kept', until: 0 });
}
