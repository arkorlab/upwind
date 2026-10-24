import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DATA,
  PAGE,
  PRIVATE_BODY,
  PUBLIC,
  pagesPublicationFixture,
} from './pages-publication-fixture.ts';

vi.mock(import('../src/handlers/passthrough.ts'), async (original) => {
  return {
    ...(await original()),
    handlePassthrough: vi.fn(),
  };
});

const PRIVATE = 'private, no-store';

function privateResponse(): Promise<Response> {
  return Promise.resolve(
    new Response(PRIVATE_BODY, {
      headers: { 'content-type': 'application/json', 'cache-control': PRIVATE },
    }),
  );
}

describe('first lazy Pages confirmation cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    { kind: 'unavailable', lookup: () => Promise.reject(new Error('KV unavailable')) },
    { kind: 'unusable', lookup: () => Promise.resolve(new Uint8Array([1, 2]).buffer) },
  ])('does not retry a lazy JSON after a genuinely $kind KV lookup', async ({ lookup }) => {
    const test = await pagesPublicationFixture();

    test.dispatch.mockImplementation(privateResponse);

    test.kv.mockImplementation(lookup);

    vi.useFakeTimers();
    let hasReturned = false;
    const pending = (async () => {
      const response = await test.serve(DATA);
      hasReturned = true;
      return response;
    })();

    await test.waitForReads(1);

    await vi.advanceTimersByTimeAsync(0);

    expect({
      hasReturned,
      reads: test.currentRecord.mock.calls.length,
      timers: vi.getTimerCount(),
    }).toStrictEqual({ hasReturned: true, reads: 1, timers: 0 });

    const response = await pending;

    expect(response.headers.get('cache-control')).toBe(PRIVATE);
    await expect(response.text()).resolves.toBe(PRIVATE_BODY);

    await test.drain();
  });

  it('clears a four-second pause and releases its foreground slot immediately on abort', async () => {
    const test = await pagesPublicationFixture();
    let fourth = await test.member(PAGE.replace('second', 'fourth'));
    const firstCancel = new AbortController();
    const secondCancel = new AbortController();

    test.dispatch.mockImplementation(privateResponse);

    test.currentRecord.mockImplementation((_scope, entry) =>
      Promise.resolve(entry === fourth.entryId ? fourth.bytes : undefined),
    );

    vi.useFakeTimers();
    let hasReturned = false;
    const first = (async () => {
      const response = await test.serve(DATA, { signal: firstCancel.signal });
      hasReturned = true;
      return response;
    })();
    const second = test.serve(DATA.replace('second', 'third'), { signal: secondCancel.signal });

    await test.waitForReads(2);

    await vi.advanceTimersByTimeAsync(3750);

    expect({
      reads: test.currentRecord.mock.calls.length,
      timers: vi.getTimerCount(),
    }).toStrictEqual({ reads: 10, timers: 4 });

    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    firstCancel.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect({
      hasReturned,
      timers: vi.getTimerCount(),
      reads: test.currentRecord.mock.calls.length,
    }).toStrictEqual({ hasReturned: true, timers: 2, reads: 10 });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    await expect((await first).text()).resolves.toBe(PRIVATE_BODY);

    // Publication happens after the pause; its two-second revalidation age starts here.
    fourth = await test.member(PAGE.replace('second', 'fourth'), {
      revision: 2,
      seq: 2,
      generationId: 'gen_after_abort',
    });
    const next = await test.serve(DATA.replace('second', 'fourth'));

    expect({
      cache: next.headers.get('cache-control'),
      reads: test.currentRecord.mock.calls.length,
    }).toStrictEqual({ cache: PUBLIC, reads: 11 });

    secondCancel.abort();
    await vi.advanceTimersByTimeAsync(0);
    await second;

    await test.drain();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains an aborted in-flight RPC slot until actual settlement and never adopts its late bytes', async () => {
    const test = await pagesPublicationFixture();
    const firstMember = await test.member();
    const fourth = await test.member(PAGE.replace('second', 'fourth'));
    const firstRpc = Promise.withResolvers<ArrayBuffer | undefined>();
    const secondRpc = Promise.withResolvers<ArrayBuffer | undefined>();
    const firstCancel = new AbortController();
    const secondCancel = new AbortController();

    test.dispatch.mockImplementation(privateResponse);

    test.currentRecord
      .mockReturnValueOnce(firstRpc.promise)
      .mockReturnValueOnce(secondRpc.promise)
      .mockResolvedValue(fourth.bytes);

    vi.useFakeTimers();
    let hasReturned = false;
    const first = (async () => {
      const response = await test.serve(DATA, { signal: firstCancel.signal });
      hasReturned = true;
      return response;
    })();
    const second = test.serve(DATA.replace('second', 'third'), { signal: secondCancel.signal });

    await test.waitForReads(2);

    firstCancel.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect({ hasReturned, reads: test.currentRecord.mock.calls.length }).toStrictEqual({
      hasReturned: false,
      reads: 2,
    });

    const denied = await test.serve(DATA.replace('second', 'fourth'));

    expect({
      cache: denied.headers.get('cache-control'),
      reads: test.currentRecord.mock.calls.length,
    }).toStrictEqual({ cache: PRIVATE, reads: 2 });

    firstRpc.resolve(firstMember.bytes);

    await expect((await first).text()).resolves.toBe(PRIVATE_BODY);
    expect(test.edge.runtime.memory.generations.get(firstMember.key)).toBeUndefined();

    const next = await test.serve(DATA.replace('second', 'fourth'));

    expect({
      cache: next.headers.get('cache-control'),
      reads: test.currentRecord.mock.calls.length,
    }).toStrictEqual({ cache: PUBLIC, reads: 3 });

    secondCancel.abort();
    secondRpc.resolve(undefined);
    await second;

    await test.drain();

    expect(vi.getTimerCount()).toBe(0);
  });
});
