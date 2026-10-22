import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  kvGenerationKey,
} from '@stayingupwind/core/cache';
import { TtlCache, withDeadline } from '@stayingupwind/core/util';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import type { EdgeMemory } from '../memory/caches.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { claimBackgroundRecord } from './background-record-budget.ts';
import { isInvalidated } from './condemned.ts';
import { adoptDecoded, copyMaxAgeMs, heldLater, sameGeneration } from './generation-adoption.ts';
import { keepCopyAhead } from './generation-copy.ts';
import type { GenerationKey, Read } from './generation-hold.ts';

const MAX_RECENT_READS = 1024;
const CURRENT_RECORD_READ_MS = 1000;
const MAX_RECORD_MIB = 4;
const KIB = 1024;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;

interface CurrentReads {
  readonly recent: TtlCache<string, number>;
}

/**
 * A request gets a runtime of its own, but shares its isolate memory. Keep its cadence with that
 * memory; pending reads share the background-record budget. Fresh delivery has no bookkeeping here.
 */
const reads = new WeakMap<EdgeMemory, CurrentReads>();

type RecordVersion = Pick<DecodedGenerationPack['header'], 'scopeId' | 'entryId' | 'revision'>;

interface CurrentRead {
  readonly target: RecordVersion;
  readonly settings: RuntimeCacheSettings;
  active: boolean;
}

/** A confirmation cannot renew grace for different content at an already-held revision. */
function conflictingHeld(
  edge: EdgeContext,
  recordKey: string,
  pack: DecodedGenerationPack,
): boolean {
  const held = edge.runtime.memory.generations.get(recordKey)?.pack;
  return held?.header.revision === pack.header.revision && !sameGeneration(held, pack);
}

/** The loader's identity, digest, invalidation and revision checks also govern authority bytes. */
async function adoptCurrentRecord(
  edge: EdgeContext,
  current: CurrentRead,
  bytes: ArrayBuffer,
): Promise<void> {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok' || decoded.pack.header.revision <= current.target.revision) {
    return;
  }
  const { scopeId, entryId } = current.target;
  const key = { scopeId, entryId };
  const recordKey = kvGenerationKey(scopeId, entryId);
  const heldAtStart = edge.runtime.memory.generations.get(recordKey);
  const maxAgeMs = copyMaxAgeMs(edge, current.settings);
  const read: Read = {
    key,
    recordKey,
    options: {},
    settings: current.settings,
    startedAt: edge.runtime.now(),
    copies: maxAgeMs > 0,
    heldRevision: heldAtStart?.pack.header.revision,
    heldAtStart,
    adopted: { held: undefined },
  };
  const adopted = await adoptDecoded(edge, read, decoded, {
    origin: { kind: 'authority' },
    byteLength: bytes.byteLength,
    wanted: () => current.active && !conflictingHeld(edge, recordKey, decoded.pack),
  });
  if (adopted.kind === 'adopted' && maxAgeMs > 0) {
    const { revision } = decoded.pack.header;
    const wanted = (): boolean => {
      return (
        current.active &&
        heldLater(edge, recordKey, revision) === undefined &&
        !isInvalidated(edge.runtime.memory, decoded.pack, edge.app?.deploymentId)
      );
    };
    await keepCopyAhead(edge, recordKey, { bytes, revision }, { maxAgeMs, wanted });
  }
}

async function readCurrent(
  edge: EdgeContext,
  current: CurrentRead,
  release: () => void,
): Promise<void> {
  try {
    // Let the synchronous delivery callback return before starting any new authority I/O.
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    const { scopeId, entryId, revision } = current.target;
    const bytes = await edge.host.currentRecord?.(scopeId, entryId, revision);
    if (bytes !== undefined && bytes.byteLength <= MAX_RECORD_BYTES && current.active) {
      await adoptCurrentRecord(edge, current, bytes);
    }
  } finally {
    release();
  }
}

async function boundedRead(
  operation: Promise<void>,
  current: CurrentRead,
  recordKey: string,
): Promise<void> {
  try {
    await withDeadline(operation, CURRENT_RECORD_READ_MS, 'current delivery record read');
  } catch (error) {
    logWarn('current delivery record refresh failed', {
      key: recordKey,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    current.active = false;
  }
}

function readsOf(edge: EdgeContext, cadenceMs: number): CurrentReads {
  let state = reads.get(edge.runtime.memory);
  if (state === undefined) {
    state = {
      recent: new TtlCache(cadenceMs, MAX_RECENT_READS, edge.runtime.now),
    };
    reads.set(edge.runtime.memory, state);
  }
  return state;
}

/**
 * Ask behind a served build or stale record. Regional KV can still answer absent or with A after
 * the authority holds B: its current record, verified by the loader, lets later requests use B
 * without making this response wait or lowering the regional cache's TTL.
 *
 * The deadline bounds the whole operation, including validation and keeping the copy. Its fence
 * forbids adoption after the deadline. An RPC cannot be cancelled through this host contract, so
 * its pending slot stays occupied until it settles: a host that never answers cannot accumulate
 * unlimited calls or late buffers. It leaves normal KV refreshes working throughout.
 */
function requestCurrentBehind(
  edge: EdgeContext,
  target: RecordVersion,
  settings: RuntimeCacheSettings,
  cadenceMs: number,
): void {
  const currentRecord = edge.host.currentRecord;
  if (currentRecord === undefined || edge.validated || settings.holdMs === 0) {
    return;
  }
  const { scopeId, entryId, revision } = target;
  const recordKey = kvGenerationKey(scopeId, entryId);
  const state = readsOf(edge, cadenceMs);
  if (state.recent.get(recordKey) === revision) {
    return;
  }
  const release = claimBackgroundRecord(edge.runtime, recordKey);
  if (release === undefined) return;
  state.recent.set(recordKey, revision, cadenceMs);
  const current: CurrentRead = { target, settings, active: true };
  const operation = readCurrent(edge, current, release);
  edge.ctx.waitUntil(boundedRead(operation, current, recordKey));
}

/** Refresh only behind a stale generation; normal fresh delivery asks no authority. */
export function readCurrentBehind(
  edge: EdgeContext,
  pack: DecodedGenerationPack,
  settings: RuntimeCacheSettings,
  cadenceMs: number,
): void {
  requestCurrentBehind(edge, pack.header, settings, cadenceMs);
}

/**
 * Regional KV can cache an absence while the authority already holds the build's seed or a newer
 * generation. A successfully served build shell asks behind its response, without waiting for a
 * record or pretending the immutable shell is one. Later requests use the verified authority bytes.
 */
export function readAbsentRecordBehind(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
): void {
  if (edge.runtime.memory.generations.get(kvGenerationKey(key.scopeId, key.entryId)) !== undefined)
    return;
  const cadenceMs = Math.min(settings.holdMs, CURRENT_RECORD_READ_MS);
  requestCurrentBehind(edge, { ...key, revision: 0 }, settings, cadenceMs);
}

/** A negative KV refresh confirms the still-graced authority record, including an unchanged one. */
export function confirmHeldRecordBehind(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
): void {
  const cadenceMs = Math.min(settings.holdMs, CURRENT_RECORD_READ_MS);
  requestCurrentBehind(edge, { ...key, revision: 0 }, settings, cadenceMs);
}
