import type { Validity } from '@stayingupwind/core/cache';

import { isRegeneration, type RequestContext, requestContext } from './context.ts';
import { settledWithin } from './pulls.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * How long a request answered with a stale value is kept going for the revalidation Next.js begins
 * behind it (`holdForRevalidation`): the time a request may go on for once it has answered.
 */
const REVALIDATION_LIFETIME_MS = 30_000;
const MS_PER_SECOND = 1000;

/**
 * Whether Next.js revalidates a `use cache` value it was answered, `ageMs` old, behind the render:
 * where a tag made it stale, and where its wrapper finds it past its `revalidate`, which it judges
 * once the value has been answered.
 */
export function revalidatedBehind(validity: Validity, ageMs: number, revalidate: number): boolean {
  return validity === 'stale' || ageMs > revalidate * MS_PER_SECOND;
}

/**
 * Whether Next.js fetches a value it was answered, `ageMs` old, again behind the render: where a tag
 * made it stale, and where `IncrementalCache` finds it older than its `revalidate` once it has been
 * answered — the call's (`fetch`'s or `unstable_cache`'s) where it gives one, as `IncrementalCache`
 * reads it, and the value's own otherwise.
 */
export function fetchedAgainBehind(
  validity: Validity,
  ageMs: number,
  given: number | false | undefined,
  own: number,
): boolean {
  const revalidate = typeof given === 'number' && given !== 0 ? given : own;
  return validity === 'stale' || ageMs / MS_PER_SECOND > revalidate;
}

/**
 * A revalidation of a key that Next.js begins behind a stale answer: the request it runs in — the
 * one answered stale — and what settles it.
 */
interface Revalidation {
  readonly owner: RequestContext;
  readonly done: Promise<unknown>;
  readonly settle: (landed: Promise<unknown>) => void;
  /**
   * Settled once the revalidation is let go of, whatever its write has come to: the requests that
   * joined it go then, where `done` may stay out — it follows the write it was settled with.
   */
  readonly over: Promise<void>;
  readonly end: () => void;
}

/** Each runtime's revalidations still out, by the store and key they are of. */
const revalidations = new WeakMap<CacheRuntime, Map<string, Revalidation>>();

function tableIn(runtime: CacheRuntime): Map<string, Revalidation> {
  const table = revalidations.get(runtime) ?? new Map<string, Revalidation>();
  revalidations.set(runtime, table);
  return table;
}

function idOf(store: string, key: string): string {
  return `${store}\u{0}${key}`;
}

/**
 * Let `made` go once it has settled, or once its lifetime is over, and the requests that joined it
 * with it (`over`): no write can be told to it once it has gone.
 */
async function lapse(table: Map<string, Revalidation>, id: string, made: Revalidation) {
  await settledWithin(made.done, REVALIDATION_LIFETIME_MS);
  made.end();
  if (table.get(id) === made) {
    table.delete(id);
  }
}

/**
 * Keep the request answered with a stale value of `key` going until the revalidation Next.js
 * begins behind that answer, in that request, has set a value of the key again (`revalidated`), or
 * `REVALIDATION_LIFETIME_MS` have gone by.
 *
 * Next.js hands such a revalidation to the request's `waitUntil` only where it began before the
 * render's stream was made: `executeRevalidates`, which `app-render.tsx` calls once as it makes the
 * stream, takes the revalidations pending then. A value read in a part of the page streamed after
 * it — under a `Suspense` boundary — is revalidated by work nothing keeps going, and under workerd
 * a request's timers and I/O end with it. That revalidation never settled, and Next.js, which
 * revalidates a key one at a time in an isolate (`backgroundRevalidations`, in
 * `use-cache-wrapper.ts`), began no other: the key was answered stale for as long as the isolate
 * lived.
 *
 * A revalidation Next.js did not begin, or that failed, sets nothing: the hold lapses, and the next
 * stale answer of the key begins another.
 *
 * A regeneration takes none. It renders what it reads: a stale value misses here, Next.js computes
 * one past its `revalidate` in front of a prerender (`willConsumerServerCache`), and a prerender
 * hands what it revalidated to `waitUntil` once it is whole — where a hold, which its writes are
 * not made behind it to settle, would only keep its invocation going for the lifetime.
 */
export function holdForRevalidation(runtime: CacheRuntime, store: string, key: string): void {
  const context = requestContext();
  if (context === undefined || isRegeneration()) {
    return;
  }
  const table = tableIn(runtime);
  const id = idOf(store, key);
  const out = table.get(id);
  if (out !== undefined) {
    keep(
      runtime,
      context,
      settledWithin(Promise.race([out.done, out.over]), REVALIDATION_LIFETIME_MS),
    );
    return;
  }
  const made = revalidationOf(context);
  table.set(id, made);
  if (!keep(runtime, context, lapse(table, id, made))) {
    // No write reaches a revalidation its request could not be kept going for.
    table.delete(id);
    made.end();
  }
}

function revalidationOf(owner: RequestContext): Revalidation {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const over = Promise.withResolvers<undefined>();
  return {
    owner,
    done: promise,
    settle: resolve,
    over: over.promise,
    end: () => {
      over.resolve(undefined);
    },
  };
}

/**
 * Hand `work` to the request's `waitUntil`; false where that throws, as a host's may once its
 * invocation has ended — which keeps nothing going, and answers the read all the same.
 */
function keep(runtime: CacheRuntime, context: RequestContext, work: Promise<unknown>): boolean {
  try {
    context.waitUntil(work);
    return true;
  } catch (error) {
    runtime.log('revalidation not held', {
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * A value of `key` was set, to land as `landed` settles: where it was set in the request a
 * revalidation of the key is kept going for (`holdForRevalidation`) — Next.js begins the
 * revalidation in the request it answered stale — that request goes on until it has landed.
 * Held until then, too: a stale answer of the key meanwhile is kept going for the same write,
 * rather than for one Next.js will not begin while this revalidation is out.
 *
 * Another request's write of the key settles nothing: a regeneration's, or a render's that had
 * the value computed for it, lands while the revalidation may still be under way, which would
 * then go on held by nothing, as before.
 */
export function revalidated(
  runtime: CacheRuntime,
  store: string,
  key: string,
  landed: Promise<unknown>,
): void {
  const out = revalidations.get(runtime)?.get(idOf(store, key));
  if (out !== undefined && out.owner === requestContext()) {
    out.settle(landed);
  }
}
