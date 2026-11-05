import {
  InvalidatedTags,
  type RequestContext,
  RequestWrites,
  withRequestContext,
} from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';

/**
 * A request's context, with what the fetch cache reads of one — when each fetch began
 * (`fetchStarts`) or, for a fetch it never saw read, when the request itself did — and the work it
 * hands `waitUntil` collected in `kept`: the fetch cache hands it each write it starts.
 */
export function requestKeeping(
  runtime: CacheRuntime | undefined,
  kept: Promise<unknown>[],
): RequestContext {
  return {
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime,
    request: new Request('https://fixture.test/'),
    startedAt: Date.now(),
    publication: new Set<string>(),
    fetchStarts: new Map(),
    waitUntil: (promise) => {
      kept.push(promise);
    },
    run: (inner) => inner(),
    invalidated: new InvalidatedTags(),
    writes: new RequestWrites(),
  };
}

/**
 * Run `work` as a request would, and end it as a Function's invocation ends: once what it handed
 * `waitUntil` has settled too. The fetch cache writes only inside one, and a write it starts is
 * finished there rather than in `work`.
 */
export async function inRequest<T>(
  runtime: CacheRuntime | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const kept: Promise<unknown>[] = [];
  const answer = await withRequestContext(requestKeeping(runtime, kept), work);
  await Promise.all(kept);
  return answer;
}
