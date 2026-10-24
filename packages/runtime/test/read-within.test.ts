import { describe, expect, it } from 'vitest';

import { readWithin } from '../src/cache/body.ts';

describe('readWithin', () => {
  /**
   * A body past the limit is let go, and the reader does not wait to hear that it was: a stream
   * whose source never acknowledges its cancellation would otherwise hold the read for good.
   */
  it('gives up on a body past the limit without waiting for it to acknowledge', async () => {
    const seen = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        seen.cancelled = true;
        return new Promise<void>(() => {
          // Never acknowledged.
        });
      },
    });

    await expect(readWithin(body, 4)).resolves.toBeUndefined();
    expect(seen.cancelled).toBe(true);
  });

  it('keeps a body within the limit whole', async () => {
    const bytes = new TextEncoder().encode('within');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    await expect(readWithin(body, bytes.byteLength)).resolves.toStrictEqual(bytes);
  });
});
