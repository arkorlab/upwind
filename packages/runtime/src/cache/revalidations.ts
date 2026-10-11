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

/** A request answered with a stale value of a key, held for its revalidation, and what settles it. */
interface Hold {
  readonly done: Promise<unknown>;
  readonly settle: (landed: Promise<unknown>) => void;
}

/**
 * The requests held for a key, and every request that has been — whose write is the key's
 * revalidation, held or not by then (`revalidated`).
 */
interface Held {
  readonly holds: Map<RequestContext, Hold>;
  readonly heldBy: WeakSet<RequestContext>;
}

/** Each runtime's requests held, by the store and key they are held for. */
const revalidations = new WeakMap<CacheRuntime, Map<string, Held>>();

function tableIn(runtime: CacheRuntime): Map<string, Held> {
  const table = revalidations.get(runtime) ?? new Map<string, Held>();
  revalidations.set(runtime, table);
  return table;
}

function idOf(store: string, key: string): string {
  return `${store}\u{0}${key}`;
}

/** Let `context`'s hold go — once it has settled, or its lifetime is over (`lapse`). */
function letGo(table: Map<string, Held>, id: string, context: RequestContext, hold: Hold): void {
  const held = table.get(id);
  if (held?.holds.get(context) !== hold) {
    return;
  }
  held.holds.delete(context);
  if (held.holds.size === 0) {
    table.delete(id);
  }
}

async function lapse(
  table: Map<string, Held>,
  id: string,
  context: RequestContext,
  hold: Hold,
): Promise<void> {
  await settledWithin(hold.done, REVALIDATION_LIFETIME_MS);
  letGo(table, id, context, hold);
}

/**
 * Keep the request answered with a stale value of `key` going until a revalidation of the key has
 * written it again and the write has landed (`revalidated`), or for `REVALIDATION_LIFETIME_MS` from
 * that answer.
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
 * Each request counts its own lifetime. Next.js begins a revalidation behind a stale answer where
 * none of the key is out, so the request answered after another may be the one whose revalidation
 * runs — the first one's having failed, say — and a hold that ended with the first request's would
 * leave it held by nothing. A revalidation Next.js did not begin, or that failed, sets nothing: the
 * hold lapses.
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
  const held = table.get(id) ?? { holds: new Map<RequestContext, Hold>(), heldBy: new WeakSet() };
  table.set(id, held);
  held.heldBy.add(context);
  if (held.holds.has(context)) {
    return;
  }
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const hold: Hold = { done: promise, settle: resolve };
  held.holds.set(context, hold);
  if (!keep(runtime, context, lapse(table, id, context, hold))) {
    // No write reaches a request that could not be kept going.
    letGo(table, id, context, hold);
  }
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
 * A value of `key` was set, to land as `landed` settles. Set in a request held for the key — still,
 * or until its own hold lapsed or was let go — it is the revalidation Next.js began behind one of
 * the stale answers, one at a time in an isolate, and every request still held for the key goes on
 * until it has landed.
 *
 * A write of the key in a request held for nothing settles nothing: a regeneration's, or a
 * render's that had the value computed for it, lands while the revalidation the requests are held
 * for may still be under way, which would then go on held by nothing, as before.
 */
export function revalidated(
  runtime: CacheRuntime,
  store: string,
  key: string,
  landed: Promise<unknown>,
): void {
  const held = revalidations.get(runtime)?.get(idOf(store, key));
  const context = requestContext();
  if (held === undefined || context === undefined || !held.heldBy.has(context)) {
    return;
  }
  for (const hold of held.holds.values()) {
    hold.settle(landed);
  }
}
