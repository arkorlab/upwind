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
import { keepCopyAhead } from './generation-copy.ts';
import { adoptDecoded, copyMaxAgeMs, heldLater, type Read } from './generation-loader.ts';

const MAX_RECENT_READS = 1024;
const CURRENT_RECORD_READ_MS = 1000;
const MAX_RECORD_MIB = 4;
const KIB = 1024;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;

interface CurrentReads {
  readonly recent: TtlCache<string, number>;
}

/**
 * A request gets a runtime of its own, but shares its isolate memory. Keep both limits with that
 * memory, created only after stale delivery; fresh delivery has no bookkeeping here.
 */
const reads = new WeakMap<EdgeMemory, CurrentReads>();

interface CurrentRead {
  readonly pack: DecodedGenerationPack;
  readonly settings: RuntimeCacheSettings;
  active: boolean;
}

/** The loader's identity, digest, invalidation and revision checks also govern authority bytes. */
async function adoptCurrentRecord(
  edge: EdgeContext,
  current: CurrentRead,
  bytes: ArrayBuffer,
): Promise<void> {
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok' || decoded.pack.header.revision <= current.pack.header.revision) {
    return;
  }
  const { scopeId, entryId } = current.pack.header;
  const key = { scopeId, entryId };
  const recordKey = kvGenerationKey(scopeId, entryId);
  const heldAtStart = edge.runtime.memory.generations.get(recordKey);
  const maxAgeMs = copyMaxAgeMs(edge, current.settings);
  const read: Read = {
    key,
    recordKey,
    options: {},
    startedAt: edge.runtime.now(),
    copies: maxAgeMs > 0,
    heldRevision: heldAtStart?.pack.header.revision,
    heldAtStart,
    adopted: { held: undefined },
  };
  const adopted = await adoptDecoded(edge, read, decoded, {
    origin: { kind: 'authority' },
    byteLength: bytes.byteLength,
    wanted: () => current.active,
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
    const { scopeId, entryId, revision } = current.pack.header;
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
 * Ask only behind a record actually served stale. KV can still answer with A after the Function
 * has published B: the authority's current record, verified by the loader, lets later requests
 * use B without making this response wait or lowering the regional cache's TTL.
 *
 * The deadline bounds the whole operation, including validation and keeping the copy. Its fence
 * forbids adoption after the deadline. An RPC cannot be cancelled through this host contract, so
 * its pending slot stays occupied until it settles: a host that never answers cannot accumulate
 * unlimited calls or late buffers. It leaves normal KV refreshes working throughout.
 */
export function readCurrentBehind(
  edge: EdgeContext,
  pack: DecodedGenerationPack,
  settings: RuntimeCacheSettings,
  cadenceMs: number,
): void {
  const currentRecord = edge.host.currentRecord;
  if (currentRecord === undefined || edge.validated || settings.holdMs === 0) {
    return;
  }
  const { scopeId, entryId, revision } = pack.header;
  const recordKey = kvGenerationKey(scopeId, entryId);
  const state = readsOf(edge, cadenceMs);
  if (state.recent.get(recordKey) === revision) {
    return;
  }
  const release = claimBackgroundRecord(edge.runtime, recordKey);
  if (release === undefined) return;
  state.recent.set(recordKey, revision, cadenceMs);
  const current: CurrentRead = { pack, settings, active: true };
  const operation = readCurrent(edge, current, release);
  edge.ctx.waitUntil(boundedRead(operation, current, recordKey));
}
