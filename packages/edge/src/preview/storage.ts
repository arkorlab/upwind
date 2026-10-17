import { type LogFields, logWarn } from '../observability/logger.ts';

/**
 * Outcome of a storage read. `missing` is a data fact (nothing stored under the key); `unavailable`
 * is an infrastructure fact (the backend threw) and must never be cached as if it were `missing`.
 */
export type Lookup<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

export const MISSING: Lookup<never> = { kind: 'missing' };
const UNAVAILABLE: Lookup<never> = { kind: 'unavailable' };

/**
 * Hold a KV refresh so a stale isolate hit is not first-byte. Live traffic passes `ctx.waitUntil`;
 * callers that must observe the stored value (validation) omit this and the lookup awaits KV.
 */
export type HoldRefresh = (work: Promise<void>) => void;

/**
 * The reads each request keeps past its answer that are still out (`heldBehind`): a pointer's
 * refresh and what it reads ahead, a policy's, the slower of a manifest's two copies. They hold
 * some of the six requests a Worker may have waiting for headers at once, which the document's own
 * reads ahead of its middleware need (`keptReadsOut`).
 */
const keptReads = new WeakMap<ExecutionContext, { out: number }>();

/** Keep `work` past the request's answer, counted among its reads still out until it ends. */
export function heldBehind(ctx: ExecutionContext): HoldRefresh {
  return (work: Promise<void>): void => {
    const kept = keptReads.get(ctx) ?? { out: 0 };
    keptReads.set(ctx, kept);
    kept.out += 1;
    ctx.waitUntil(
      (async () => {
        try {
          await work;
        } finally {
          kept.out -= 1;
        }
      })(),
    );
  };
}

/** Whether reads the request keeps past its answer are still out (`heldBehind`). */
export function keptReadsOut(ctx: ExecutionContext): boolean {
  return (keptReads.get(ctx)?.out ?? 0) > 0;
}

/**
 * Storage never rejects a request: a backend exception (rate limit, internal error, timeout) is
 * logged and reported as `unavailable` so the caller can degrade instead of answering 500.
 */
export async function lookup<T>(
  what: string,
  fields: LogFields,
  read: () => Promise<T | undefined>,
): Promise<Lookup<T>> {
  try {
    const value = await read();
    return value === undefined ? MISSING : { kind: 'found', value };
  } catch (error) {
    logWarn('storage read failed', {
      what,
      ...fields,
      detail: error instanceof Error ? error.message : String(error),
    });
    return UNAVAILABLE;
  }
}
