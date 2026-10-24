import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBundleBlobReader } from '../src/function/bundle-blobs.ts';

/**
 * A blob of the deployment's own bundle, read from the Worker that keeps the build's outputs
 * (`packages/cache`). That Worker reads it from R2; one whose answer stops coming after its
 * headers is given up on after 10 s, the body included, rather than holding the Function's answer
 * open until the host ends it (Codex).
 */

const DEADLINE_MS = 10_000;
const SHA256 = 'a'.repeat(64);

/** A read that never comes back. */
function never(): Promise<undefined> {
  return Promise.withResolvers<undefined>().promise;
}

/** A body that never sends a byte, and never ends. */
function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull: never });
}

describe('a bundle blob read', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a blob whose body stops coming, and lets the request go', async () => {
    vi.useFakeTimers();
    const asked: Request[] = [];
    const reader = createBundleBlobReader({
      env: {
        ARKOR_PREFETCH: {
          fetch: (request: Request) => {
            asked.push(request);
            return Promise.resolve(new Response(silentBody()));
          },
        },
      },
    });
    // Settled as it goes, so the rejection is the test's to read rather than an unhandled one.
    const outcome = Promise.allSettled([reader?.(SHA256)]);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);

    expect(asked[0]?.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject([
      { status: 'rejected', reason: { message: 'bundle blob read timed out' } },
    ]);
    expect(asked[0]?.signal.aborted).toBe(true);
  });

  it('reads a blob that arrives in time, and answers one nobody holds with nothing', async () => {
    const bytes = new TextEncoder().encode('0:["tree"]\n');
    const reader = createBundleBlobReader({
      env: {
        ARKOR_PREFETCH: {
          fetch: (request: Request) => {
            const held = request.url.endsWith(SHA256);
            return Promise.resolve(
              held ? new Response(bytes) : new Response(null, { status: 404 }),
            );
          },
        },
      },
    });

    await expect(reader?.(SHA256)).resolves.toStrictEqual(bytes);
    await expect(reader?.('b'.repeat(64))).resolves.toBeUndefined();
  });
});
