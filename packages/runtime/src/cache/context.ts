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
   * What the runtime has to say to its host about this answer, by header name: which answer may be
   * shared, what a regeneration came to. Kept here rather than written on the response as it is
   * decided, because an application writes response headers too and a host must be able to tell
   * the two apart — so the one place every answer passes through takes the platform's prefix off
   * whatever came back and writes these instead (`settleHostHeaders`).
   */
  readonly hostHeaders: Map<string, string>;
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
}): RequestContext {
  const context: RequestContext = {
    tables: input.tables,
    runtime: input.runtime,
    request: input.request,
    startedAt: input.startedAt,
    fetchStarts: new Map(),
    hostHeaders: new Map(),
    waitUntil: input.waitUntil,
    run: (work) => withClock(input.clock, () => withRequestContext(context, work)),
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
