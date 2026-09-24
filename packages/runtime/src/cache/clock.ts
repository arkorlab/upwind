import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The clock a request acts at. The wall clock, unless a test configuration handed the request
 * one (`x-arkor-test-clock`, honoured only under `ARKOR_TEST_HOOKS`): every cache decision made
 * while the request runs — the timestamp of what it stores, the staleness of what it reads, the
 * clock it tells the host — then follows that clock, so a test can move time without waiting.
 *
 * The wall clock is read through `performance`, not `Date`: with `cacheComponents` Next.js
 * extends `Date` so that a prerender reading the time is dynamic, and the cache is read from
 * inside prerenders. Next.js keeps `performance` for introspection, and so does this.
 */

const clocks = new AsyncLocalStorage<number>();

function wallClockMs(): number {
  return Math.round(performance.timeOrigin + performance.now());
}

export function nowMs(): number {
  return clocks.getStore() ?? wallClockMs();
}

/** The clock the request was given, if any; what the host is told. */
export function requestClock(): number | undefined {
  return clocks.getStore();
}

export function withClock<T>(now: number | undefined, work: () => Promise<T>): Promise<T> {
  return now === undefined ? work() : clocks.run(now, work);
}
