import { z } from 'zod';

import { type CachePolicy, type Deadline, deadlineAfter, UNKNOWN_DEADLINE } from './timing.ts';

/**
 * Whether a generation may still be served, from its lifetime, the invalidations recorded against
 * it and the clock — the one judgement an edge, the runtime and its host all make, so it lives
 * here and is made once.
 *
 * The arithmetic is Next.js's own: past `revalidate` a generation is stale (served, regenerated
 * behind the response); past `expire` it is expired (a fresh render is waited for); an
 * invalidation the host recorded against the generation makes it stale from the moment it was
 * recorded, and expired once the deadline that invalidation set has arrived. A generation whose
 * lifetime is not recorded is `unknown`: served, since nothing says it may not be, and never
 * regenerated on time alone.
 */

export const validitySchema = z.enum(['fresh', 'stale', 'expired', 'unknown']);
export type Validity = z.infer<typeof validitySchema>;

/** What the host recorded against a generation when something it depends on was invalidated. */
export const invalidationStateSchema = z.object({
  /** The invalidation's revision, so a later generation is never condemned by an earlier record. */
  revision: z.number().int().nonnegative(),
  /** From when the generation is stale (unix ms). */
  staleAt: z.number().int().optional(),
  /** From when it may no longer be served at all (unix ms). */
  hardExpireAt: z.number().int().optional(),
});
export type InvalidationState = z.infer<typeof invalidationStateSchema>;

export interface FreshnessInput {
  readonly policy: CachePolicy;
  readonly cacheTimestamp: number | null;
  readonly invalidation?: InvalidationState | undefined;
  /** The clock the judgement is made against (unix ms). */
  readonly now: number;
}

export type FreshnessCause = 'none' | 'time' | 'invalidation' | 'unknown';

export interface Freshness {
  readonly validity: Validity;
  /** The effective deadlines: the earlier of the lifetime's and the invalidation's. */
  readonly revalidateAt: Deadline;
  readonly expireAt: Deadline;
  readonly cause: FreshnessCause;
}

function earliest(a: Deadline, b: Deadline): Deadline {
  if (a.kind === 'at' && b.kind === 'at') {
    return a.unixMs <= b.unixMs ? a : b;
  }
  if (a.kind === 'at') {
    return a;
  }
  if (b.kind === 'at') {
    return b;
  }
  // `never` next to `unknown` is unknown: the unrecorded side may be the earlier one.
  return a.kind === b.kind ? a : UNKNOWN_DEADLINE;
}

/**
 * The moment an invalidation set, as a deadline.
 *
 * Whether it reached this generation at all is the host's judgement and not this one's: the
 * state is written against the generation the invalidation touched, and a render whose inputs were
 * invalidated while it ran publishes already condemned, with a `staleAt` recorded *before* the
 * commit that stamped the generation. Comparing the two here would discard exactly that case, and
 * it would compare two clocks — the timestamp is the runtime Worker's, the deadline the
 * host's.
 */
function deadlineAt(
  at: number | undefined,
): { readonly kind: 'at'; readonly unixMs: number } | undefined {
  return at === undefined ? undefined : { kind: 'at', unixMs: at };
}

export function evaluateFreshness(input: FreshnessInput): Freshness {
  const { policy, cacheTimestamp, invalidation, now } = input;
  const timeRevalidate = deadlineAfter(cacheTimestamp, policy.revalidateAfter);
  const timeExpire = deadlineAfter(cacheTimestamp, policy.expireAfter);
  const staleAt = deadlineAt(invalidation?.staleAt);
  const hardExpireAt = deadlineAt(invalidation?.hardExpireAt);
  const revalidateAt = staleAt === undefined ? timeRevalidate : earliest(timeRevalidate, staleAt);
  const expireAt = hardExpireAt === undefined ? timeExpire : earliest(timeExpire, hardExpireAt);
  if (hardExpireAt !== undefined && now >= hardExpireAt.unixMs) {
    return { validity: 'expired', revalidateAt, expireAt, cause: 'invalidation' };
  }
  if (timeExpire.kind === 'at' && now > timeExpire.unixMs) {
    return { validity: 'expired', revalidateAt, expireAt, cause: 'time' };
  }
  if (staleAt !== undefined) {
    return { validity: 'stale', revalidateAt, expireAt, cause: 'invalidation' };
  }
  if (timeRevalidate.kind === 'at' && now > timeRevalidate.unixMs) {
    return { validity: 'stale', revalidateAt, expireAt, cause: 'time' };
  }
  if (timeRevalidate.kind === 'unknown') {
    return { validity: 'unknown', revalidateAt, expireAt, cause: 'unknown' };
  }
  return { validity: 'fresh', revalidateAt, expireAt, cause: 'none' };
}
