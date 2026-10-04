import type { InvalidationState } from '@stayingupwind/core/cache';

import { nextWriteOrder, type WriteOrder, writeData } from './data.ts';
import type { DataEntryMetadata } from './host.ts';
import type { CacheRuntime } from './runtime.ts';
import type { Turn } from './turns.ts';

/**
 * The cache handlers' writes still out in this isolate (`handlers.ts`): a write is handed over as
 * the render answers and goes to the host behind it, in the request's `waitUntil`, ordered behind
 * any write of its key still out; meanwhile a read of the key here is answered with what the write
 * carries. One table per store — the fetch cache's, and each `use cache` handler's — whose keys are
 * their own.
 */

const KIB = 1024;
const MIB = KIB * KIB;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A value as a read judges it: the entry's metadata, the bytes, and what an invalidation made of
 * the entry, where the host said.
 */
export interface HeldValue {
  readonly entry: DataEntryMetadata;
  readonly bytes: Uint8Array;
  readonly invalidation?: InvalidationState | undefined;
}

/**
 * How long a write waits for the write of its key that was out when it was handed over. Past this
 * the earlier one is taken for lost — its request may have ended under it, and what a request that
 * has ended left out never settles in another — and the write goes regardless, so it may land
 * first. Should the earlier one land after it all the same, the host keeps the later of the two,
 * which this isolate sent after it (`DataWriteRequest.order`, `DataWritten.superseded`).
 */
const WRITE_PATIENCE_MS = 5000;

/**
 * How long a write is taken to be out at the most: the time a request may go on for once it has
 * answered (`waitUntil`). A write whose request ended under it never settles here, and would
 * otherwise answer reads of its key, and hold its key's later writes back, for as long as the
 * isolate lives.
 */
const WRITE_LIFETIME_MS = 30_000;

/**
 * How many keys' writes a table keeps track of at once. A host that answers no write, under keys
 * that are each written once, would otherwise have the table hold a write per key for as long as
 * the lifetime lets it — and past it, for a key nothing asks for again. Past this the oldest go:
 * their writes go on, and only their place in the order, and the reads they answer, are given up.
 * One that lands after a later write of its key is then not kept: the host keeps the write this
 * isolate sent later (`DataWritten.superseded`), as for a write that waited its patience out.
 */
const MAX_HELD_WRITES = 512;

/**
 * How many bytes of the values writes carry a table keeps, as the data memo keeps what it read
 * within a budget of its own: a value may be tens of MiB, and the table's keys alone bound none of
 * that. Past it, the writes that have gone out let go of what they keep for reads, oldest first —
 * their requests hold it while they are in flight, and no longer — and a read of their keys asks
 * the host meanwhile. Then the writes still waiting to go are dropped, oldest first: a value of
 * their keys not kept, as when the host fails a write, rather than an isolate's memory spent on
 * what a stalled host holds back.
 */
const HELD_WRITE_MIB = 8;
const HELD_WRITE_BYTES = HELD_WRITE_MIB * MIB;

/**
 * A write handed over and not yet answered: what it writes, when, where it stands among the writes
 * this isolate handed over (`nextWriteOrder`), the write of its key it goes after, whether it has
 * gone out, and a promise that settles as it is answered, has failed, or will not go. It lets its
 * bytes go once a newer write of its key takes its place before it went out, once the table lets
 * go of it — one that had yet to go then never goes — or once its bytes are past the budget.
 */
interface HeldWrite {
  readonly entry: DataEntryMetadata;
  bytes: Uint8Array | undefined;
  readonly handedAt: number;
  readonly order: WriteOrder;
  readonly after: Promise<void> | undefined;
  sent: boolean;
  settled: Promise<void> | undefined;
}

/**
 * The writes of one store still out in this isolate — the fetch cache's, or one `use cache`
 * handler's: for each key, the last one handed over, which is what a read of the key is answered
 * with meanwhile (`get`), oldest first, and how many bytes of their values the table keeps
 * (`HELD_WRITE_BYTES`). An entry leaves as its write settles, or once it is older than a write can
 * be out (`WRITE_LIFETIME_MS`) — swept as any write is handed over, whatever its key — or once
 * `MAX_HELD_WRITES` newer ones are kept.
 */
