import {
  type DecodedGenerationPack,
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
import { TtlCache, withDeadline } from '@stayingupwind/core/util';
import { runtimeCacheOf, type RuntimeCacheSettings } from '@stayingupwind/host/delivery';

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
import { lookAtScopeBehind } from './scope-signal.ts';

const MAX_KEY_CHARS = 2048;
const READ_MS = 1000;
const MAX_RECORD_MIB = 4;
const KIB = 1024;
const MAX_RECORD_BYTES = MAX_RECORD_MIB * KIB * KIB;
/**
 * How often a fresh completion is read again where the scope's signals reach the isolate: once a
 * minute, for an invalidation they missed — as long as a data center's copy of them answers before
 * it is asked for again where the host purges it (`ANNOUNCED_FRESH_MS`, `scope-signal.ts`).
 */
const SIGNALLED_FRESH_READ_MS = 60_000;
/** The longest a completion not yet found goes unread while it is asked for. */
const ABSENT_READ_MAX_MS = 30_000;
/** A completion not yet found is read again after a quarter of the time it has been looked for. */
const ABSENT_BACKOFF = 4;
/** How long the isolate remembers since when it has looked for a completion it has not found. */
const ABSENT_KEPT_MS = 2 * ABSENT_READ_MAX_MS;
/**
 * How many completions' reads the isolate times at the most, and in how many bytes: as many as it
 * keeps member entries for (`memberEntries`, `memory/caches.ts`). Each is kept a minute, and a
 * crawler's round of a large class would otherwise push them out and have each read again at once.
 */
const RECENT_MAX_ENTRIES = 10_000;
const RECENT_MAX_MIB = 4;
const RECENT_ENTRY_BYTES = 128;

/** What the isolate holds of a completion: none, a fresh record, or one to be regenerated. */
type Standing = 'none' | 'fresh' | 'stale';

/** What the next read of a completion is timed by: what the isolate holds, or a failed last read. */
type Due = Standing | 'failed';

/** A read's end, for the next one's timing: an absence extended, another answer, or a failure. */
type Outcome = 'absent' | 'answered' | 'failed';

interface Recent {
  /** When the isolate's last read of the completion began. */
  readonly startedAt: number;
  /** Since when the isolate has held none of it, while it still holds none. */
  readonly absentSince: number | undefined;
  /** Whether that read failed: the authority did not answer it, in time or at all. */
  readonly failed: boolean;
}

interface Reads {
  readonly recent: TtlCache<string, Recent>;
}

/** The isolate keeps the cadence when a request's runtime wrapper is let go. */
const reads = new WeakMap<EdgeMemory, Reads>();

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

/**
 * What a read of a completion came to: the authority answered in time with none — nor any record
 * it could serve, unreadable, of another page, or refused as not the entry's or not its digests —
 * or with the completion's record, adopted or not (one invalidated since, awaiting its
 * regeneration); or it did not answer in time, the read ending before it asked or its answer
 * coming past the deadline.
 */
type Answer = 'none' | 'record' | 'unanswered';

/** Read the completion's current record from the authority, and adopt it where it is one to serve. */
async function readCurrent(edge: EdgeContext, target: Target): Promise<Answer> {
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
    if (!target.active) return 'unanswered';
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
  // An answer past the deadline is none to go by: the read is taken for one that failed.
  if (!target.active) return 'unanswered';
  if (bytes === undefined || bytes.byteLength > MAX_RECORD_BYTES) return 'none';
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (
    decoded.kind !== 'ok' ||
    decoded.pack.header.kind !== 'app-page' ||
    decoded.pack.header.route !== target.route ||
    decoded.pack.header.pathname !== target.pathname
  )
    return 'none';
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
  const adoption = await adoptDecoded(edge, read, decoded, {
    origin: { kind: 'authority' },
    byteLength: bytes.byteLength,
    wanted: () => target.active,
  });
  if (adoption.kind !== 'unusable') return 'record';
  // Refused as not the entry's or not its digests, none to serve; or past the deadline (`wanted`).
  return adoption.reason === 'corrupt' ? 'none' : 'unanswered';
}

/** What the isolate holds of a completion as a request asks for it to be read again. */
function standingOf(edge: EdgeContext, pack: DecodedGenerationPack | undefined): Standing {
  if (pack === undefined) return 'none';
  const fresh =
    !isInvalidated(edge.runtime.memory, pack, edge.app?.deploymentId) &&
    evaluateFreshness({
      policy: pack.header.policy,
      cacheTimestamp: pack.header.cacheTimestamp,
      invalidation: pack.header.invalidation,
      now: edge.runtime.now(),
    }).validity === 'fresh';
  return fresh ? 'fresh' : 'stale';
}

/**
 * How long after its last read a completion is read again, by what the isolate holds of it. Before
 * a fresh one goes stale only an invalidation makes it wrong, and the scope's signals bring every
 * isolate those within a moment (`scope-signal.ts`): it is read again for one they missed, once a
 * minute (`SIGNALLED_FRESH_READ_MS`) — or every hold, where the host gives no signals. One stale,
 * expired or invalidated is being regenerated, and is read again a second on, as a record served
 * stale is (`readCurrentBehind`). One not held is read a second on while it is new to the isolate,
 * and then less often the longer it goes unfound: a quarter of that time, and half a minute at the
 * most. A member whose completion is never published is not read for every second it is asked
 * for, and one published late still reaches the isolate within the half-minute. A read that failed
 * is tried again a second on, whatever is held: a fresh completion's check for an invalidation the
 * signals missed is not put off another minute by an authority that did not answer it.
 */
function cadenceOf(
  edge: EdgeContext,
  settings: RuntimeCacheSettings,
  due: Due,
  absentForMs: number,
): number {
  const readMs = Math.min(settings.holdMs, READ_MS);
  if (due === 'stale' || due === 'failed') return readMs;
  if (due === 'fresh') {
    return edge.host.scopeSignals === undefined
      ? settings.holdMs
      : Math.max(settings.holdMs, SIGNALLED_FRESH_READ_MS);
  }
  return Math.min(Math.max(readMs, absentForMs / ABSENT_BACKOFF), ABSENT_READ_MAX_MS);
}

/** Whether the isolate now holds a record of the completion `named`. */
function holds(edge: EdgeContext, named: Omit<Target, 'active'>): boolean {
  const entryId = edge.runtime.memory.memberEntries.get(named.memoKey);
  return (
    entryId !== undefined &&
    edge.runtime.memory.generations.get(kvGenerationKey(named.scopeId, entryId)) !== undefined
  );
}

function refresh(
  edge: EdgeContext,
  named: Omit<Target, 'active'>,
  standing: Standing,
  settings: RuntimeCacheSettings,
): void {
  let state = reads.get(edge.runtime.memory);
  if (state === undefined) {
    state = {
      recent: new TtlCache(ABSENT_KEPT_MS, RECENT_MAX_ENTRIES, edge.runtime.now, {
        maxBytes: RECENT_MAX_MIB * KIB * KIB,
        sizeOf: (_recent, key) => RECENT_ENTRY_BYTES + key.length,
      }),
    };
    reads.set(edge.runtime.memory, state);
  }
  const { recent: recentReads } = state;
  const now = edge.runtime.now();
  const recent = recentReads.get(named.memoKey);
  // Only reads the authority answered with none count toward an absence (`settle`, below).
  const absentSince = standing === 'none' ? recent?.absentSince : undefined;
  const due = recent?.failed === true ? 'failed' : standing;
  const cadenceMs = cadenceOf(edge, settings, due, now - (absentSince ?? now));
  // Kept past the longest cadence — a fresh completion's, which a read begun with none held may
  // find — and long enough that how long one has gone unfound is kept between reads.
  const keptMs = Math.max(ABSENT_KEPT_MS, cadenceOf(edge, settings, 'fresh', 0));
  if (absentSince === undefined && recent?.absentSince !== undefined) {
    // Held, by whichever read brought it: the absence is over, and a completion that goes missing
    // again — let go once invalidated — is new to the isolate, not looked for since before.
    recentReads.set(named.memoKey, { ...recent, absentSince }, keptMs);
  }
  if (recent !== undefined && now - recent.startedAt < cadenceMs) return;
  const release = claimBackgroundRecord(edge.runtime, named.memoKey);
  if (release === undefined) return;
  recentReads.set(named.memoKey, { startedAt: now, absentSince, failed: false }, keptMs);
  const target: Target = { ...named, active: true };
  // What the read came to, for the timing of the next: a completion found ends its absence — one
  // lost again before a request finds it held is not looked for since before, and one found
  // invalidated is awaiting its regeneration — an answer of none extends it from when it began, and
  // a read that failed begins it again and is tried again a second on (`cadenceOf`), so that a
  // passing outage of the authority leaves the reads after it a second apart.
  // Extended from what the timing holds as the read ends, not from what it held as the read began:
  // a request that found the completion held meanwhile has ended that absence.
  const settle = (outcome: Outcome): void => {
    const latest = recentReads.get(named.memoKey);
    if (latest?.startedAt !== now) return;
    const since = outcome === 'absent' ? (latest.absentSince ?? now) : undefined;
    recentReads.set(
      named.memoKey,
      { startedAt: now, absentSince: since, failed: outcome === 'failed' },
      keptMs,
    );
  };
  const operation = (async () => {
    try {
      const answer = await readCurrent(edge, target);
      if (answer === 'unanswered') settle('failed');
      else if (answer === 'none' && standing === 'none' && !holds(edge, named)) settle('absent');
      else settle('answered');
    } catch (error) {
      settle('failed');
      throw error;
    } finally {
      release();
    }
  })();
  edge.ctx.waitUntil(
    (async () => {
      try {
        await withDeadline(operation, READ_MS, 'partial fallback record read');
      } catch (error) {
        // Past its deadline the read has failed, whenever its answer comes.
        settle('failed');
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
 * the authority only behind delivery, no more often than `cadenceOf` says, and use a verified
 * record on a later request. These entries were not seeded at deployment: KV may cache their
 * absence for 30 seconds, so this path neither reads KV nor keeps a regional copy. Ordinary
 * generation delivery stays on its existing path.
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
  lookAtScopeBehind(edge, scopeId);
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
        standingOf(edge, held?.pack),
        settings,
      );
    },
  };
}
