import type { Validity } from '@stayingupwind/core/cache';
import { isPrimaryResourceRead } from '@stayingupwind/core/paas';
import { withDeadline } from '@stayingupwind/core/util';

import { nowMs } from './clock.ts';
import { isRegeneration, type RequestContext, requestContext } from './context.ts';
import { laterIfAny, type Weighing } from './held-reads.ts';
import type { HeldValue } from './held-writes.ts';
import type { DataReadRequest } from './host.ts';
import { settledWithin } from './pulls.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * How long a request answered with a stale value is kept going for the revalidation Next.js begins
 * behind it (`holdForRevalidation`), from its response's end: the time a request may go on for once
 * it has answered.
 */
const REVALIDATION_LIFETIME_MS = 30_000;
/**
 * The longest a request is held from the stale answer, its response's end reached or not: one whose
 * end is never reached — its reader cancelled it — is let go then, long after the host has.
 */
const REVALIDATION_CAP_MS = 300_000;
const MS_PER_SECOND = 1000;

/**
 * Whether Next.js revalidates a `use cache` value it was answered, `ageMs` old, behind the render:
 * where a tag made it stale, and where its wrapper finds it past its `revalidate`, which it judges
 * once the value has been answered — but not past its `expire`, which the wrapper takes for a miss
 * and computes in front of the render.
 */
export function revalidatedBehind(
  validity: Validity,
  ageMs: number,
  revalidate: number,
  expire: number,
): boolean {
  return (
    ageMs <= expire * MS_PER_SECOND && (validity === 'stale' || ageMs > revalidate * MS_PER_SECOND)
  );
}

/** A candidate's tag validity and lifetime, both weighed before a background read adopts it. */
function agedValidity(
  tagged: Validity,
  ageMs: number,
  revalidate: number,
  expire: number,
): Validity {
  if (tagged === 'expired' || ageMs > expire * MS_PER_SECOND) return 'expired';
  return tagged === 'stale' || ageMs > revalidate * MS_PER_SECOND ? 'stale' : tagged;
}

/**
 * Keep an answer Next.js revalidates behind unchanged, and find what another isolate wrote after
 * a time-stale answer. Regeneration and primary reads retain their existing paths. The later read
 * keeps the same deadlines and revision/write fences as a tag-stale read.
 */
export function holdForUseCacheRevalidation(
  runtime: CacheRuntime,
  request: DataReadRequest & { readonly handler: string },
  read: { readonly held: HeldValue; readonly validity: Validity },
  weighing: Weighing,
): void {
  const refresh =
    read.validity !== 'stale' && !isPrimaryResourceRead() && read.held.revision !== undefined
      ? {
          revision: read.held.revision,
          run: () => {
            return laterIfAny(
              runtime,
              request,
              { held: read.held, validity: 'stale' },
              {
                judge: async (candidate) => {
                  return agedValidity(
                    await weighing.judge(candidate),
                    nowMs() - candidate.entry.timestamp,
                    candidate.entry.revalidate,
                    candidate.entry.expire,
                  );
                },
                reread: weighing.reread,
              },
            );
          },
        }
      : undefined;
  holdForRevalidation(runtime, useCacheStore(request.handler), request.key, refresh);
}

/** The store each `use cache` handler's reads and writes are kept under. */
export function useCacheStore(kind: string): string {
  return `use cache:${kind}`;
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
  refreshing?: Map<number, Promise<unknown>>;
}

/** A time-stale read's optional lookup of a value another isolate already wrote. */
export interface RevalidationRefresh {
  readonly revision: number;
  readonly run: () => Promise<unknown>;
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
  // From the response's end, as the host counts the time it keeps `waitUntil` work going: while the
  // response streams, the request goes on anyway, and a revalidation still under way at its end is
  // given the whole of that time.
  const afterEnd = (async () => {
    await context.writes.ended;
    await settledWithin(hold.done, REVALIDATION_LIFETIME_MS);
  })();
  await settledWithin(Promise.race([hold.done, afterEnd]), REVALIDATION_CAP_MS);
  letGo(table, id, context, hold);
}

/**
 * Keep the request answered with a stale value of `key` going until a revalidation of the key has
 * written it again and the write has landed (`revalidated`), or for `REVALIDATION_LIFETIME_MS` from
 * its response's end.
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
export function holdForRevalidation(
  runtime: CacheRuntime,
  store: string,
  key: string,
  refresh?: RevalidationRefresh,
): void {
  const context = requestContext();
  if (context === undefined || isRegeneration()) {
    return;
  }
  const table = tableIn(runtime);
  const id = idOf(store, key);
  const held: Held = table.get(id) ?? {
    holds: new Map<RequestContext, Hold>(),
    heldBy: new WeakSet(),
  };
  table.set(id, held);
  held.heldBy.add(context);
  if (!held.holds.has(context)) {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const hold: Hold = { done: promise, settle: resolve };
    held.holds.set(context, hold);
    if (!keep(runtime, context, lapse(table, id, context, hold))) {
      // No write reaches a request that could not be kept going; settled, its lapse lets its timers go.
      hold.settle(Promise.resolve());
      letGo(table, id, context, hold);
      return;
    }
  }
  if (refresh !== undefined) refreshBehind(runtime, context, held, refresh);
}

/** Start no lookup before the response ends, nor after an unanswered end signal's lifetime. */
function refreshBehind(
  runtime: CacheRuntime,
  context: RequestContext,
  held: Held,
  refresh: RevalidationRefresh,
): void {
  keep(
    runtime,
    context,
    (async () => {
      try {
        await withDeadline(context.writes.ended, REVALIDATION_CAP_MS, 'the stale response end');
      } catch {
        return;
      }
      await refreshOnce(runtime, held, refresh);
    })(),
  );
}

/** Share only an actual lookup still pending for this key and base revision. */
function refreshOnce(
  runtime: CacheRuntime,
  held: Held,
  refresh: RevalidationRefresh,
): Promise<unknown> {
  const refreshing = held.refreshing ?? new Map<number, Promise<unknown>>();
  held.refreshing = refreshing;
  let work = refreshing.get(refresh.revision);
  if (work === undefined) {
    const pending = Promise.withResolvers<unknown>();
    work = pending.promise;
    refreshing.set(refresh.revision, work);
    pending.resolve(
      (async () => {
        try {
          await refresh.run();
        } catch (error) {
          runtime.log('time-stale cache refresh failed', {
            detail: error instanceof Error ? error.message : String(error),
          });
        } finally {
          refreshing.delete(refresh.revision);
        }
      })(),
    );
  }
  return work;
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
