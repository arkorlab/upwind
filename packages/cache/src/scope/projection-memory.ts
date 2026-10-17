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
 * bytes as long as it is kept, and is charged to that run until it lets it go (`retain`), renewed
 * as a building chunk's claim is. A kept record goes only as its run goes on, and a run waiting for
 * room goes on only once its chunk is let in, which only the first in line is. So what runs keep
 * counts against what is let in beside a chunk building, which gives its room back whatever is kept,
 * but a chunk that would build alone is let in beside what runs not waiting for room keep, and not
 * beside what waiting runs keep, its own run's among them: counted, those would hold the first in
 * line back for good, and with it every run behind. Nor can what a chunk alone does wait for hold it
 * for good: the runs that keep it go on without room, and let it go as their changes are answered —
 * or come to wait, which leaves it out, or are reset, and it lapses. Nothing builds meanwhile, so
 * nothing is kept anew, and once it is gone the chunk has room, as a claim takes the whole budget at
 * the most.
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

/**
 * A claim on the isolate's room: the bytes, what holds them, the run it is for, and until when it
 * holds unrenewed.
 */
interface Claim {
  readonly bytes: number;
  /** A chunk waiting for room, one building its records, or a record a run keeps past its chunk. */
  kind: 'waiting' | 'building' | 'kept';
  /** The settle run's token, compared and nothing else: it tells whose kept records are whose. */
  readonly run: symbol;
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
 * the chunks building and the records kept — where none is building, beside the records of the runs
 * not waiting for room alone. What has lapsed is let go of first.
 */
function admits(claim: Claim, now: number): boolean {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if ((claims[index]?.until ?? now) <= now) {
      claims.splice(index, 1);
    }
  }
  if (claims.find((other) => other.kind === 'waiting') !== claim) {
    return false;
  }
  let building = 0;
  const waiting = new Set<symbol>();
  for (const other of claims) {
    building += other.kind === 'building' ? other.bytes : 0;
    if (other.kind === 'waiting') {
      waiting.add(other.run);
    }
  }
  let kept = 0;
  for (const other of claims) {
    if (other.kind === 'kept' && (building > 0 || !waiting.has(other.run))) {
      kept += other.bytes;
    }
  }
  return building + kept + claim.bytes <= PROJECTION_MEMORY_BYTES;
}

/**
 * `build`, once the isolate has room for the `bytes` it reckons it holds, given back as it ends. A
 * chunk that builds no record — a withdrawal's — holds nothing, and waits for nothing; one whose
 * reckoning is no number at all is taken to hold the whole budget, as a record it cannot reckon is.
 * `run` is the settle run the chunk is for, which the records it keeps are charged to (`retain`):
 * none named, the chunk is a run of its own, which keeps nothing.
 */
export async function withProjectionMemory<T>(
  bytes: number,
  build: () => Promise<T>,
  run = Symbol('run'),
): Promise<T> {
  if (bytes === 0) {
    return build();
  }
  const claim: Claim = {
    bytes: Number.isFinite(bytes)
      ? Math.min(bytes, PROJECTION_MEMORY_BYTES)
      : PROJECTION_MEMORY_BYTES,
    kind: 'waiting',
    run,
    until: 0,
  };
  let release: (() => void) | undefined;
  try {
    for (;;) {
      renew(claim);
      if (admits(claim, Date.now())) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, ASK_AGAIN_MS);
      });
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
 * Charge the `bytes` of a record `run` keeps past the chunk that built it — one its change is
 * answered with — to the isolate's room, until the function returned lets them go: as the record
 * is handed off, or on any other way out of the run. Taken while the chunk that built the record
 * still holds its own room, so that its bytes are never uncounted between the two.
 */
export function retain(bytes: number, run: symbol): () => void {
  return hold({ bytes, kind: 'kept', run, until: 0 });
}
