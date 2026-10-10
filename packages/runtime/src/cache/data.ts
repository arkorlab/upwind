import { createHash } from 'node:crypto';

import { fromBase64, toBase64, withDeadline } from '@stayingupwind/core/util';

import type { DataEntryMetadata, DataRead, DataReadRequest, DataWritten } from './host.ts';
import type { CacheRuntime, DataHold, DataMemo, DataState } from './runtime.ts';
import type { Turn } from './turns.ts';

/** Data bytes and mutation ordering have separate budgets: eviction must never erase a fence. */
const MILLISECONDS_PER_SECOND = 1000;
const MAX_LITERAL_KEY_CHARS = 4096;

function keyOf(request: DataReadRequest): string {
  return `${request.kind}|${request.handler ?? ''}|${request.key}`;
}

/** Next.js keys include serialized arguments and can exceed the entire metadata budget. */
function stateKeyOf(key: string): string {
  // UTF-16 preserves distinct JS strings, including unpaired surrogates. This prefix cannot be
  // a literal key, which always starts with a data-cache kind. Short keys need no hashing.
  return key.length <= MAX_LITERAL_KEY_CHARS
    ? key
    : `sha256-utf16:${createHash('sha256').update(key, 'utf16le').digest('hex')}`;
}

/** The key's state as it stands: held by a write in flight, else under the LRU. */
function liveState(runtime: CacheRuntime, stateKey: string): DataState | undefined {
  return runtime.dataWrites.get(stateKey)?.state ?? runtime.dataStates.get(stateKey);
}

function stateFor(runtime: CacheRuntime, key: string, stateKey = stateKeyOf(key)): DataState {
  const present = liveState(runtime, stateKey);
  if (present !== undefined) return present;
  const memo = runtime.dataMemo.get(key);
  const state = {
    epoch: 0,
    revision: memo?.kind === 'found' ? memo.response.dependencyRevision : 0,
    finds: 0,
  };
  runtime.dataStates.set(stateKey, state);
  return state;
}

/** Every read of the key under way now answers too late to be remembered. */
function fenceReads(state: DataState): void {
  state.epoch += 1;
}

function currentOrMissing(runtime: CacheRuntime, key: string): DataMemo {
  return runtime.dataMemo.get(key) ?? { kind: 'missing' };
}

async function withBytes(runtime: CacheRuntime, response: DataRead): Promise<DataMemo> {
  if (response.value.kind === 'inline') {
    // Not `Uint8Array.from` over what `atob` makes, which collected every byte into a list of
    // numbers first, several times the size of the value it was decoding (`fromBase64`).
    return { kind: 'found', response, bytes: fromBase64(response.value.base64) };
  }
  const bytes = await runtime.host.readArtifact(response.value.artifactId);
  return bytes === undefined ? { kind: 'missing' } : { kind: 'found', response, bytes };
}

/**
 * The regional projection, rejected if a local write overtook the read.
 *
 * Read by every call the memo cannot answer, however many reads of the key are under way. A read is
 * I/O of the request that started it, which the Workers runtime cancels once that request is over:
 * a render of another request that joined it would wait on it for as long as its own request was
 * let run, and so would every later miss of the key in the isolate. Only what a read found is
 * shared, through the memo. Nor is a read shared within a request, where Next.js mostly asks for a
 * key once at a time already: `use cache` joins the call under way, and a `fetch` waits for the
 * lock its `IncrementalCache` holds on the key.
 */
export async function readData(runtime: CacheRuntime, request: DataReadRequest): Promise<DataMemo> {
  const key = keyOf(request);
  const remembered = runtime.dataMemo.get(key);
  if (remembered !== undefined) return remembered;
  const stateKey = stateKeyOf(key);
  const state = stateFor(runtime, key, stateKey);
  // Read now, and weighed against the live state once the read answers.
  const epoch = state.epoch;
  const finds = state.finds;
  // What keeps a read from overwriting a write is the key's state, whose epoch every write moves,
  // and the revision floor: a read that answers after either moved is not remembered.
  const current = (): boolean => liveState(runtime, stateKey) === state && state.epoch === epoch;
  const answer = await runtime.host.getData(request);
  if (!current() || (answer !== undefined && answer.dependencyRevision < state.revision)) {
    return currentOrMissing(runtime, key);
  }
  // Observe ordering before a potentially slow artifact read, even if its bytes are missing.
  if (answer !== undefined) state.revision = answer.dependencyRevision;
  const memo =
    answer === undefined ? { kind: 'missing' as const } : await withBytes(runtime, answer);
  if (!current() || (memo.kind === 'found' && memo.response.dependencyRevision < state.revision)) {
    return currentOrMissing(runtime, key);
  }
  // Another read of the key can have found the value while this one was under way. A value is
  // ordered against it by the revision floor above; a miss carries no revision to be ordered by,
  // and is not remembered in its place — whether or not the value was small enough to be kept.
  if (memo.kind === 'found') {
    state.finds += 1;
  } else if (state.finds !== finds) {
    return currentOrMissing(runtime, key);
  }
  runtime.dataMemo.set(key, memo);
  return memo;
}

