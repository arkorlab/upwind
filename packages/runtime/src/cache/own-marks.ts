import type { RequestContext } from './context.ts';

/**
 * The moments a request puts its own invalidations in force at (`invalidate`, in `handlers.ts`), and
 * the moments of what it computes after them: one order for the request, which its clock alone does
 * not give.
 *
 * A host told the moment an invalidation was put in force (`InvalidateRequest.inForceAt`) may record
 * it then rather than once it has the call, and it condemns by it every value made at or before it:
 * an entry made in the same millisecond as an invalidation counts as made before it
 * (`TagState.validityOf`), as a write and the `updateTag` after it with no I/O between them read the
 * same time. A Function's clock moves only when I/O completes, so what the request computes after its
 * own invalidation — a Server Action's page, rendered while the host records what the action
 * invalidated (`invalidateOnce`) — can read that very moment, and would be condemned by the
 * invalidation it was computed after: here, and at the host.
 *
 * So a value whose first read in the request began after one of the request's own invalidations is
 * stamped a millisecond past the latest of them, at the least: after it, as it was made. Its read
 * began once the mark was in force, and the value was computed after its read. A value whose first
 * read began before keeps its own moment: what that read began — in an action, before the change it
 * made — may have been computed before the invalidation, and a later read of the same key can be
 * handed what the earlier one began.
 *
 * And an invalidation the request puts in force later is no earlier than anything it stamped before
 * it (`markIn`): a value read between two of the request's invalidations of one millisecond, stamped
 * past the first, was computed before the change the second was asked for, and the second must reach
 * it. Ties still count as made before, so the second is put in force at the latest of those stamps,
 * which can be a millisecond or more ahead of the clock: such a mark goes to the host only once the
 * clock has passed it (`onceClockPasses`), as a host records no moment later than its own clock.
 *
 * Only the request's own invalidations: what another request computes in the same millisecond as one
 * is ordered against it by nothing this isolate can see.
 */

interface Order {
  /** The latest moment the request put one of its own invalidations in force at. */
  readonly marked: number;
  /** The latest moment it put one in force at, or stamped what it computed after one at. */
  latest: number;
}

const orders = new WeakMap<RequestContext, Order>();

/**
 * The moment `context` puts one of its own invalidations in force at, the clock reading `now`: no
 * earlier than anything the request stamped before it. `now` outside any request.
 */
export function markIn(context: RequestContext | undefined, now: number): number {
  if (context === undefined) {
    return now;
  }
  const at = Math.max(now, orders.get(context)?.latest ?? now);
  orders.set(context, { marked: at, latest: at });
  return at;
}

/**
 * `at`, the moment a read began, as the moment of what the read began: past the latest of the
 * request's own invalidations put in force before it, where there is one.
 */
export function stampedAfterMarks(context: RequestContext | undefined, at: number): number {
  const order = context === undefined ? undefined : orders.get(context);
  if (order === undefined) {
    return at;
  }
  const stamped = Math.max(at, order.marked + 1);
  order.latest = Math.max(order.latest, stamped);
  return stamped;
}

/**
 * `send`, once the clock — reading `now` — has passed `at`, the moment it carries (`markIn`): at
 * once where it already has, as it has but for a request's second invalidation of one millisecond.
 */
export async function onceClockPasses<T>(
  at: number,
  now: number,
  send: () => Promise<T>,
): Promise<T> {
  if (at > now) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, at - now);
    });
  }
  return send();
}

/**
 * Of each `use cache` key a request read, by kind and key, the moment its value is stamped at the
 * least: past the latest of the request's own invalidations put in force before its first read.
 * Next.js stamps the value itself, once it has begun computing it (`use-cache-wrapper.ts`), by a
 * clock that may read the moment of the invalidation it computes after.
 */
const firstReads = new WeakMap<RequestContext, Map<string, number | undefined>>();

function keyOf(kind: string, cacheKey: string): string {
  return `${kind}\u{0}${cacheKey}`;
}

/** A read of `cacheKey`, of the `use cache` handler of `kind`, began in `context`. */
export function useCacheReadBegan(
  context: RequestContext | undefined,
  kind: string,
  cacheKey: string,
): void {
  if (context === undefined) {
    return;
  }
  const reads = firstReads.get(context) ?? new Map<string, number | undefined>();
  firstReads.set(context, reads);
  const key = keyOf(kind, cacheKey);
  if (!reads.has(key)) {
    const order = orders.get(context);
    if (order !== undefined) {
      // Counted among what the request stamped: a later invalidation of its own reaches the value.
      order.latest = Math.max(order.latest, order.marked + 1);
    }
    reads.set(key, order === undefined ? undefined : order.marked + 1);
  }
}

/**
 * The moment a `use cache` value Next.js stamped `timestamp` is kept at: past the request's own
 * invalidations put in force before its key's first read (`useCacheReadBegan`), where there are any.
 */
export function useCacheStamp(
  context: RequestContext | undefined,
  kind: string,
  cacheKey: string,
  timestamp: number,
): number {
  const floor =
    context === undefined ? undefined : firstReads.get(context)?.get(keyOf(kind, cacheKey));
  return floor === undefined ? timestamp : Math.max(timestamp, floor);
}
