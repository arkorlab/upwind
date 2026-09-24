import { AsyncLocalStorage } from 'node:async_hooks';

import type { EntryTables } from '../entries.ts';
import type { Run } from '../node-bridge.ts';
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
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly run: Run;
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
