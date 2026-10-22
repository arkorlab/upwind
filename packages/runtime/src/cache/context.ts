import { AsyncLocalStorage } from 'node:async_hooks';

import type { EntryTables } from '../entries.ts';
import type { Run } from '../node-bridge.ts';
import { withClock } from './clock.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * What a request brought with it, for the hooks Next.js calls with no request in hand (a Pages
 * Router `res.revalidate()`): the application's entrypoints, the cache runtime, the request
 * itself, the execution context's `waitUntil`, and the context every render of the request runs in.
 */

export interface RequestContext {
  readonly tables: EntryTables;
  readonly runtime: CacheRuntime | undefined;
  readonly request: Request;
  /** Timestamp before any asynchronous work, including fetches which skip the read hook. */
  readonly startedAt: number;
  /** Fetch start times stay with their request, including background revalidation work. */
  readonly fetchStarts: Map<string, number>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly run: Run;
  /**
   * The tags the request invalidated at once — `updateTag`, `revalidateTag` with no window — told
   * on its response to the edge, which may hold what carries them (`INVALIDATED_TAGS_HEADER`); and
   * every invalidation it asked the host for, which its response is not answered before
   * (`InvalidatedTags.recorded`).
   */
  readonly invalidated: InvalidatedTags;
  /** The cache writes the request handed over behind its response, which its body ends after. */
  readonly writes: RequestWrites;
}

/**
 * How long a response waits, before it is answered at all, for the host to record an invalidation
 * its request asked for (`InvalidatedTags`), counted from the moment the request asked for it: past
 * this it is answered all the same, and the invalidation goes on in `waitUntil` as it did. A Server
 * Action's page renders while the host records what the action invalidated (`invalidateOnce`), and
 * its response waits for the later of the two — the record no longer than this from when it was asked
 * for, however long the render took.
 */
export const INVALIDATIONS_RECORDED_WITHIN_MS = 2000;

/**
 * `call`, or `ms` from now, whichever comes first: what a response waits on of an invalidation its
 * request asked for (`InvalidatedTags.hold`) — from the moment it was asked for, not from the moment
 * the response is ready to be answered. Its failure is its caller's to report, as any held call's.
 */