/**
 * How long a read waits for a value later than the one it judged, past that read. It judged the
 * value stale or expired: what waits on the answer otherwise is computing the value again.
 */
const NEWER_DATA_DEADLINE_MS = 200;

/** A value later than the one a read judged, read whole, and how to keep it once it is taken. */
export interface LaterData {
  readonly memo: Extract<DataMemo, { kind: 'found' }>;
  /** Remember it as a read's answer is, under the key's floor; nothing where it fell below it. */
  readonly keep: () => void;
}

/**
 * A value of the key later than the one at `than`, where the host keeps one nearer than its read
 * (`getNewerData`), read whole — its bytes too, where they are stored apart — within
 * `NEWER_DATA_DEADLINE_MS`: `undefined` for none, none in time, a read that failed, or a host
 * without any. Never rejects, and remembers nothing until the caller takes it (`keep`): a host whose
 * reads are cached answers with the value a later write replaced for as long as its cache keeps it,
 * and a read that judged that value stale or expired would compute again what another isolate has
 * already written — where the later one stands no worse.
 */
export async function readNewerData(
  runtime: CacheRuntime,
  request: DataReadRequest,
  than: number,
): Promise<LaterData | undefined> {
  const { host } = runtime;
  if (host.getNewerData === undefined) {
    return undefined;
  }
  const key = keyOf(request);
  const stateKey = stateKeyOf(key);
  const state = stateFor(runtime, key, stateKey);
  const epoch = state.epoch;
  const current = (): boolean => liveState(runtime, stateKey) === state && state.epoch === epoch;
  const read = async (): Promise<LaterData['memo'] | undefined> => {
    const answer = await host.getNewerData?.(request, than);
    if (answer === undefined || answer.dependencyRevision <= than) {
      return undefined;
    }
    const memo = await withBytes(runtime, answer);
    return memo.kind === 'found' ? memo : undefined;
  };
  let memo: LaterData['memo'] | undefined;
  try {
    memo = await withDeadline(read(), NEWER_DATA_DEADLINE_MS, 'a later data value');
  } catch (error) {
    runtime.log('later data value not read', {
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (memo === undefined) {
    return undefined;
  }
  const found = memo;
  return {
    memo: found,
    keep: () => {
      if (!current() || found.response.dependencyRevision < state.revision) {
        return;
      }
      state.revision = found.response.dependencyRevision;
      state.finds += 1;
      runtime.dataMemo.set(key, found);
    },
  };
}

/**
 * How long a write is taken to be in flight at the most: the time a request may go on for once it
 * has answered (`waitUntil`). A write whose request ended under it never answers, and would hold its
 * key's state out of the LRU's reach for as long as the isolate lives.
 */
const WRITE_LIFETIME_MS = 30_000;

/** How many keys' states writes in flight hold at once. Past it, the oldest holds are let go of. */
const MAX_HELD_STATES = 512;

/** A write in flight: the key, and the hold that keeps its state out of the LRU's reach. */
interface Write {
  readonly key: string;
  readonly stateKey: string;
  readonly state: DataState;
  readonly hold: DataHold;
}

/**
 * Let go of the holds whose latest write began longer ago than a write can be in flight, and of the
 * oldest beyond the budget, before another is taken: keys each written once, under a host that
 * answers none of them, would otherwise each hold a state, and its key, for good. Whether their
 * writes landed is not known, as for a write that failed: a read of the key under way is fenced,
 * what was remembered of the key is forgotten, and the state goes back to the LRU. A reply that
 * comes after all still raises the state's floor (`finishWrite`).
 */
function releaseHolds(runtime: CacheRuntime, now: number): void {
  for (const [stateKey, hold] of runtime.dataWrites) {
    if (runtime.dataWrites.size < MAX_HELD_STATES && now - hold.since < WRITE_LIFETIME_MS) {
      return;
    }
    runtime.dataWrites.delete(stateKey);
    fenceReads(hold.state);
    runtime.dataMemo.delete(hold.key);
    runtime.dataStates.set(stateKey, hold.state);
  }
}

/**
 * Hold the key's state for a write until it answers, so every write of the key in flight at once
 * raises one floor, however many other keys pass through the LRU meanwhile.
 */
function startWrite(runtime: CacheRuntime, key: string): Write {
  const now = performance.now();
  releaseHolds(runtime, now);
  const stateKey = stateKeyOf(key);
  const state = stateFor(runtime, key, stateKey);
  const hold = runtime.dataWrites.get(stateKey) ?? { key, state, writes: 0, since: now };
  hold.writes += 1;
  hold.since = now;
  // Put back last, so that the holds stand in the order their latest writes began in, and the ones
  // let go of first are the oldest.
  runtime.dataWrites.delete(stateKey);
  runtime.dataWrites.set(stateKey, hold);
  fenceReads(state);
  return { key, stateKey, state, hold };
}

/**
 * A write's answer, or its failure: raise the floor to what it committed, fence the reads that
 * began meanwhile, and hand the state back to the LRU once no other write is in flight on it. A
 * hold let go of as lost (`releaseHolds`), and maybe taken again since by a write of its own, is
 * not this write's to end; the floor it raises is raised on the key's state as it is now too.
 */
function finishWrite(runtime: CacheRuntime, write: Write, revision = write.state.revision): void {
  const { key, stateKey, state, hold } = write;
  state.revision = Math.max(state.revision, revision);
  fenceReads(state);
  if (runtime.dataWrites.get(stateKey) !== hold) {
    // What it committed is the key's floor all the same, on whichever state the key has now: the
    // one let go of may have left the LRU since, and a read on a state of its own would otherwise
    // take an answer older than this write for current.
    const live = stateFor(runtime, key, stateKey);
    if (live !== state) {
      live.revision = Math.max(live.revision, state.revision);
      fenceReads(live);
    }
    return;
  }
  hold.writes -= 1;
  if (hold.writes === 0) {
    runtime.dataWrites.delete(stateKey);
    runtime.dataStates.set(stateKey, state);
  }
}

/** Where a write stands among the writes this isolate handed over (`DataWriteRequest.order`). */
export interface WriteOrder {
  readonly writer: string;
  readonly seq: number;
}

/**
 * This isolate as the writer of what it writes (`DataWriteRequest.order`): an id drawn on its first
 * write — never as the module loads, where a Worker may draw nothing at random — and the writes
 * handed over since.
 */
const writer: { id: string | undefined; handed: number } = { id: undefined, handed: 0 };

/**
 * The next place in this isolate's order, taken as a value is handed over and before it waits to
 * go: a write sent after one handed over after it is still the earlier of the two.
 */
export function nextWriteOrder(): WriteOrder {
  writer.id ??= crypto.randomUUID();
  writer.handed += 1;
  return { writer: writer.id, seq: writer.handed };
}

/**
 * Write a value under its key, as the host's next revision of the entry, its call to the host in
 * the request's `turn`: behind the work (`callsBehind`), or ahead of it, for a write the render
 * waits on (`callsWaitedOn`).
 */
export async function writeData(
  runtime: CacheRuntime,
  input: { key: string; entry: DataEntryMetadata; bytes: Uint8Array; order?: WriteOrder },
  turn?: Turn,
): Promise<void> {
  const key = keyOf({ key: input.key, kind: input.entry.kind, handler: input.entry.handler });
  const write = startWrite(runtime, key);
  const { state } = write;
  runtime.dataMemo.delete(key);
  // Its place in the order as it is handed over, before it waits for its turn to go out.
  const order = input.order ?? nextWriteOrder();
  // Encoded once its turn has come, so that a write waiting for one holds no second copy.
  const set = async (): Promise<{
    readonly written: DataWritten;
    readonly valueBase64: string;
  }> => {
    const valueBase64 = toBase64(input.bytes);
    const written = await runtime.host.setData({
      key: input.key,
      entry: input.entry,
      valueBase64,
      order,
    });
    return { written, valueBase64 };
  };
  let sent;
  try {
    sent = await (turn === undefined ? set() : turn(set));
  } catch (error) {
    // A failure does not prove the host rejected the mutation: also discard a value
    // value read during the write.
    finishWrite(runtime, write);
    runtime.dataMemo.delete(key);
    throw error;
  }
  const { written, valueBase64 } = sent;
  finishWrite(runtime, write, written.revision);
  const memo = runtime.dataMemo.get(key);
  if (memo?.kind !== 'found' || memo.response.dependencyRevision < state.revision) {
    runtime.dataMemo.delete(key);
  }
  // A newer write or read raised the floor past this one, or the host kept a write this isolate
  // sent after this one (`superseded`): what a read of the key finds is the host's to say. The floor
  // remains independent of oversized, evicted or expired byte payloads.
  if (written.revision < state.revision || written.superseded === true) return;
  runtime.dataMemo.set(
    key,
    {
      kind: 'found',
      response: {
        entryId: written.entryId,
        generationId: written.generationId,
        dependencyRevision: written.revision,
        entry: input.entry,
        value: { kind: 'inline', base64: valueBase64 },
        // A write can land on a generation an invalidation condemned — since, when unchanged, or
        // before it arrived, when made before it; remember it as a read would answer it.
        ...(written.invalidation !== undefined && { invalidation: written.invalidation }),
      },
      bytes: input.bytes,
    },
    Math.max(runtime.holdMs, input.entry.expire * MILLISECONDS_PER_SECOND),
  );
}
