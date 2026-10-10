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
   * on its response to the edge, which may hold what carries them (`INVALIDATED_TAGS_HEADER`).
   */
  readonly invalidated: InvalidatedTags;
  /** The cache writes the request handed over behind its response, which its body ends after. */
  readonly writes: RequestWrites;
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
  readonly #out = new Set<Promise<unknown>>();

  /** Let go of `write` once it has settled, whichever way. */
  async #letGo(write: Promise<unknown>): Promise<void> {
    try {
      await write;
    } finally {
      this.#out.delete(write);
    }
  }

  async #drained(): Promise<void> {
    while (this.#out.size > 0) {
      await Promise.allSettled(this.#out);
    }
  }

  /** Whether a write handed over is still out. */
  get pending(): boolean {
    return this.#out.size > 0;
  }

  /** Hold `write` against the end of the response. Whatever it settles as, it is let go then. */
  add(write: Promise<unknown>): void {
    this.#out.add(write);
    void this.#letGo(write).catch(() => {
      // A write that failed is let go as one that landed: its failure is its caller's to report.
    });
  }

  /**
   * Once every write handed over has settled — those handed over while the others were waited for
   * among them — or `ms` have gone by, whichever comes first.
   */
  async landed(ms: number): Promise<void> {
    if (this.#out.size === 0) {
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
 * What a request invalidated at once: the tags, and the latest revision of the scope the host
 * recorded one of them at — below which a record was written before them all. One bound for all of
 * them rather than one each: a request's invalidations are made back to back, so nothing is written
 * between them that a single bound would wrong. No revision once one invalidation came without one:
 * from a host that keeps none, nothing bounds them.
 */
export class InvalidatedTags {
  #revision: number | undefined;
  #bounded = true;
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

const regenerations = new AsyncLocalStorage<true>();

/**
 * Run a render as a regeneration of its entry: the data-cache reads made inside it miss an entry
 * a tag invalidation made stale (`PlatformFetchCache.get`), where any other render is handed it to
 * serve while Next.js fetches it again behind.
 */
export function asRegeneration<T>(work: () => Promise<T>): Promise<T> {
  return regenerations.run(true, work);
}

/** Whether the render reading the cache is a regeneration (`asRegeneration`). */
export function isRegeneration(): boolean {
  return regenerations.getStore() === true;
}
