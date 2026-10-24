import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequestWrites } from '../src/cache/context.ts';
import { WRITES_LAND_WITHIN_MS, withWritesLanded } from '../src/serve.ts';

// The bridge is Cloudflare's alone, and nothing here renders through it.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

/**
 * The end of a response, held for the cache writes its request handed over behind it: a request
 * made once the response was read whole finds what this one wrote at the host, in whatever isolate
 * it lands. The first byte is not held.
 */

function deferred(): { readonly promise: Promise<unknown>; readonly resolve: () => void } {
  const settled = Promise.withResolvers<unknown>();
  return {
    promise: settled.promise,
    resolve: () => {
      settled.resolve(true);
    },
  };
}

/** Whether `promise` has settled by the time the microtasks queued now have run. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  const state = { settled: false };
  const watch = async (): Promise<void> => {
    try {
      await promise;
    } finally {
      state.settled = true;
    }
  };
  void watch().catch(() => {
    // Settled all the same.
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return state.settled;
}

/** A body that says its length, as a page Next.js rendered whole does. */
function sized(): Response {
  return new Response('hello', { headers: { 'content-length': '5' } });
}

describe('a response ended after its request’s cache writes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the body as it comes, and ends it once the writes have landed', async () => {
    const writes = new RequestWrites();
    const write = deferred();
    writes.add(write.promise);
    const reader = (await withWritesLanded(new Response('hello'), writes)).body!.getReader();

    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe('hello');

    const end = reader.read();

    await expect(settledYet(end)).resolves.toBe(false);

    write.resolve();

    await expect(end).resolves.toStrictEqual({ done: true, value: undefined });
    expect(writes.pending).toBe(false);
  });

  it('waits for a write handed over while it was waiting for the others', async () => {
    const writes = new RequestWrites();
    const first = deferred();
    const second = deferred();
    writes.add(first.promise);
    const landed = writes.landed(WRITES_LAND_WITHIN_MS);
    writes.add(second.promise);
    first.resolve();

    await expect(settledYet(landed)).resolves.toBe(false);

    second.resolve();

    await expect(landed).resolves.toBeUndefined();
  });

  it('ends the body all the same once a write has been out as long as it is waited for', async () => {
    // The bound's timer alone: what the stream and the checks below queue runs as it would.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const writes = new RequestWrites();
    writes.add(Promise.withResolvers<never>().promise);
    const reader = (await withWritesLanded(new Response('hello'), writes)).body!.getReader();
    await reader.read();
    const end = reader.read();

    await vi.advanceTimersByTimeAsync(WRITES_LAND_WITHIN_MS - 1);

    await expect(settledYet(end)).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(end).resolves.toStrictEqual({ done: true, value: undefined });
  });

  it('lets a write that failed go as one that landed', async () => {
    const writes = new RequestWrites();
    writes.add(Promise.reject(new Error('host refused the write')));

    await expect(writes.landed(WRITES_LAND_WITHIN_MS)).resolves.toBeUndefined();
    expect(writes.pending).toBe(false);
  });

  it('ends at once when the request handed nothing over', async () => {
    const held = await withWritesLanded(new Response('hello'), new RequestWrites());

    await expect(held.text()).resolves.toBe('hello');
  });

  /**
   * A page rendered whole says its length, and a reader takes its last byte for its end — and a
   * write can be handed over after the headers, while the body is still being made.
   */
  it('drops the length of every body it holds the end of, writes out or not', async () => {
    const writes = new RequestWrites();

    expect((await withWritesLanded(sized(), writes)).headers.has('content-length')).toBe(false);

    writes.add(deferred().promise);

    expect((await withWritesLanded(sized(), writes)).headers.has('content-length')).toBe(false);
  });

  it('keeps the status and the other headers', async () => {
    const writes = new RequestWrites();
    writes.add(deferred().promise);
    const answered = new Response('gone', { status: 410, headers: { 'x-kept': '1' } });

    const held = await withWritesLanded(answered, writes);

    expect(held.status).toBe(410);
    expect(held.headers.get('x-kept')).toBe('1');
  });

  /** Its end is its headers: a redirect, or a `204`, made after a write. */
  it('holds a response without a body until the writes have landed', async () => {
    const writes = new RequestWrites();
    const write = deferred();
    writes.add(write.promise);
    const empty = new Response(null, { status: 204 });

    const held = withWritesLanded(empty, writes);

    await expect(settledYet(held)).resolves.toBe(false);

    write.resolve();

    await expect(held).resolves.toBe(empty);
  });
});
