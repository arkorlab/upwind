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
 * `await` then never runs: a claim nothing has been heard of for long enough lapses, rather than
 * holding the isolate's room for good.
 */

const KIB = 1024;
const PROJECTION_MEMORY_MIB = 48;
/** Leave room in the 128 MiB isolate for scope state, other requests and a returned commit record. */
export const PROJECTION_MEMORY_BYTES = PROJECTION_MEMORY_MIB * KIB * KIB;
/** How often a chunk waiting for room asks again. */
const ASK_AGAIN_MS = 20;
/** How long a waiting chunk keeps its place without asking again: past it, its object is gone. */
const WAITING_LAPSE_MS = 5000;
/**
 * How long a chunk's room is held without word from it: far past what a chunk's reads and writes
 * take, so that it is taken back from an object reset while it built, and from no other.
 */
const BUILDING_LAPSE_MS = 60_000;

/** A chunk's claim on the isolate's room: the bytes, whether it builds yet, and until when it holds. */
interface Claim {
  readonly bytes: number;
  building: boolean;
  until: number;
}

/** The claims of every run in the isolate, in the order they were made: the module's, no scope's. */
const claims: Claim[] = [];

/**
 * Whether `claim` may begin at `now`: it is the first that waits, and there is room for it beside
 * the chunks building. A claim takes the whole budget at the most, so one alone always has room.
 * What has lapsed is let go of first; a claim that lapsed while its run still waits is made again,
 * last.
 */
function admits(claim: Claim, now: number): boolean {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if ((claims[index]?.until ?? now) <= now) {
      claims.splice(index, 1);
    }
  }
  if (!claims.includes(claim)) {
    claims.push(claim);
  }
  let taken = 0;
  for (const other of claims) {
    taken += other.building ? other.bytes : 0;
  }
  return (
    claims.find((other) => !other.building) === claim &&
    taken + claim.bytes <= PROJECTION_MEMORY_BYTES
  );
}

/**
 * `build`, once the isolate has room for the `bytes` it reckons it holds, given back as it ends. A
 * chunk that builds no record — a withdrawal's — holds nothing, and waits for nothing; one whose
 * reckoning is no number at all is taken to hold the whole budget, as a record it cannot reckon is.
 */
export async function withProjectionMemory<T>(bytes: number, build: () => Promise<T>): Promise<T> {
  if (bytes === 0) {
    return build();
  }
  const claim: Claim = {
    bytes: Number.isFinite(bytes)
      ? Math.min(bytes, PROJECTION_MEMORY_BYTES)
      : PROJECTION_MEMORY_BYTES,
    building: false,
    until: 0,
  };
  try {
    for (;;) {
      const now = Date.now();
      claim.until = now + WAITING_LAPSE_MS;
      if (admits(claim, now)) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, ASK_AGAIN_MS);
      });
    }
    claim.building = true;
    claim.until = Date.now() + BUILDING_LAPSE_MS;
    return await build();
  } finally {
    const at = claims.indexOf(claim);
    if (at !== -1) {
      claims.splice(at, 1);
    }
  }
}
