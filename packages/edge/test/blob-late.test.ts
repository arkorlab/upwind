import { sha256Hex } from '@stayingupwind/core/artifact';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import type { BlobWorker } from '../src/edge-runtime.ts';
import { readManifestCopy, readShippedFile } from '../src/preview/blobs.ts';

const DEADLINE_MS = 2000;
const BYTES = encodeUtf8('the stored bytes');
const FILE_HASH = 'a'.repeat(64);

function waitingWorker() {
  const pending = Promise.withResolvers<Response>();
  const signals: (AbortSignal | null | undefined)[] = [];
  const worker: BlobWorker = (_path, options) => {
    signals.push(options.signal);
    return pending.promise;
  };
  return { pending, signals, worker };
}

function fileResponse(body: BodyInit): Response {
  return new Response(body, { headers: { etag: `"${FILE_HASH}"` } });
}

describe('blob responses arriving after their reader left', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['settled', 'pending', 'rejected'] as const)(
    'releases an unread late manifest with %s cancellation, without a caller signal',
    async (cancellation) => {
      const run = waitingWorker();
      vi.useFakeTimers();
      const answer = readManifestCopy(run.worker, FILE_HASH);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);

      await expect(answer).resolves.toBeUndefined();
      expect(run.signals[0]?.aborted).toBe(true);

      const cancel = vi.fn(() => {
        if (cancellation === 'pending')
          return new Promise<void>(() => {
            /* A reader may never acknowledge cancellation. */
          });
        if (cancellation === 'rejected') return Promise.reject(new Error('cancel failed'));
        return Promise.resolve();
      });
      run.pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
      await vi.advanceTimersByTimeAsync(0);

      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('releases a late file response without a caller signal', async () => {
    const run = waitingWorker();
    vi.useFakeTimers();
    const answer = readShippedFile(
      run.worker,
      { sha256: FILE_HASH, byteLength: BYTES.byteLength },
      undefined,
    );
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    await expect(answer).resolves.toStrictEqual({ kind: 'unanswered' });

    const cancel = vi.fn();
    run.pending.resolve(fileResponse(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(0);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('handles a late rejection after manifest fallback', async () => {
    const run = waitingWorker();
    vi.useFakeTimers();
    const answer = readManifestCopy(run.worker, FILE_HASH);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    await expect(answer).resolves.toBeUndefined();

    run.pending.reject(new Error('reader rejected late'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('keeps a timely manifest with the reader that verifies its bytes', async () => {
    const id = await sha256Hex(BYTES);
    const run = waitingWorker();
    const response = new Response(BYTES);
    const cancel = vi.spyOn(response.body!, 'cancel');
    const answer = readManifestCopy(run.worker, id);
    run.pending.resolve(response);

    expect(new Uint8Array((await answer)!)).toStrictEqual(BYTES);
    expect(cancel).not.toHaveBeenCalled();
    expect(run.signals[0]?.aborted).toBe(false);
  });

  it('keeps a timely file body unread until its caller asks for it', async () => {
    const run = waitingWorker();
    const response = fileResponse(BYTES);
    const cancel = vi.spyOn(response.body!, 'cancel');
    const answer = readShippedFile(
      run.worker,
      { sha256: FILE_HASH, byteLength: BYTES.byteLength },
      undefined,
    );
    run.pending.resolve(response);
    const result = await answer;

    assert(result.kind === 'bytes', 'the file was not answered');

    expect(result.body).toBe(response.body);
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toStrictEqual(BYTES);
    expect(cancel).not.toHaveBeenCalled();
  });
});
