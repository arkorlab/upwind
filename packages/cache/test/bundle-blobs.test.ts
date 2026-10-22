import { sha256Hex } from '@stayingupwind/core/artifact';
import { artifactIdFor } from '@stayingupwind/core/cache';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { createBundleBlobReader } from '../src/function/bundle-blobs.ts';
import { Gateway } from '../src/function/gateway.ts';
import { functionReadBudget } from '../src/function/read-budget.ts';

const DIGEST = 'a'.repeat(64);
const LIMIT = 32 * 1024 * 1024;
const BYTES = new TextEncoder().encode('built bytes');

function reader(fetch: (request: Request) => Promise<Response>) {
  return createBundleBlobReader({ env: { ARKOR_PREFETCH: { fetch } } });
}

function nativeBody(source: UnderlyingSource<Uint8Array>): ReadableStream<Uint8Array> {
  Reflect.set(source, 'type', 'bytes');
  return new ReadableStream<Uint8Array>(source);
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A live reservation, so this test's deadline owns only the queued read. */
function occupyRoom(): () => void {
  const release = functionReadBudget().takeAtOnce(LIMIT);
  if (release === undefined) throw new Error('test room was not empty');
  return release;
}

describe('the optional host-fetched bundle blob fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses a declared blob over the read ceiling before asking the service', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(BYTES)));

    await expect(reader(fetch)?.(DIGEST, LIMIT + 1)).rejects.toThrow(/read budget/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([-1, 1])('refuses a native body differing from its known size by %i', async (delta) => {
    const bytes = new Uint8Array(BYTES.byteLength + delta);
    const read = reader(() => Promise.resolve(new Response(bytes)));

    await expect(read?.(DIGEST, BYTES.byteLength)).rejects.toThrow(/length mismatch/u);
  });

  it('uses one native byte read and returns its exact view without arrayBuffer or concatenation', async () => {
    const sample = new Response(BYTES);
    const sampleReader = sample.body!.getReader({ mode: 'byob' });
    const prototype = Object.getPrototypeOf(sampleReader) as ReadableStreamBYOBReader;
    sampleReader.releaseLock();
    const nativeRead = vi.spyOn(prototype, 'readAtLeast');
    const buffered = vi.spyOn(Response.prototype, 'arrayBuffer');
    const read = reader(() => Promise.resolve(new Response(BYTES)));

    const bytes = await read?.(DIGEST, BYTES.byteLength);

    expect(bytes).toStrictEqual(BYTES);
    expect(bytes?.buffer.byteLength).toBe(BYTES.byteLength + 1);
    expect(nativeRead).toHaveBeenCalledTimes(1);
    expect(buffered).not.toHaveBeenCalled();
  });

  it('shares room across reader factories until the first owned consumer has settled', async () => {
    const started = Promise.withResolvers<undefined>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = nativeBody({
      start(given) {
        controller = given;
      },
      pull() {
        started.resolve(undefined);
      },
    });
    const firstFetch = vi.fn(() => Promise.resolve(new Response(body)));
    const secondFetch = vi.fn(() => Promise.resolve(new Response(BYTES)));
    const first = Promise.allSettled([reader(firstFetch)?.(DIGEST, LIMIT)]);
    try {
      await started.promise;
      const second = reader(secondFetch)?.(DIGEST, BYTES.byteLength);
      await nextTurn();

      expect(secondFetch).not.toHaveBeenCalled();

      // EOF proves the first body was short; its error still has to release the room.
      controller?.close();

      await expect(first).resolves.toMatchObject([{ status: 'rejected' }]);
      await expect(second).resolves.toStrictEqual(BYTES);
      expect(secondFetch).toHaveBeenCalledTimes(1);
    } finally {
      controller?.error(new Error('test finished'));
      await first;
    }
  });

  it('holds cache gateway artifact buffering behind the same bundle-blob room', async () => {
    const started = Promise.withResolvers<undefined>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = nativeBody({
      start(given) {
        controller = given;
      },
      pull() {
        started.resolve(undefined);
      },
    });
    const firstRead = reader(() => Promise.resolve(new Response(body)));
    const first = Promise.allSettled([firstRead?.(DIGEST, LIMIT)]);
    const consumed = vi.fn();
    const served = Promise.withResolvers<undefined>();
    const authority = new Gateway({
      scopeId: 'scope_bundle_room',
      gatewayUrl: 'https://cache.example',
      token: 'token',
      naming: { copyCache: crypto.randomUUID(), copyKeyOrigin: 'https://copy.example' },
      fetchImpl: () => {
        served.resolve(undefined);
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(given) {
                  consumed();
                  given.enqueue(BYTES);
                  given.close();
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { 'content-length': String(BYTES.byteLength) } },
          ),
        );
      },
    });
    try {
      await started.promise;
      const artifactId = await artifactIdFor('scope_bundle_room', await sha256Hex(BYTES));
      const artifact = authority.readArtifact(artifactId);
      await served.promise;
      await nextTurn();

      expect(consumed).not.toHaveBeenCalled();

      controller?.close();
      await first;

      await expect(artifact).resolves.toStrictEqual(BYTES);
      expect(consumed).toHaveBeenCalledTimes(1);
    } finally {
      controller?.error(new Error('test finished'));
      await first;
    }
  });

  it.each(['resolved', 'pending', 'rejected'] as const)(
    'cancels the owned native read on deadline without waiting for %s cancel acknowledgement',
    async (acknowledgment) => {
      vi.useFakeTimers();
      const ack = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cancel = vi.fn(() => {
        if (acknowledgment === 'pending') return ack.promise;
        if (acknowledgment === 'rejected') return Promise.reject(new Error('cancel failed'));
        return Promise.resolve();
      });
      const body = nativeBody({
        start(given) {
          controller = given;
        },
        pull() {
          started.resolve(undefined);
        },
        cancel,
      });
      const read = reader(() => Promise.resolve(new Response(body)));
      const result = Promise.allSettled([read?.(DIGEST, BYTES.byteLength)]);
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(result).resolves.toMatchObject([
          { status: 'rejected', reason: { message: 'bundle blob read timed out' } },
        ]);
        expect(cancel).toHaveBeenCalledTimes(1);
        // The pending cancel promise does not hold the reservation after its byte consumer settled.
        await expect(
          reader(() => Promise.resolve(new Response(BYTES)))?.(DIGEST, BYTES.byteLength),
        ).resolves.toStrictEqual(BYTES);
      } finally {
        ack.resolve(undefined);
        controller?.error(new Error('test finished'));
        await result;
      }
    },
  );

  it('includes a saturated room wait in the existing ten-second deadline', async () => {
    vi.useFakeTimers();
    const release = occupyRoom();
    const fetch = vi.fn(() => Promise.resolve(new Response(BYTES)));
    const result = Promise.allSettled([reader(fetch)?.(DIGEST, BYTES.byteLength)]);
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toMatchObject([
        { status: 'rejected', reason: { message: 'bundle blob read timed out' } },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      release();
      await result;
    }
  });

  it('releases an unread body whose headers arrive after the deadline', async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<Response>();
    const cancel = vi.fn();
    const read = reader(() => late.promise);
    const result = Promise.allSettled([read?.(DIGEST, BYTES.byteLength)]);
    await vi.advanceTimersByTimeAsync(10_000);
    late.resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toMatchObject([{ status: 'rejected' }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a digest-only caller, a missing blob and an absent binding compatible', async () => {
    const read = reader((request) => {
      return Promise.resolve(
        request.url.endsWith(DIGEST) ? new Response(BYTES) : new Response(null, { status: 404 }),
      );
    });

    await expect(read?.(DIGEST)).resolves.toStrictEqual(BYTES);
    await expect(read?.('b'.repeat(64), BYTES.byteLength)).resolves.toBeUndefined();
    expect(createBundleBlobReader({ env: undefined })).toBeUndefined();
  });

  it('keeps non-byte adapter streams bounded', async () => {
    const read = reader(() => {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(BYTES);
              controller.close();
            },
          }),
        ),
      );
    });

    await expect(read?.(DIGEST, BYTES.byteLength)).resolves.toStrictEqual(BYTES);
    await expect(read?.(DIGEST, BYTES.byteLength - 1)).rejects.toThrow(/length mismatch/u);
  });
});
