import { normalizeRoutePathname, type RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { TtlCache } from '@stayingupwind/core/util';

import { nowMs } from './cache/clock.ts';
import type { AttemptReason } from './cache/host.ts';
import type { RegenerationOutcome } from './cache/regenerate.ts';
import type { CacheRuntime } from './cache/runtime.ts';

/**
 * How long an isolate answers a request for an entry with no record as the request came, once a
 * static render of the entry at a miss kept nothing — the page is dynamic here: five minutes, the
 * longest the host backs off a regeneration that failed. In that time the entry is not rendered
 * statically again first, which cost every such request a lease, and a render that kept nothing,
 * in front of its own render; nor behind a prefetch of it.
 */
const DYNAMIC_MISS_MS = 300_000;
/** How many entries found dynamic at a miss an isolate keeps at the most. */
const DYNAMIC_MISS_ENTRIES = 1024;

/** The entries each isolate found dynamic here at a miss, lately (`DYNAMIC_MISS_MS`). */
const dynamicMisses = new WeakMap<CacheRuntime, TtlCache<string, true>>();

function missesOf(runtime: CacheRuntime): TtlCache<string, true> {
  let misses = dynamicMisses.get(runtime);
  if (misses === undefined) {
    misses = new TtlCache(DYNAMIC_MISS_MS, DYNAMIC_MISS_ENTRIES, nowMs);
    dynamicMisses.set(runtime, misses);
  }
  return misses;
}

/** An entry as a request names it: a pathname with a trailing slash names the one without. */
function keyOf(descriptor: RouteEntryDescriptor): string {
  return `${descriptor.route}|${normalizeRoutePathname(descriptor.pathname)}`;
}

/** Whether this isolate found the entry dynamic here at a miss lately (`DYNAMIC_MISS_MS`). */
export function foundDynamic(runtime: CacheRuntime, descriptor: RouteEntryDescriptor): boolean {
  return missesOf(runtime).get(keyOf(descriptor)) !== undefined;
}

/** A regeneration's outcome as it comes, one at a miss that kept nothing remembered as dynamic. */
export async function rememberingDynamic(
  runtime: CacheRuntime,
  descriptor: RouteEntryDescriptor,
  reason: AttemptReason,
  regeneration: Promise<RegenerationOutcome>,
): Promise<RegenerationOutcome> {
  const outcome = await regeneration;
  if (reason === 'miss' && outcome.kind === 'skipped') {
    missesOf(runtime).set(keyOf(descriptor), true);
  }
  return outcome;
}
