import { describe, expect, it } from 'vitest';

import {
  InvalidatedTags,
  type RequestContext,
  RequestWrites,
  withRequestContext,
} from '../src/cache/context.ts';
import type { EntryTables } from '../src/entries.ts';
import { FETCH_CACHE_WRITE, installFetchCacheWrites } from '../src/fetch-cache-writes.ts';

/**
 * The hook Next.js's data cache hands a write to, once the adapter's `fetch-cache-wait-until`
 * patch has rewritten it (`adapter/patches.test.ts` in this package runs that side): the write
 * goes to the `waitUntil` of the request it was made for, and comes back as it went.
 */

type WriteHook = (write: Promise<unknown>) => Promise<unknown>;

function installedHook(): WriteHook {
  installFetchCacheWrites();
  return Reflect.get(globalThis, FETCH_CACHE_WRITE) as WriteHook;
}

/** A request's context with only what the hook reads: its `waitUntil`, which records. */
function requestWith(kept: Promise<unknown>[]): RequestContext {
  return {
    tables: {} as EntryTables,
    runtime: undefined,
    request: new Request('https://app.test/'),
    startedAt: Date.now(),
    publication: new Set<string>(),
    fetchStarts: new Map<string, number>(),
    waitUntil: (promise) => {
      kept.push(promise);
    },
    run: (work) => work(),
    invalidated: new InvalidatedTags(),
    writes: new RequestWrites(),
  };
}

describe('the fetch cache write hook', () => {
  it("hands a write to its request's waitUntil, and hands the same write back", async () => {
    const hook = installedHook();
    const kept: Promise<unknown>[] = [];
    const write = Promise.resolve('written');
    let handedBack: Promise<unknown> | undefined;

    await withRequestContext(requestWith(kept), async () => {
      handedBack = hook(write);
      await handedBack;
    });

    expect(handedBack).toBe(write);
    expect(kept).toStrictEqual([write]);
  });

  it('keeps each write with the request it was made for, however requests overlap', async () => {
    const hook = installedHook();
    const first: Promise<unknown>[] = [];
    const second: Promise<unknown>[] = [];
    const writes = [Promise.resolve(1), Promise.resolve(2)] as const;
    const { promise: overlap, resolve } = Promise.withResolvers<undefined>();

    await Promise.all([
      withRequestContext(requestWith(first), async () => {
        await overlap;
        return hook(writes[0]);
      }),
      withRequestContext(requestWith(second), async () => {
        const handedBack = hook(writes[1]);
        resolve(undefined);
        return handedBack;
      }),
    ]);

    expect(first).toStrictEqual([writes[0]]);
    expect(second).toStrictEqual([writes[1]]);
  });

  it('hands a write made outside any request back, and does nothing else', () => {
    const hook = installedHook();
    const write = Promise.resolve('written');

    expect(hook(write)).toBe(write);
  });
});
