import type { EdgeRuntime } from '../edge-runtime.ts';

/** Leave room for live delivery beside the authority's own projection budget. */
const MAX_PENDING = 2;
const pending = new WeakMap<EdgeRuntime, Set<string>>();

/** A timed-out caller releases only when its RPC actually settles. Fresh delivery never calls. */
export function claimBackgroundRecord(runtime: EdgeRuntime, key: string): (() => void) | undefined {
  let held = pending.get(runtime);
  if (held === undefined) {
    held = new Set();
    pending.set(runtime, held);
  }
  if (held.has(key) || held.size >= MAX_PENDING) return undefined;
  held.add(key);
  return () => {
    held.delete(key);
  };
}
