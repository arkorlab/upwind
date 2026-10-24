import { CACHE_OUTCOME_HEADER, REGENERATE_HEADER } from '@stayingupwind/core/paas';
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

function privateResponse(): Promise<Response> {
  return Promise.resolve(
    new Response(PRIVATE_BODY, {
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    }),
  );
}

describe('the first lazy Pages JSON while another Function publishes', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('keeps loading HTML immediate, then adopts a foreign publication for its first JSON', async () => {
    const test = await pagesPublicationFixture();
    const member = await test.member();
    let firstRecord = Promise.withResolvers<undefined>();
    let published = false;
    let reads = 0;

    test.dispatch.mockImplementation((input) => {
      input.onAsked?.(() => 1);
      if (input.headers?.[REGENERATE_HEADER] === 'detached')
        return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(
        new Response(PRIVATE_BODY, {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
            [CACHE_OUTCOME_HEADER]: 'busy',
          },
        }),
      );
    });

    test.currentRecord.mockImplementation(() => {
      reads += 1;
      firstRecord.resolve(undefined);
      return Promise.resolve(published ? member.bytes : undefined);
    });

    vi.useFakeTimers();
    const loading = await test.serve(PAGE);

    expect(loading.headers.get('cache-control')).toBe(PUBLIC);
    await expect(loading.text()).resolves.toContain('hi fallback');

    await test.drain();

    firstRecord = Promise.withResolvers<undefined>();

    test.currentRecord.mockClear();

    reads = 0;
    let returned = false;
    const pending = (async () => {
      const response = await test.serve(DATA);
      returned = true;
      return response;
    })();
    await firstRecord.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(returned).toBe(false);

    published = true;
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;

    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(member.data);
    expect(reads).toBeGreaterThan(1);

    const before = {
      dispatch: test.dispatch.mock.calls.length,
      current: test.currentRecord.mock.calls.length,
    };

    await test.serve(PAGE);

    await test.serve(DATA);

    expect({
      dispatch: test.dispatch.mock.calls.length,
      current: test.currentRecord.mock.calls.length,
    }).toStrictEqual(before);

    await test.drain();
  });

  it('uses one authority read when the first pair is already committed', async () => {
    const test = await pagesPublicationFixture();
    const member = await test.member();

    test.dispatch.mockResolvedValue(
      new Response(PRIVATE_BODY, {
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      }),
    );

    test.currentRecord.mockResolvedValue(member.bytes);

    vi.useFakeTimers();
    const response = await test.serve(DATA);

    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('bounds absent confirmations and preserves the original private body', async () => {
    const test = await pagesPublicationFixture();

    test.dispatch.mockResolvedValue(
      new Response(PRIVATE_BODY, {
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      }),
    );

    vi.useFakeTimers();
    const pending = test.serve(DATA);

    await test.waitForReads(1);

    await vi.advanceTimersByTimeAsync(8000);
    const response = await pending;

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('keeps the original ten-second budget and holds the slot until a late retry settles', async () => {
    const test = await pagesPublicationFixture();
    const member = await test.member();
    const delayed = Promise.withResolvers<ArrayBuffer | undefined>();

    test.dispatch.mockImplementation(privateResponse);

    test.currentRecord.mockResolvedValueOnce(undefined).mockReturnValueOnce(delayed.promise);

    vi.useFakeTimers();
    const pending = test.serve(DATA);

    await test.waitForReads(1);

    await vi.advanceTimersByTimeAsync(10_001);
    const response = await pending;

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe(PRIVATE_BODY);

    const denied = await test.serve(DATA);

    await expect(denied.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(2);

    delayed.resolve(member.bytes);

    await test.drain();

    expect(test.edge.runtime.memory.generations.get(member.key)).toBeUndefined();

    const fresh = await test.member(PAGE, {
      revision: 2,
      seq: 2,
      generationId: 'gen_after_timeout',
    });

    test.currentRecord.mockResolvedValue(fresh.bytes);

    const retry = await test.serve(DATA);

    expect(retry.headers.get('cache-control')).toBe(PUBLIC);
    expect(test.currentRecord).toHaveBeenCalledTimes(3);

    await test.drain();
  });

  it('rejects a first-member answer after its monotonic deadline before the timer fires', async () => {
    const test = await pagesPublicationFixture();
    const member = await test.member();
    const delayed = Promise.withResolvers<ArrayBuffer | undefined>();

    test.dispatch.mockImplementation(privateResponse);

    test.currentRecord.mockReturnValueOnce(delayed.promise);

    vi.useFakeTimers();
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const pending = test.serve(DATA);

    await test.waitForReads(1);

    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);

    monotonic.mockReturnValue(10_001);
    delayed.resolve(member.bytes);

    const response = await pending;

    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.edge.runtime.memory.generations.get(member.key)).toBeUndefined();
    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('retains only two foreground member slots while serial confirmations pause', async () => {
    const test = await pagesPublicationFixture();

    test.dispatch.mockImplementation(privateResponse);

    vi.useFakeTimers();
    const first = test.serve(DATA);
    const second = test.serve(DATA.replace('second', 'third'));

    await test.waitForReads(2);

    await vi.advanceTimersByTimeAsync(0);
    const duplicate = await test.serve(DATA);
    const third = await test.serve(DATA.replace('second', 'fourth'));

    await expect(duplicate.text()).resolves.toBe(PRIVATE_BODY);
    await expect(third.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8000);
    await Promise.all([first, second]);

    expect(test.currentRecord).toHaveBeenCalledTimes(12);

    await test.drain();
  });

  it.each(['corrupt', 'wrong scope', 'old privacy marker', 'expired'] as const)(
    'stops serial confirmation on a present %s record without granting public delivery',
    async (kind) => {
      const test = await pagesPublicationFixture();
      const changes = {
        'wrong scope': { scopeId: 'dpl_other' },
        'old privacy marker': { staticPagePrivacy: 2 as const },
        expired: { cacheTimestamp: 0 },
        corrupt: {},
      }[kind];
      const member = await test.member(PAGE, changes);
      const record = kind === 'corrupt' ? new Uint8Array([1, 2]).buffer : member.bytes;

      test.dispatch.mockResolvedValue(
        new Response(PRIVATE_BODY, {
          headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
        }),
      );

      test.currentRecord.mockResolvedValueOnce(undefined).mockResolvedValue(record);

      vi.useFakeTimers();
      const pending = test.serve(DATA);

      await test.waitForReads(1);

      await vi.advanceTimersByTimeAsync(500);
      const response = await pending;

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.text()).resolves.toBe(PRIVATE_BODY);
      expect(test.currentRecord).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);

      await test.drain();
    },
  );

  it('does not retry an authority error or a private origin cookie', async () => {
    const test = await pagesPublicationFixture();

    test.dispatch.mockImplementation(privateResponse);

    test.currentRecord.mockRejectedValueOnce(new Error('authority unavailable'));

    vi.useFakeTimers();
    const error = await test.serve(DATA);

    await expect(error.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(1);

    test.dispatch.mockResolvedValueOnce(
      new Response(PRIVATE_BODY, {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
          'set-cookie': 'session=visitor',
        },
      }),
    );

    const cookie = await test.serve(DATA);

    expect(cookie.headers.get('set-cookie')).toBe('session=visitor');
    await expect(cookie.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('does not add serial reads to built members or expired replacements', async () => {
    const test = await pagesPublicationFixture();
    const old = await test.member(PAGE, { cacheTimestamp: 0 });

    test.dispatch.mockImplementation(privateResponse);

    vi.useFakeTimers();
    const built = await test.serve(DATA.replace('second', 'first'));

    await expect(built.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(1);

    test.edge.runtime.memory.generations.set(
      old.key,
      { pack: old.pack, readAt: 1_800_000_000_000, bytes: old.bytes.byteLength },
      old.bytes.byteLength,
    );

    const expired = await test.serve(DATA);

    await expect(expired.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await test.drain();
  });

  it('keeps a newer independently held pair when an older confirmation arrives', async () => {
    const test = await pagesPublicationFixture();
    const older = await test.member();
    const newer = await test.member(PAGE, { revision: 2, seq: 2, generationId: 'gen_newer' });

    test.dispatch.mockResolvedValue(
      new Response(PRIVATE_BODY, {
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      }),
    );

    test.currentRecord.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      test.edge.runtime.memory.generations.set(
        newer.key,
        { pack: newer.pack, readAt: 1_800_000_000_000, bytes: newer.bytes.byteLength },
        newer.bytes.byteLength,
      );

      return Promise.resolve(older.bytes);
    });

    vi.useFakeTimers();
    const pending = test.serve(DATA);

    await test.waitForReads(1);

    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;

    expect(response.headers.get('cache-control')).toBe(PUBLIC);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(newer.data);
    expect(test.edge.runtime.memory.generations.get(newer.key)?.pack.header.generationId).toBe(
      'gen_newer',
    );

    await test.drain();
  });

  it('stops the first-member continuation after request cancellation without adopting late proof', async () => {
    const test = await pagesPublicationFixture();
    const member = await test.member();
    const cancel = new AbortController();

    test.dispatch.mockResolvedValue(
      new Response(PRIVATE_BODY, {
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      }),
    );

    test.currentRecord.mockResolvedValueOnce(undefined).mockResolvedValue(member.bytes);

    vi.useFakeTimers();
    const pending = test.serve(DATA, { signal: cancel.signal });

    await test.waitForReads(1);

    await vi.advanceTimersByTimeAsync(0);
    cancel.abort();
    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;

    await expect(response.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).toHaveBeenCalledTimes(1);
    expect(test.edge.runtime.memory.generations.get(member.key)).toBeUndefined();

    await test.drain();
  });

  it('starts no authority read when the first-member request is already cancelled', async () => {
    const test = await pagesPublicationFixture();
    const cancel = new AbortController();
    cancel.abort();

    test.dispatch.mockResolvedValue(
      new Response(PRIVATE_BODY, {
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      }),
    );

    const response = await test.serve(DATA, { signal: cancel.signal });

    await expect(response.text()).resolves.toBe(PRIVATE_BODY);
    expect(test.currentRecord).not.toHaveBeenCalled();

    await test.drain();
  });
});
