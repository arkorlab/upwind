import { requestContext } from './context.ts';
import { settledWithin } from './pulls.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * How long a request answered with a stale value is kept going for the revalidation Next.js begins
 * behind it (`holdForRevalidation`): the time a request may go on for once it has answered.
 */
const REVALIDATION_LIFETIME_MS = 30_000;

/** A revalidation of a key that Next.js begins behind a stale answer, and what settles it. */
interface Revalidation {
  readonly done: Promise<unknown>;
  readonly settle: (landed: Promise<unknown>) => void;
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

/** Let `made` go once it has settled, or once its lifetime is over. */
async function lapse(table: Map<string, Revalidation>, id: string, made: Revalidation) {
  await settledWithin(made.done, REVALIDATION_LIFETIME_MS);
  if (table.get(id) === made) {
    table.delete(id);
  }
}

/**
 * Keep the request answered with a stale value of `key` going until a value of the key is set
 * again — the revalidation Next.js begins behind that answer — or `REVALIDATION_LIFETIME_MS` have
 * gone by.
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
 */
export function holdForRevalidation(runtime: CacheRuntime, store: string, key: string): void {
  const context = requestContext();
  if (context === undefined) {
    return;
  }
  const table = tableIn(runtime);
  const id = idOf(store, key);
  const out = table.get(id);
  if (out !== undefined) {
    context.waitUntil(settledWithin(out.done, REVALIDATION_LIFETIME_MS));
    return;
  }
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const made: Revalidation = { done: promise, settle: resolve };
  table.set(id, made);
  context.waitUntil(lapse(table, id, made));
}

/**
 * A value of `key` was set, to land as `landed` settles: a request kept going for the key's
 * revalidation (`holdForRevalidation`) goes on until it has. Held until then, too: a stale answer
 * of the key meanwhile is kept going for the same write, rather than for one Next.js will not
 * begin while this revalidation is out.
 */
export function revalidated(
  runtime: CacheRuntime,
  store: string,
  key: string,
  landed: Promise<unknown>,
): void {
  revalidations.get(runtime)?.get(idOf(store, key))?.settle(landed);
}