export interface HeldWrites {
  readonly byKey: Map<string, HeldWrite>;
  held: number;
  /** What the log calls a write of this store's. */
  readonly label: string;
  /** The turns its writes go out in, among the request's calls to the host. */
  readonly turn: () => Turn;
}

/** Each runtime's tables, by store: `fetch`, or a `use cache` handler's kind. */
const heldWrites = new WeakMap<CacheRuntime, Map<string, HeldWrites>>();

/** The store's table in this runtime, if one has been made. */
export function writesIn(runtime: CacheRuntime, store: string): HeldWrites | undefined {
  return heldWrites.get(runtime)?.get(store);
}

/** The store's table in this runtime, made as its first write is handed over. */
export function tableOf(
  runtime: CacheRuntime,
  store: string,
  label: string,
  turn: () => Turn,
): HeldWrites {
  const stores = heldWrites.get(runtime) ?? new Map<string, HeldWrites>();
  heldWrites.set(runtime, stores);
  const existing = stores.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const made: HeldWrites = { byKey: new Map<string, HeldWrite>(), held: 0, label, turn };
  stores.set(store, made);
  return made;
}

/**
 * A write's value no longer kept: what it keeps for reads, or, where it has yet to go, what it goes
 * with — it then never goes. Whether it was one that had yet to go.
 */
function letGo(writes: HeldWrites, write: HeldWrite): boolean {
  if (write.bytes === undefined) {
    return false;
  }
  writes.held -= write.bytes.byteLength;
  write.bytes = undefined;
  return !write.sent;
}

/**
 * Take a write out of the table, if it is still the key's, and let go of its value. One that had yet
 * to go never goes: a later write of the key, with nothing before it in the table, may be sent
 * first, and this one would land after it. Whether it was one.
 */
function forget(writes: HeldWrites, key: string, write: HeldWrite): boolean {
  if (writes.byKey.get(key) !== write) {
    return false;
  }
  writes.byKey.delete(key);
  return letGo(writes, write);
}

/** The key's write still out, if there is one: none handed over longer ago than a write can be. */
function writeOut(writes: HeldWrites, key: string): HeldWrite | undefined {
  const write = writes.byKey.get(key);
  if (write !== undefined && performance.now() - write.handedAt >= WRITE_LIFETIME_MS) {
    forget(writes, key, write);
    return undefined;
  }
  return write;
}

/**
 * Let go of the writes handed over longer ago than a write can be out, and of the oldest beyond the
 * budget, before another is kept: a write that never settles never leaves on its own, and its key
 * may never be asked for again.
 */
function sweepWrites(runtime: CacheRuntime, writes: HeldWrites): void {
  const now = performance.now();
  for (const [key, write] of writes.byKey) {
    const lost = now - write.handedAt >= WRITE_LIFETIME_MS;
    if (!lost && writes.byKey.size < MAX_HELD_WRITES) {
      return;
    }
    // One past the lifetime was cut off with its request: nothing of it was going to go.
    const dropped = forget(writes, key, write);
    if (!lost && dropped) {
      runtime.log(`${writes.label} write dropped`, { detail: 'waiting past the keys kept' });
    }
  }
}

/**
 * Keep no more of the values writes carry than the budget (`HELD_WRITE_BYTES`): what the writes
 * gone out keep for reads first, and then the writes still waiting to go, which then never go.
 */
function trimWrites(runtime: CacheRuntime, writes: HeldWrites): void {
  for (const write of writes.byKey.values()) {
    if (writes.held <= HELD_WRITE_BYTES) {
      return;
    }
    if (write.sent) {
      letGo(writes, write);
    }
  }
  for (const write of writes.byKey.values()) {
    if (writes.held <= HELD_WRITE_BYTES) {
      return;
    }
    if (letGo(writes, write)) {
      runtime.log(`${writes.label} write dropped`, { detail: 'waiting past the byte budget' });
    }
  }
}

