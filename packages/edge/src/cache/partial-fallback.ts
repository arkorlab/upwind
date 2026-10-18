import {
  decodeGenerationPack,
  deriveEntry,
  evaluateFreshness,
  kvGenerationKey,
} from '@stayingupwind/core/cache';
import {
  completedPathname,
  type ProjectManifest,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { TtlCache } from '@stayingupwind/core/util';
import { runtimeCacheOf } from '@stayingupwind/host/delivery';

import { type EdgeMemory, memberEntryKey } from '../memory/caches.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { claimBackgroundRecord } from './background-record-budget.ts';
import { isInvalidated } from './condemned.ts';
import {
  adoptDecoded,
  type GenerationKey,
  type GenerationLoad,
  type Read,
} from './generation-loader.ts';

const MAX_RECENT = 1024;
const MAX_KEY_CHARS = 2048;
const READ_MS = 1000;
const MISSING_READ_MS = 2500;
const FIRST_FOLLOW_MS = 250;
const MISSING_DELAYS_MS = [0, FIRST_FOLLOW_MS, READ_MS] as const;
const MAX_RECORD_MIB = 4;
const KIB = 1024;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;

interface RecentRead {
  readonly startedAt: number;
  readonly following: boolean;
}

interface ActiveRead {
  readonly task: Promise<void>;
  readonly promote: () => void;
}

interface Reads {
  readonly recent: TtlCache<string, RecentRead>;
  /** Only reads which own one of the shared background slots can be present. */
  readonly active: Map<string, ActiveRead>;
}

/** The isolate keeps the cadence when a request's runtime wrapper is let go. */
const reads = new WeakMap<EdgeMemory, Reads>();

export interface PartialFallbackRead {
  readonly route: string;
  /** The completed shell's key; parameters which cannot be prerendered stay placeholders. */
  readonly pathname: string;
  readonly key: GenerationKey | undefined;
  readonly load: GenerationLoad;
  readonly refresh: (followMissing?: boolean) => void;
}

interface Target {
  readonly scopeId: string;
  readonly route: string;
  readonly pathname: string;
  readonly memoKey: string;
  active: boolean;
  following: boolean;
}

/** Read again across async boundaries, where the deadline may have changed the target. */
function isActive(target: Target): boolean {
  return target.active;
}

/** An unavailable cold record can be retried; every nonempty result ends the watch. */
async function readCurrent(edge: EdgeContext, target: Target): Promise<boolean> {
  // No derivation or authority work runs on the synchronous shell delivery path.
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  if (!isActive(target)) return false;
  let entryId = edge.runtime.memory.memberEntries.get(target.memoKey);
  if (entryId === undefined) {
    entryId = (
      await deriveEntry(target.scopeId, {
        kind: 'app-page',
        route: target.route,
        pathname: target.pathname,
      })
    ).entryId;
    if (!isActive(target)) return false;
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
  if (!isActive(target)) return false;
  if (bytes === undefined) return true;
  if (bytes.byteLength > MAX_RECORD_BYTES) return false;
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (
    decoded.kind !== 'ok' ||
    decoded.pack.header.kind !== 'app-page' ||
    decoded.pack.header.route !== target.route ||
    decoded.pack.header.pathname !== target.pathname
  )
    return false;
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
  return false;
}

function completionIsHeld(edge: EdgeContext, target: Target): boolean {
  const entryId = edge.runtime.memory.memberEntries.get(target.memoKey);
  return (
    entryId !== undefined &&
    edge.runtime.memory.generations.get(kvGenerationKey(target.scopeId, entryId)) !== undefined
  );
}

async function waitForRetry(delayMs: number, stopped: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, delayMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Keep the claim while sleeping or awaiting an RPC, including one whose caller timed out. */
function activeRead(
  edge: EdgeContext,
  target: Target,
  release: () => void,
  onPromote: () => void,
): ActiveRead {
  const stopped = Promise.withResolvers<never>();
  const expire = () => {
    target.active = false;
    stopped.reject(new Error('partial fallback record read deadline'));
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let reading: ReturnType<typeof setTimeout> | undefined;
  const promote = () => {
    if (target.following || !isActive(target)) return;
    target.following = true;
    // Promotion starts the watch once, without extending an in-flight read's own deadline.
    deadline = setTimeout(expire, MISSING_READ_MS);
    onPromote();
  };
  const operation = (async () => {
    try {
      for (const delayMs of MISSING_DELAYS_MS) {
        if (delayMs !== 0) {
          if (!target.following) return;
          await waitForRetry(delayMs, stopped.promise);
          if (!target.active || completionIsHeld(edge, target)) return;
        }
        reading = setTimeout(expire, READ_MS);
        try {
          if (!(await readCurrent(edge, target))) return;
        } finally {
          clearTimeout(reading);
          reading = undefined;
        }
      }
    } finally {
      target.active = false;
      release();
    }
  })();
  const task = (async () => {
    try {
      await Promise.race([operation, stopped.promise]);
    } finally {
      target.active = false;
      if (deadline !== undefined) clearTimeout(deadline);
      if (reading !== undefined) clearTimeout(reading);
    }
  })();
  return { task, promote };
}

function refresh(
  edge: EdgeContext,
  named: Omit<Target, 'active' | 'following'>,
  cadenceMs: number,
  followMissing: boolean,
): void {
  let state = reads.get(edge.runtime.memory);
  if (state === undefined) {
    state = {
      recent: new TtlCache(cadenceMs, MAX_RECENT, edge.runtime.now),
      active: new Map(),
    };
    reads.set(edge.runtime.memory, state);
  }
  const pending = state.active.get(named.memoKey);
  if (pending !== undefined) {
    if (followMissing) pending.promote();
    return;
  }
  const now = edge.runtime.now();
  const recent = state.recent.get(named.memoKey);
  if (
    recent !== undefined &&
    now - recent.startedAt < cadenceMs &&
    (!followMissing || recent.following)
  )
    return;
  const release = claimBackgroundRecord(edge.runtime, named.memoKey);
  if (release === undefined) return;
  state.recent.set(named.memoKey, { startedAt: now, following: false }, cadenceMs);
  const target: Target = { ...named, active: true, following: false };
  const active = state.active;
  const remembered = state.recent;
  const current = activeRead(
    edge,
    target,
    () => {
      active.delete(named.memoKey);
      release();
    },
    () => {
      remembered.set(named.memoKey, { startedAt: edge.runtime.now(), following: true }, cadenceMs);
    },
  );
  active.set(named.memoKey, current);
  if (followMissing) current.promote();
  edge.ctx.waitUntil(
    (async () => {
      try {
        await current.task;
      } catch (error) {
        logWarn('partial fallback record refresh failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
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
    refresh: (followMissing = false) => {
      const pack = held?.pack;
      const fresh =
        pack !== undefined &&
        !isInvalidated(edge.runtime.memory, pack, edge.app?.deploymentId) &&
        evaluateFreshness({
          policy: pack.header.policy,
          cacheTimestamp: pack.header.cacheTimestamp,
          invalidation: pack.header.invalidation,
          now: edge.runtime.now(),
        }).validity === 'fresh';
      refresh(
        edge,
        { scopeId, route: upgrade.route, pathname: completed, memoKey },
        fresh ? settings.holdMs : Math.min(settings.holdMs, READ_MS),
        followMissing && held === undefined,
      );
    },
  };
}
