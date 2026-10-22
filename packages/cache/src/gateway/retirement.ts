import { kvScopeKey } from '@stayingupwind/core/cache';

const MARKER_CACHE_TTL_SECONDS = 30;
/**
 * How long this isolate takes a scope's missing marker at its word. A render reads through the
 * gateway several times in a row — its records, its data, the entries it resolves — and each read
 * looks at the marker beside it; held, the burst reads KV once. A change does not wait for it, the
 * authority refusing a retired scope's changes itself, save a data write, which stores its bytes
 * first. A marker written meanwhile is seen at most this much later than KV's own cache would show
 * it.
 */
const ABSENT_HOLD_MS = 5000;
/** Scopes one isolate remembers; the one read longest ago is let go first. */
const MAX_HELD_SCOPES = 1024;

interface Held {
  readonly retired: boolean;
  readonly readAt: number;
}

/**
 * What this isolate last read of each scope's marker: retired for good, or absent as of then.
 *
 * Only what a read found, never a read under way. That read is I/O of the request that started it,
 * which the Workers runtime cancels once that request is over — answered, or given up by its
 * caller — and a call of another request waiting on it would wait as long as its own request was
 * let run. So a call that finds nothing held reads for itself, however many are reading already.
 */
const held = new Map<string, Held>();

function remember(scopeId: string, known: Held): void {
  held.delete(scopeId);
  if (held.size >= MAX_HELD_SCOPES) {
    const oldest = held.keys().next();
    if (oldest.done !== true) {
      held.delete(oldest.value);
    }
  }
  held.set(scopeId, known);
}

/** Started beside the reads that look at it, so retirement never adds a serial regional lookup. */
export async function scopeRetired(kv: KVNamespace, scopeId: string): Promise<boolean> {
  const now = Date.now();
  const known = held.get(scopeId);
  if (known !== undefined && (known.retired || now - known.readAt < ABSENT_HOLD_MS)) {
    return known.retired;
  }
  const marker = await kv.get(kvScopeKey(scopeId), { cacheTtl: MARKER_CACHE_TTL_SECONDS });
  // A retirement is for good, and reads are each request's own, finishing in whatever order they
  // like: one that began before the marker was written and ends after another saw it must not take
  // the retirement back, for this call or for the calls after it.
  if (held.get(scopeId)?.retired === true) {
    return true;
  }
  const retired = marker !== null;
  remember(scopeId, { retired, readAt: now });
  return retired;
}
