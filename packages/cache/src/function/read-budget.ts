/**
 * The room an isolate has for the artifacts it reads whole: the authority's answers, and its data
 * center's copies of them (`artifacts.ts`); for the delivery records it reads, from the gateways and
 * from its data center's copies of them (`gateway.ts`, `record-copies.ts`); and for its data
 * center's copies of the values it wrote (`data-copies.ts`), and optional host-fetched bundle blobs
 * (`bundle-blobs.ts`). An artifact is read whole before it is
 * answered with — the runtime takes bytes, not a stream — and the reads of every request the
 * isolate serves would otherwise all be read at once, however many there were and however long.
 */

import { concatBytes, releaseStream } from '@stayingupwind/core/util';

import { type GiveBack, IsolateRoom } from '../isolate-room.ts';

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
  /** The room this and its preceding claims account for together. */
  readonly bytes: number;
  readonly before: Claim | undefined;
  readonly granted: Promise<GiveBack>;
  readonly ready: Promise<unknown>;
  readonly abandoned: AbortController;
}

/** The room one candidate still needs: a copy and the authority's answer can disagree. */
interface Holder {
  readonly bytes: number;
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
  /** The first candidate's room, then any extra a larger candidate needs beside it. */
  #claim: Claim | undefined;
  readonly #holders: Holder[] = [];

  constructor(budget: IsolateRoom) {
    this.#budget = budget;
  }

