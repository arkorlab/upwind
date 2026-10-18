import { decodeGenerationPack, deriveEntry, kvGenerationKey } from '@stayingupwind/core/cache';
import {
  completedPathname,
  type ProjectManifest,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { TtlCache, withDeadline } from '@stayingupwind/core/util';
import { runtimeCacheOf } from '@stayingupwind/host/delivery';

import type { EdgeRuntime } from '../edge-runtime.ts';
import { memberEntryKey } from '../memory/caches.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { claimBackgroundRecord } from './background-record-budget.ts';
import {
  adoptDecoded,
  type GenerationKey,
  type GenerationLoad,
  type Read,
} from './generation-loader.ts';

const MAX_RECENT = 1024;
const MAX_KEY_CHARS = 2048;
const READ_MS = 1000;
const MAX_RECORD_MIB = 4;
const KIB = 1024;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;

interface Reads {
  readonly recent: TtlCache<string, true>;
}

const reads = new WeakMap<EdgeRuntime, Reads>();

export interface PartialFallbackRead {
  readonly route: string;
  /** The completed shell's key; parameters which cannot be prerendered stay placeholders. */
  readonly pathname: string;
  readonly key: GenerationKey | undefined;
  readonly load: GenerationLoad;
  readonly refresh: () => void;
}

interface Target {
  readonly scopeId: string;
  readonly route: string;
  readonly pathname: string;
  readonly memoKey: string;
  active: boolean;
}

async function readCurrent(edge: EdgeContext, target: Target): Promise<void> {
  // No derivation or authority work runs on the synchronous shell delivery path.
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  let entryId = edge.runtime.memory.memberEntries.get(target.memoKey);
  if (entryId === undefined) {
    entryId = (
      await deriveEntry(target.scopeId, {
        kind: 'app-page',
        route: target.route,
        pathname: target.pathname,
      })
    ).entryId;
    if (!target.active) return;
    edge.runtime.memory.memberEntries.set(target.memoKey, entryId);
  }
  const key = { scopeId: target.scopeId, entryId };
  const recordKey = kvGenerationKey(key.scopeId, key.entryId);
  const heldAtStart = edge.runtime.memory.generations.get(recordKey);
  // A new target asks from zero. Once held, ask only for a newer revision, avoiding a repeated
  // projection and digest of an unchanged shell. Undefined also covers unavailable projections,
  // so it says nothing new about the generation already verified.
  const bytes = await edge.host.currentRecord?.(
    key.scopeId,
    key.entryId,
    heldAtStart?.pack.header.revision ?? 0,
  );
  if (bytes === undefined || !target.active) return;
  if (bytes.byteLength > MAX_RECORD_BYTES) return;
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (
    decoded.kind !== 'ok' ||
    decoded.pack.header.kind !== 'app-page' ||
    decoded.pack.header.route !== target.route ||
    decoded.pack.header.pathname !== target.pathname
  )
    return;
  const read: Read = {
    key,
    recordKey,
    options: {},
    startedAt: edge.runtime.now(),
    copies: false,
    heldRevision: heldAtStart?.pack.header.revision,
    heldAtStart,
    adopted: { held: undefined },
  };
  await adoptDecoded(edge, read, decoded, {
    origin: { kind: 'authority' },
    byteLength: bytes.byteLength,
    wanted: () => target.active,
  });
}

function refresh(edge: EdgeContext, named: Omit<Target, 'active'>, cadenceMs: number): void {
  let state = reads.get(edge.runtime);
  if (state === undefined) {
    state = { recent: new TtlCache(cadenceMs, MAX_RECENT, edge.runtime.now) };
    reads.set(edge.runtime, state);
  }
  if (state.recent.get(named.memoKey) === true) return;
  const release = claimBackgroundRecord(edge.runtime, named.memoKey);
  if (release === undefined) return;
  state.recent.set(named.memoKey, true, cadenceMs);
  const target: Target = { ...named, active: true };
  const operation = (async () => {
    try {
      await readCurrent(edge, target);
    } finally {
      release();
    }
  })();
  edge.ctx.waitUntil(
    (async () => {
      try {
        await withDeadline(operation, READ_MS, 'partial fallback record read');
      } catch (error) {
        logWarn('partial fallback record refresh failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // A timed-out RPC retains its bounded slot until it settles, but cannot adopt late bytes.
        target.active = false;
      }
    })(),
  );
}

/**
 * The build shell is already available, so never wait on a new completion's key or record. Read
 * the authority only behind delivery and use a verified record on a later request. These entries
 * were not seeded at deployment: KV may cache their absence for 30 seconds, so this path neither
 * reads KV nor keeps a regional copy. Ordinary generation delivery stays on its existing path.
 */
export function partialFallbackInHand(
  edge: EdgeContext,
  manifest: ProjectManifest,
  entry: RouteEntry,
  pathname: string,
): PartialFallbackRead | undefined {
  const upgrade = entry.partialFallback;
  const settings = runtimeCacheOf(edge.policy);
  if (
    upgrade === undefined ||
    manifest.cache === undefined ||
    edge.validated ||
    settings.generations !== 'on' ||
    settings.holdMs === 0 ||
    edge.host.currentRecord === undefined
  )
    return undefined;
  const bare = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const completed =
    upgrade.keyedBy === undefined
      ? bare
      : completedPathname(upgrade.route, upgrade.keyedBy, pathname);
  if (completed === entry.pathname) return undefined;
  const { scopeId } = manifest.cache;
  const memoKey = memberEntryKey(scopeId, upgrade.route, completed);
  if (memoKey.length > MAX_KEY_CHARS) return undefined;
  const entryId = edge.runtime.memory.memberEntries.get(memoKey);
  const key = entryId === undefined ? undefined : { scopeId, entryId };
  const held =
    key === undefined
      ? undefined
      : edge.runtime.memory.generations.get(kvGenerationKey(scopeId, key.entryId));
  return {
    route: upgrade.route,
    pathname: completed,
    key,
    load:
      held === undefined
        ? { kind: 'none', lookupMs: 0 }
        : { kind: 'generation', pack: held.pack, source: 'memory', lookupMs: 0 },
    refresh: () => {
      refresh(
        edge,
        { scopeId, route: upgrade.route, pathname: completed, memoKey },
        held === undefined ? Math.min(settings.holdMs, READ_MS) : settings.holdMs,
      );
    },
  };
}