async function settledWithin(call: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      call,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Calls a request has out, each let go once it has settled, whichever way: what a moment of its
 * response waits for (`settled`) — each for no longer than its own bound from when it was held, where
 * it was held with one.
 */
class HeldCalls {
  /** The calls held that are still out. */
  readonly #out = new Set<Promise<unknown>>();
  /** What a wait for them waits on: each call, or the end of its own bound where it has one first. */
  readonly #waits = new Set<Promise<unknown>>();

  /** Let go of `held`, out of `from`, once it has settled, whichever way. */
  async #letGo(from: Set<Promise<unknown>>, held: Promise<unknown>): Promise<void> {
    try {
      await held;
    } finally {
      from.delete(held);
    }
  }

  /** Keep `held` in `from` until it settles. Whatever it settles as, it is let go then. */
  #keep(from: Set<Promise<unknown>>, held: Promise<unknown>): void {
    from.add(held);
    void this.#letGo(from, held).catch(() => {
      // A call that failed is let go as one that settled: its failure is its caller's to report.
    });
  }

  /** Once every wait held has ended — those held while the others were waited for among them. */
  async #drained(): Promise<void> {
    while (this.#waits.size > 0) {
      await Promise.allSettled(this.#waits);
    }
  }

  /** Whether a call held is still out. */
  get pending(): boolean {
    return this.#out.size > 0;
  }

  /**
   * Hold `call` until it settles, and have a wait for it (`settled`) wait no longer than `withinMs`
   * from now, where that is given.
   */
  add(call: Promise<unknown>, withinMs?: number): void {
    this.#keep(this.#out, call);
    this.#keep(this.#waits, withinMs === undefined ? call : settledWithin(call, withinMs));
  }

  /**
   * Once every call held has settled, or the bound it was held with has gone by — those held while
   * the others were waited for among them — or `ms` have gone by, whichever comes first.
   */
  async settled(ms: number): Promise<void> {
    if (this.#waits.size === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#drained(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * The cache writes a request handed over behind its response (`keepWrite`, in `handlers.ts`): the
 * response's body does not end before they have landed, for no longer than a bound
 * (`withWritesLanded`, in `serve.ts`). A request made once the response was read whole then finds
 * what this one wrote at the host, in whatever isolate it lands — a write that lands within the
 * bound, that is — where before it could find nothing until the write had gone out behind the
 * response. The first byte waits for none of them: only the last does.
 */
export class RequestWrites {
  readonly #writes = new HeldCalls();
  readonly #ended = Promise.withResolvers<undefined>();

  /** Whether a write handed over is still out. */
  get pending(): boolean {
    return this.#writes.pending;
  }

  /** Hold `write` against the end of the response. Whatever it settles as, it is let go then. */
  add(write: Promise<unknown>): void {
    this.#writes.add(write);
  }

  /**
   * Once every write handed over has settled — those handed over while the others were waited for
   * among them — or `ms` have gone by, whichever comes first.
   */
  async landed(ms: number): Promise<void> {
    try {
      await this.#writes.settled(ms);
    } finally {
      this.#ended.resolve(undefined);
    }
  }

  /**
   * Settled once the response has ended — its last byte reached, and what it waited for there
   * (`landed`) — after which the host keeps the request's `waitUntil` work going for a while
   * longer, and no longer. Never, for a response whose end was not reached: one its reader
   * cancelled.
   */
  get ended(): Promise<undefined> {
    return this.#ended.promise;
  }
}

/**
 * What a request invalidated at once: the tags, and the latest revision of the scope the host
 * recorded one of them at — below which a record was written before them all. One bound for all of
 * them rather than one each: a request's invalidations are made back to back, so nothing is written
 * between them that a single bound would wrong. No revision once one invalidation came without one:
 * from a host that keeps none, nothing bounds them.
 *
 * And every invalidation the request asked the host for (`invalidateOnce`, in `handlers.ts`), held
 * against its response, which is not answered — not its first byte either — before the host has
 * recorded them, for no longer than a bound from when each was asked for
 * (`INVALIDATIONS_RECORDED_WITHIN_MS`, `handleRequest`). Whoever made the request moves on
 * once its headers come, Next.js runs a route handler's revalidations behind them, and a Server
 * Action's page renders while the host records what the action invalidated: a request made then
 * was answered, here or in any other isolate, before the host had recorded the invalidation, and
 * what it fetched meanwhile was written as made before it.
 */
export class InvalidatedTags {
  #revision: number | undefined;
  #bounded = true;
  readonly #calls = new HeldCalls();
  readonly tags = new Set<string>();

  /** Record `tags`, invalidated at once at `revision` where the host gave one. */
  add(tags: readonly string[], revision: number | undefined): void {
    for (const tag of tags) {
      this.tags.add(tag);
    }
    if (revision === undefined) {
      this.#bounded = false;
    } else {
      this.#revision = Math.max(this.#revision ?? revision, revision);
    }
  }

  /** The latest revision they were recorded at, where every one of them came with one. */
  get revision(): number | undefined {
    return this.#bounded ? this.#revision : undefined;
  }

  /**
   * Hold `call`, an invalidation the request asked the host for, against its response: until the
   * host has answered it, or `INVALIDATIONS_RECORDED_WITHIN_MS` from now, the moment it was asked
   * for — whenever the response is ready, and whatever else is held.
   */
  hold(call: Promise<unknown>): void {
    this.#calls.add(call, INVALIDATIONS_RECORDED_WITHIN_MS);
  }

  /** Whether an invalidation the request asked for is still out. */
  get pending(): boolean {
    return this.#calls.pending;
  }

  /**
   * Once the host has answered every invalidation held, or the bound of each from when it was asked
   * for has gone by (`hold`): what is left of it, once the response is ready. One asked for while the
   * others were waited for is waited for too, no longer than `ms` from now.
   */
  recorded(ms: number): Promise<void> {
    return this.#calls.settled(ms);
  }
}

/**
 * The context one request is answered inside: what the runtime knows of the deployment, when the
 * request started, and what it has to say to its host about the answer. `run` is what puts it where
 * the rest of the runtime reads it from, under the clock the request was given.
 */
export function requestContextFor(input: {
  readonly tables: EntryTables;
  readonly runtime: CacheRuntime | undefined;
  readonly request: Request;
  readonly startedAt: number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly clock: number | undefined;
  readonly invalidated?: InvalidatedTags | undefined;
}): RequestContext {
  const context: RequestContext = {
    tables: input.tables,
    runtime: input.runtime,
    request: input.request,
    startedAt: input.startedAt,
    fetchStarts: new Map(),
    waitUntil: input.waitUntil,
    run: (work) => withClock(input.clock, () => withRequestContext(context, work)),
    invalidated: input.invalidated ?? new InvalidatedTags(),
    writes: new RequestWrites(),
  };
  return context;
}

const contexts = new AsyncLocalStorage<RequestContext>();

export interface ResourceChangeReceipt {
  readonly context: RequestContext | undefined;
  readonly tag: string;
}

interface ResourceReceiptCoverage {
  readonly pending: Set<ResourceChangeReceipt>;
  revision: number | undefined;
}

/** Durable receipts cover every observed mutation in this request, even when replies reorder. */
const resourceReceipts = new WeakMap<RequestContext, Map<string, ResourceReceiptCoverage>>();

export function beginResourceChange(tag: string): ResourceChangeReceipt {
  const context = requestContext();
  const change = { context, tag };
  if (context === undefined) return change;
  const receipts = resourceReceipts.get(context) ?? new Map<string, ResourceReceiptCoverage>();
  const coverage = receipts.get(tag) ?? {
    pending: new Set<ResourceChangeReceipt>(),
    revision: undefined,
  };
  coverage.pending.add(change);
  receipts.set(tag, coverage);
  resourceReceipts.set(context, receipts);
  return change;
}

export function recordResourceReceipt(change: ResourceChangeReceipt, revision: number): void {
  if (change.context === undefined) return;
  const coverage = resourceReceipts.get(change.context)?.get(change.tag);
  if (coverage?.pending.delete(change) !== true) return;
  coverage.revision = Math.max(coverage.revision ?? 0, revision);
}

export function hasResourceReceipt(context: RequestContext, tag: string): boolean {
  const coverage = resourceReceipts.get(context)?.get(tag);
  return coverage?.revision !== undefined && coverage.pending.size === 0;
}

export function withRequestContext<T>(context: RequestContext, work: () => Promise<T>): Promise<T> {
  return contexts.run(context, work);
}

export function requestContext(): RequestContext | undefined {
  return contexts.getStore();
}

/**
 * One run of a regeneration's render (`asRegeneration`), each its own: what the writes its render
 * hands over are told apart by from any other render's (`keepWrite`, `heldOut`).
 */
export interface Regeneration {
  readonly kind: 'regeneration';
}

const regenerations = new AsyncLocalStorage<Regeneration>();

/**
 * Run a render as a regeneration of its entry: the data-cache reads made inside it miss an entry
 * a tag invalidation made stale (`PlatformFetchCache.get`), where any other render is handed it to
 * serve while Next.js fetches it again behind.
 */
export function asRegeneration<T>(work: () => Promise<T>): Promise<T> {
  return regenerations.run({ kind: 'regeneration' }, work);
}

/** Whether the render reading the cache is a regeneration (`asRegeneration`). */
export function isRegeneration(): boolean {
  return regenerations.getStore() !== undefined;
}

/** The regeneration whose render is reading or writing the cache, where it is one. */
export function currentRegeneration(): Regeneration | undefined {
  return regenerations.getStore();
}

/** The renders made for a capture (`asCapture`), which keep nothing. */
const captures = new AsyncLocalStorage<true>();

/**
 * Run a render as a capture's (`capture-invoke.ts`), whose outputs are handed to the edge whole and
 * kept by nobody here: what the render would write to the cache — a value it fetched, a `use cache`
 * value, an invalidation — is written nowhere (`handlers.ts`). Its reads are whatever the context
 * it runs in makes them: a capture runs it as a regeneration (`asRegeneration`) as well.
 */
export function asCapture<T>(work: () => Promise<T>): Promise<T> {
  return captures.run(true, work);
}

/** Whether the render writing to the cache is a capture's (`asCapture`), which keeps nothing. */
export function isCapture(): boolean {
  return captures.getStore() === true;
}