  /** Room for `bytes` from the budget: only what the preceding claims do not account for yet. */
  #ask(bytes: number): Claim {
    const before = this.#claim;
    const extra = bytes - (before?.bytes ?? 0);
    const abandoned = new AbortController();
    const now = this.#budget.takeAtOnce(extra, this);
    const granted =
      now === undefined ? this.#budget.take(extra, abandoned.signal, this) : Promise.resolve(now);
    const ready = before === undefined ? granted : Promise.all([before.ready, granted]);
    const claim = { bytes, before, granted, ready, abandoned };
    this.#claim = claim;
    return claim;
  }

  /**
   * One candidate fewer needs room. Any extra no remaining candidate needs goes back, or gives
   * its place up while still waiting; room granted just as it did goes back as it comes.
   */
  #leave(holder: Holder): void {
    this.#holders.splice(this.#holders.indexOf(holder), 1);
    let needed = 0;
    for (const remaining of this.#holders) {
      needed = Math.max(needed, remaining.bytes);
    }
    let claim = this.#claim;
    while (
      claim !== undefined &&
      (this.#holders.length === 0 || (claim.before !== undefined && claim.before.bytes >= needed))
    ) {
      this.#claim = claim.before;
      claim.abandoned.abort();
      void giveBack(claim.granted).catch(() => {
        // Called off before room came: nothing was taken.
      });
      claim = this.#claim;
    }
  }

  /**
   * Room for a read of `bytes` once there is, and what gives it back: the room the other read of
   * the artifact holds or waits for, where it does; otherwise taken from the budget. A larger answer
   * takes only the extra: a copy written by application code may state less than the authority answers
   * with. Given up, and any extra needed only by this read with it, where `signal` aborts first.
   */
  async hold(bytes: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const size = Number.isFinite(bytes)
      ? Math.min(bytes, this.#budget.capacity)
      : this.#budget.capacity;
    const holder = { bytes: size };
    let claim = this.#claim;
    while (claim?.before !== undefined && claim.before.bytes >= size) {
      claim = claim.before;
    }
    if (claim === undefined || claim.bytes < size) {
      claim = this.#ask(size);
    }
    this.#holders.push(holder);
    try {
      await untilAborted(claim.ready, signal);
    } catch (error) {
      this.#leave(holder);
      throw error;
    }
    let holding = true;
    return () => {
      if (holding) {
        holding = false;
        this.#leave(holder);
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

/** Bytes read whole at once by a Function isolate, across gateways and optional bundle fallbacks. */
const KIB = 1024;
const MIB = KIB * KIB;
const FUNCTION_READ_MIB = 32;
export const FUNCTION_READ_BYTES = FUNCTION_READ_MIB * MIB;
const shared: { room?: IsolateRoom; lengthErrors?: WeakSet<Error> } = {};

/** Allocated only when this isolate first reads through either host interface. */
export function functionReadBudget(): IsolateRoom {
  shared.room ??= new IsolateRoom(FUNCTION_READ_BYTES);
  return shared.room;
}

/** Workers adds this native operation; other hosts may expose only the standard BYOB reader. */
type NativeRead = (
  this: ReadableStreamBYOBReader,
  min: number,
  view: Uint8Array<ArrayBuffer>,
) => Promise<ReadableStreamReadResult<Uint8Array>>;

type ReadResult = Uint8Array | ReadableStreamReadResult<Uint8Array>;
export interface BodyRead {
  readonly reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  readonly pending: Promise<ReadResult>;
}
/** Recognize only an overflow made by this reader, preserving its ordinary Error contract. */
export function isBodyLengthError(error: unknown): boolean {
  return error instanceof Error && shared.lengthErrors?.has(error) === true;
}

function bodyLengthError(what: string): Error {
  const error = new Error(`${what} length mismatch`);
  shared.lengthErrors ??= new WeakSet();
  shared.lengthErrors.add(error);
  return error;
}
function nativeReadOf(reader: ReadableStreamBYOBReader): NativeRead | undefined {
  const read: unknown = Reflect.get(reader, 'readAtLeast');
  return typeof read === 'function' ? (read as NativeRead) : undefined;
}

/** Only non-byte adapter streams take this bounded chunk path; native service bodies do not. */
async function otherBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  what: string,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(parts);
    total += value.byteLength;
    if (total > limit) throw bodyLengthError(what);
    parts.push(value);
  }
}

/** One sentinel byte distinguishes exact EOF from a larger answer without reading it whole. */
export function beginBody(body: ReadableStream<Uint8Array>, limit: number, what: string): BodyRead {
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = body.getReader({ mode: 'byob' });
  } catch {
    // A custom host may answer with a non-byte stream; keep that path bounded too.
  }
  if (byob !== undefined) {
    const read = nativeReadOf(byob);
    if (read !== undefined) {
      const capacity = limit + 1;
      try {
        return { reader: byob, pending: read.call(byob, capacity, new Uint8Array(capacity)) };
      } catch (error) {
        releaseStream(byob, `${what} reader not started`);
        byob.releaseLock();
        throw error;
      }
    }
    byob.releaseLock();
  }
  const reader = body.getReader();
  return { reader, pending: otherBytes(reader, limit, what) };
}

const DIGITS = /^\d+$/u;

/** How long an answer says it is (`content-length`); `undefined` for one that does not say. */
export function saidLength(response: Response): number | undefined {
  const length = response.headers.get('content-length');
  return length !== null && DIGITS.test(length) ? Number(length) : undefined;
}

/**
 * How long the authority says its answer is (`content-length`), which it always says. An answer
 * that does not say is taken to be as long as a read may take.
 */
export function projectedLength(response: Response): number {
  return saidLength(response) ?? FUNCTION_READ_BYTES;
}

/**
 * The Function's artifact buffer, at most its shared 32 MiB room. Larger seeded or configured
 * uploads still deploy and stream elsewhere; this cache read misses. A native body takes one
 * BYOB read with a sentinel byte: capacity is charged up to the budget's ceiling, with one extra
 * byte at that ceiling. Generic host streams stay bounded in chunks.
 */
export async function readArtifactWhole(
  response: Response,
  signal: AbortSignal,
  room: ArtifactRoom,
): Promise<Uint8Array | undefined> {
  const expected = saidLength(response);
  if (expected !== undefined && expected > FUNCTION_READ_BYTES) {
    releaseStream(response.body, 'artifact exceeds the Function read budget');
    return;
  }
  const limit = expected ?? FUNCTION_READ_BYTES;
  let release: () => void;
  try {
    release = await room.hold(limit + 1, signal);
  } catch (error) {
    releaseStream(response.body, 'an artifact read given up before its body');
    throw error;
  }
  let reading: BodyRead | undefined;
  const abort = (): void => {
    releaseStream(reading?.reader ?? response.body, 'artifact read abandoned');
  };
  try {
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    if (response.body === null) {
      return expected === undefined || expected === 0 ? new Uint8Array() : undefined;
    }
    reading = beginBody(response.body, limit, 'artifact');
    if (signal.aborted) abort();
    const result = await reading.pending;
    signal.throwIfAborted();
    const bytes = result instanceof Uint8Array ? result : (result.value ?? new Uint8Array());
    if (bytes.byteLength > limit || (expected !== undefined && bytes.byteLength !== expected)) {
      abort();
      return;
    }
    return bytes;
  } catch (error) {
    abort();
    if (isBodyLengthError(error)) return;
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      reading?.reader.releaseLock();
    } finally {
      release();
    }
  }
}
