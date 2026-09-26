import { requestContext } from './cache/context.ts';

/**
 * Where Next.js's data cache hands the write that follows a `fetch` it cached: to the `waitUntil`
 * of the request the write belongs to, so that the request's work is not ended under it.
 *
 * Next.js starts the write when the fetch's response arrives, which for an entry fetched again
 * behind a response is after the render has handed `waitUntil` what it knew of; the adapter's
 * `fetch-cache-wait-until` patch calls this as the write is registered, and keeps what it hands
 * back in place of what it handed over. With no request in context it hands the write back and
 * does nothing else.
 */

export const FETCH_CACHE_WRITE = Symbol.for('arkor.fetch-cache-write');

function keepWrite<T>(write: Promise<T>): Promise<T> {
  requestContext()?.waitUntil(write);
  return write;
}

/** Put the hook in place, once per isolate, before any of Next.js is evaluated. */
export function installFetchCacheWrites(): void {
  Reflect.set(globalThis, FETCH_CACHE_WRITE, keepWrite);
}
