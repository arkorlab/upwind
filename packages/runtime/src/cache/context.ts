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
  };
  return context;
}

const contexts = new AsyncLocalStorage<RequestContext>();

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
