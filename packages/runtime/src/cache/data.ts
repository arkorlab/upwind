import { createHash } from 'node:crypto';

import { toBase64 } from '@stayingupwind/core/util';

import { requestContext } from './context.ts';
import type { DataEntryMetadata, DataRead, DataReadRequest } from './host.ts';
import type { CacheRuntime, DataMemo, DataState } from './runtime.ts';

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
  return runtime.dataWrites.get(stateKey) ?? runtime.dataStates.get(stateKey);
}

function stateFor(runtime: CacheRuntime, key: string, stateKey = stateKeyOf(key)): DataState {
  const present = liveState(runtime, stateKey);
  if (present !== undefined) return present;
  const memo = runtime.dataMemo.get(key);
  const state = {
    epoch: 0,
    revision: memo?.kind === 'found' ? memo.response.dependencyRevision : 0,
    writes: 0,
  };
  runtime.dataStates.set(stateKey, state);
  return state;
}

function fenceReads(runtime: CacheRuntime, key: string, state: DataState): void {
  state.epoch += 1;
  runtime.dataReads.delete(key);
}

function currentOrMissing(runtime: CacheRuntime, key: string): DataMemo {
  return runtime.dataMemo.get(key) ?? { kind: 'missing' };
}

async function withBytes(runtime: CacheRuntime, response: DataRead): Promise<DataMemo> {
  if (response.value.kind === 'inline') {
    const bytes = Uint8Array.from(atob(response.value.base64), (char) => char.codePointAt(0) ?? 0);
    return { kind: 'found', response, bytes };
  }
  const bytes = await runtime.host.readArtifact(response.value.artifactId);
  return bytes === undefined ? { kind: 'missing' } : { kind: 'found', response, bytes };
}

/** The read settled, whichever way: what is kept is the read, and its failure is its waiters'. */
async function kept(read: Promise<unknown>): Promise<void> {
  try {
    await read;
  } catch {
    // Said to whoever waits on the read, as it always was.
  }
}

/**
 * The regional projection, coalesced per key and rejected if a local write overtook the read.
 *
 * A read another request of this isolate began is joined for a hold at most, and the request that
 * begins one hands it to its `waitUntil`. A request's own I/O is cut off with it — its client gone,
 * its invocation over — and what it left out then never settles: a read joined for good would hang
 * every later request for the key, for as long as the isolate lived. Handed over, it outlives the
 * request that began it by as long as the runtime lets that request's work go on; begun more than
 * a hold ago, it is not joined but begun again.
 */
export async function readData(runtime: CacheRuntime, request: DataReadRequest): Promise<DataMemo> {
  const key = keyOf(request);
  const remembered = runtime.dataMemo.get(key);
  if (remembered !== undefined) return remembered;
  const now = performance.now();
  const pending = runtime.dataReads.get(key);
  if (pending !== undefined && now - pending.startedAt < runtime.holdMs) return pending.promise;
  const stateKey = stateKeyOf(key);
  const state = stateFor(runtime, key, stateKey);
  const epoch = state.epoch;
  const identity = Symbol('cache read');
  const current = (): boolean => {
    return (
      liveState(runtime, stateKey) === state &&
      state.epoch === epoch &&
      runtime.dataReads.get(key)?.identity === identity
    );
  };
  const read = (async (): Promise<DataMemo> => {
    try {
      const answer = await runtime.host.getData(request);
      if (!current() || (answer !== undefined && answer.dependencyRevision < state.revision)) {
        return currentOrMissing(runtime, key);
      }
      // Observe ordering before a potentially slow artifact read, even if its bytes are missing.
      if (answer !== undefined) state.revision = answer.dependencyRevision;
      const memo =
        answer === undefined ? { kind: 'missing' as const } : await withBytes(runtime, answer);
      if (
        !current() ||
        (memo.kind === 'found' && memo.response.dependencyRevision < state.revision)
      ) {
        return currentOrMissing(runtime, key);
      }
      runtime.dataMemo.set(key, memo);
      return memo;
    } finally {
      // Here rather than in the request that began it, which may have ended before it settled.
      if (runtime.dataReads.get(key)?.identity === identity) runtime.dataReads.delete(key);
    }
  })();
  runtime.dataReads.set(key, { identity, promise: read, startedAt: now });
  requestContext()?.waitUntil(kept(read));
  return read;
}

/** A write in flight: the key, and the state it holds out of the LRU's reach. */
interface Write {
  readonly key: string;
  readonly stateKey: string;
  readonly state: DataState;
}

/**
 * Hold the key's state for a write until it answers, so every write of the key in flight at once
 * raises one floor, however many other keys pass through the LRU meanwhile.
 */
function startWrite(runtime: CacheRuntime, key: string): Write {
  const stateKey = stateKeyOf(key);
  const state = stateFor(runtime, key, stateKey);
  state.writes += 1;
  runtime.dataWrites.set(stateKey, state);
  fenceReads(runtime, key, state);
  return { key, stateKey, state };
}

/**
 * A write's answer, or its failure: raise the floor to what it committed, fence the reads that
 * began meanwhile, and hand the state back to the LRU once no other write is in flight on it.
 */
function finishWrite(runtime: CacheRuntime, write: Write, revision = write.state.revision): void {
  const { key, stateKey, state } = write;
  state.revision = Math.max(state.revision, revision);
  fenceReads(runtime, key, state);
  state.writes -= 1;
  if (state.writes === 0) {
    runtime.dataWrites.delete(stateKey);
    runtime.dataStates.set(stateKey, state);
  }
}

export async function writeData(
  runtime: CacheRuntime,
  input: { key: string; entry: DataEntryMetadata; bytes: Uint8Array },
): Promise<void> {
  const key = keyOf({ key: input.key, kind: input.entry.kind, handler: input.entry.handler });
  const write = startWrite(runtime, key);
  const { state } = write;
  runtime.dataMemo.delete(key);
  const valueBase64 = toBase64(input.bytes);
  let written;
  try {
    written = await runtime.host.setData({ key: input.key, entry: input.entry, valueBase64 });
  } catch (error) {
    // A failure does not prove the host rejected the mutation: also discard a value
    // value read during the write.
    finishWrite(runtime, write);
    runtime.dataMemo.delete(key);
    throw error;
  }
  finishWrite(runtime, write, written.revision);
  const memo = runtime.dataMemo.get(key);
  if (memo?.kind !== 'found' || memo.response.dependencyRevision < state.revision) {
    runtime.dataMemo.delete(key);
  }
  // A newer write or read raised the floor past this one. The floor remains independent of
  // oversized, evicted or expired byte payloads.
  if (written.revision < state.revision) return;
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