/** What the key's write still out in this isolate carries, if there is one. */
export function heldOut(writes: HeldWrites | undefined, key: string): HeldValue | undefined {
  const write = writes === undefined ? undefined : writeOut(writes, key);
  return write?.bytes === undefined ? undefined : { entry: write.entry, bytes: write.bytes };
}

/** `promise` settled, or `ms` gone by, whichever is first. */
async function patiently(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Send a write once the one it goes after has settled, unless a newer one took its place. */
async function send(
  runtime: CacheRuntime,
  writes: HeldWrites,
  key: string,
  write: HeldWrite,
): Promise<void> {
  try {
    // Never rejects: a write that failed is logged below, and the next one goes on. With none
    // before it, the write takes the key's state before this first waits (`writeData`).
    if (write.after !== undefined) {
      await patiently(write.after, WRITE_PATIENCE_MS);
    }
    const { bytes } = write;
    if (bytes === undefined) {
      return;
    }
    write.sent = true;
    trimWrites(runtime, writes);
    await writeData(runtime, { key, entry: write.entry, bytes, order: write.order }, writes.turn());
  } catch (error) {
    // The render has its data; what failed is keeping it for the next one.
    runtime.log(`${writes.label} write failed`, { detail: detail(error) });
  } finally {
    // A later write of the key, handed over meanwhile, keeps its place.
    forget(writes, key, write);
  }
}

/**
 * Write a value under the key and the entry its render gave it, once the write of the key that is
 * out has been answered: what a `fetch` answered (`PlatformFetchCache.set`), or what a `use cache`
 * function returned (`setUseCache`).
 *
 * Next.js ordered a key's writes itself while it waited on them: a render's writes of one key ran
 * one after another (`cache-set-<key>`, in `createCachedDynamicResponse`), and its lock on the key
 * held a second render's until the first had landed. Both now let go as `set()` answers, which is
 * before the write lands; two writes of a key out at once would reach the host in whichever order
 * the network gave them. So a write goes out only once the one before it has been answered, and the
 * render waits on none of them. Where they cross all the same — one waited its patience out, or the
 * table let go of the one before it — the host keeps the one this isolate sent later, not the one
 * that landed last (`DataWritten.superseded`).
 *
 * At most one waits: a write handed over while another of its key is still waiting takes that one's
 * place, and the one it replaces never goes out. The host would keep the newer anyway, and a key
 * the host is slow to answer for, written again by every render that misses it meanwhile, would
 * otherwise hold every value those renders made until it did. Nor does one wait for long
 * (`WRITE_PATIENCE_MS`), or for a write handed over longer ago than a write can be out
 * (`WRITE_LIFETIME_MS`): the request a write is kept alive by may end under it, and a write waiting
 * on that one would never go.
 */
export function keepWrite(
  runtime: CacheRuntime,
  writes: HeldWrites,
  { key, entry, bytes }: { key: string; entry: DataEntryMetadata; bytes: Uint8Array },
): Promise<void> {
  const previous = writeOut(writes, key);
  sweepWrites(runtime, writes);
  let after = previous?.settled;
  if (previous?.sent === false) {
    // It never went out: this one takes its place, behind the write it was waiting for.
    letGo(writes, previous);
    ({ after } = previous);
  }
  const write: HeldWrite = {
    entry,
    bytes,
    handedAt: performance.now(),
    order: nextWriteOrder(),
    after,
    sent: false,
    settled: undefined,
  };
  // Taken out before it is put back, so that the writes stand in the order they were handed over,
  // and the ones the sweep lets go of first are the oldest.
  if (previous !== undefined) {
    forget(writes, key, previous);
  }
  writes.byKey.set(key, write);
  writes.held += bytes.byteLength;
  write.settled = send(runtime, writes, key, write);
  trimWrites(runtime, writes);
  return write.settled;
}
