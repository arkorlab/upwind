import type { EdgeRuntime } from '../edge-runtime.ts';
import type { EdgeMemory } from '../memory/caches.ts';

/** Leave room for live delivery beside the authority's own projection budget. */
const MAX_PENDING = 2;
/** Request runtime wrappers differ, but their isolate memory owns these slots. */
const pending = new WeakMap<EdgeMemory, Set<string>>();

/**
 * A timed-out caller releases only when its RPC actually settles. Ordinary fresh generation
 * delivery never calls. Partial-fallback completion checks share these slots, including the
 * hold-based background checks of a fresh held record for newer generations and invalidations.
 */
export function claimBackgroundRecord(runtime: EdgeRuntime, key: string): (() => void) | undefined {
  let held = pending.get(runtime.memory);
  if (held === undefined) {
    held = new Set();
    pending.set(runtime.memory, held);
  }
  if (held.has(key) || held.size >= MAX_PENDING) return undefined;
  held.add(key);
  return () => {
    held.delete(key);
  };
}
