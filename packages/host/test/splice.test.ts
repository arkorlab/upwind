import { encodeUtf8 } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSplice, type SpliceOptions } from '../src/splice/splice.ts';
import { identityWire } from '../src/splice/wire.ts';

const SHELL = '<!doctype html><html><body><main>saved</main>';
const SUFFIX = '<p>rendered</p></body></html>';
const RECOVERY = '<script>location.reload()</script>';

/** Observe a deliberately failing response before advancing the timer that makes it fail. */
async function readResult(readable: ReadableStream<Uint8Array>): Promise<unknown> {
  try {
    return await new Response(readable).text();
  } catch (error) {
    return error;
  }
}

function spliceFor(
  upstream: Promise<Response>,
  budget: Pick<SpliceOptions, 'firstByteTimeoutMs' | 'totalTimeoutMs'>,
) {
  const abort = vi.fn();
  const splice = createSplice({
    shell: encodeUtf8(SHELL),
    recoveryHtml: encodeUtf8(RECOVERY),
    upstream,
    now: Date.now,
    abortUpstream: abort,
    ...budget,
  });
  return { ...splice, abort };
}

describe('a response arriving after splice recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { firstByteTimeoutMs: 10, totalTimeoutMs: 1000, cancel: 'settled' },
    { firstByteTimeoutMs: 1000, totalTimeoutMs: 10, cancel: 'settled' },
    { firstByteTimeoutMs: 10, totalTimeoutMs: 1000, cancel: 'pending' },
    { firstByteTimeoutMs: 1000, totalTimeoutMs: 10, cancel: 'pending' },
    { firstByteTimeoutMs: 10, totalTimeoutMs: 1000, cancel: 'rejected' },
    { firstByteTimeoutMs: 1000, totalTimeoutMs: 10, cancel: 'rejected' },
  ] as const)(
    'releases a late body after $firstByteTimeoutMs/$totalTimeoutMs with $cancel cancel',
    async (options) => {
      vi.useFakeTimers();
      const upstream = Promise.withResolvers<Response>();
      const splice = spliceFor(upstream.promise, options);
      const text = new Response(splice.readable).text();
      await vi.advanceTimersByTimeAsync(10);

      await expect(text).resolves.toBe(SHELL + RECOVERY);

      const outcome = await splice.outcome;

      expect(outcome).toMatchObject({
        kind: 'timeout',
        phase: 'head',
        forwarded: 0,
        recovered: true,
      });
      expect(splice.abort).toHaveBeenCalledExactlyOnceWith('continuation timeout');

      const released = vi.fn(() => {
        if (options.cancel === 'pending')
          return new Promise<void>(() => {
            /* An origin may never acknowledge. */
          });
        if (options.cancel === 'rejected')
          return Promise.reject(new Error('origin refused cancel'));
        return Promise.resolve();
      });
      upstream.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: released })));
      await vi.advanceTimersByTimeAsync(0);

      expect(released).toHaveBeenCalledExactlyOnceWith('continuation timeout');
      await expect(splice.outcome).resolves.toStrictEqual(outcome);
    },
  );

  it('leaves a rejected late origin handled after the timeout already answered', async () => {
    vi.useFakeTimers();
    const upstream = Promise.withResolvers<Response>();
    const splice = spliceFor(upstream.promise, { firstByteTimeoutMs: 10, totalTimeoutMs: 1000 });
    const text = new Response(splice.readable).text();
    await vi.advanceTimersByTimeAsync(10);

    await expect(text).resolves.toBe(SHELL + RECOVERY);

    const outcome = await splice.outcome;
    upstream.reject(new Error('origin acknowledged abort late'));
    await vi.advanceTimersByTimeAsync(0);

    await expect(splice.outcome).resolves.toStrictEqual(outcome);
    expect(splice.abort).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'recovery'] as const)(
    'still releases the late body when %s throws',
    async (fault) => {
      vi.useFakeTimers();
      const upstream = Promise.withResolvers<Response>();
      const failure = new Error('a response callback failed');
      const splice = createSplice({
        shell: encodeUtf8(SHELL),
        recoveryHtml: encodeUtf8(RECOVERY),
        upstream: upstream.promise,
        now: Date.now,
        firstByteTimeoutMs: 10,
        totalTimeoutMs: 1000,
        abortUpstream() {
          if (fault === 'abort') throw failure;
        },
        wire:
          fault === 'recovery'
            ? {
                ...identityWire(encodeUtf8(SHELL)),
                frame() {
                  throw failure;
                },
              }
            : undefined,
      });
      const read = readResult(splice.readable);
      await vi.advanceTimersByTimeAsync(10);

      await expect(read).resolves.toBe(fault === 'abort' ? SHELL + RECOVERY : failure);

      const outcome = await splice.outcome;
      const released = vi.fn();
      upstream.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: released })));
      await vi.advanceTimersByTimeAsync(0);

      expect(released).toHaveBeenCalledExactlyOnceWith('continuation timeout');
      await expect(splice.outcome).resolves.toStrictEqual(outcome);
    },
  );

  it('keeps a timely successful body under its reader ownership', async () => {
    vi.useFakeTimers();
    const released = vi.fn();
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeUtf8(SUFFIX));
          controller.close();
        },
        cancel: released,
      }),
      { headers: { 'content-type': 'text/html' } },
    );
    const splice = spliceFor(Promise.resolve(upstream), {
      firstByteTimeoutMs: 10,
      totalTimeoutMs: 1000,
    });
    const text = new Response(splice.readable).text();
    await vi.advanceTimersByTimeAsync(0);

    await expect(text).resolves.toBe(SHELL + SUFFIX);
    await expect(splice.outcome).resolves.toMatchObject({ kind: 'ok' });
    expect(released).not.toHaveBeenCalled();
    expect(splice.abort).not.toHaveBeenCalled();
  });
});
