import { sha256Hex } from '@stayingupwind/core/artifact';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { verifyBlob } from '../src/scope/io.ts';
import { seedLocationKey, verifySeedLocations } from '../src/scope/seed-repair.ts';

const BYTES = encodeUtf8('shared artifact');

async function location() {
  return {
    storageRef: 'build/shared',
    byteLength: BYTES.byteLength,
    sha256: await sha256Hex(BYTES),
  };
}

function body(bytes = BYTES) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('shared seed location verification', () => {
  it('verifies valid bytes and refuses missing or corrupt copies', async () => {
    const target = await location();
    const signal = new AbortController().signal;

    await expect(
      verifyBlob(() => Promise.resolve({ size: BYTES.byteLength, body: body() }), target, signal),
    ).resolves.toBe(true);
    await expect(verifyBlob(() => Promise.resolve(null), target, signal)).resolves.toBe(false);

    const corrupt = new Uint8Array(BYTES.byteLength);

    await expect(
      verifyBlob(
        () => Promise.resolve({ size: corrupt.byteLength, body: body(corrupt) }),
        target,
        signal,
      ),
    ).resolves.toBe(false);
  });

  it('releases a wrong-sized body without waiting for cancellation', async () => {
    const target = await location();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {
          /* Cancellation intentionally never acknowledges. */
        });
      },
    });

    await expect(
      verifyBlob(
        () => Promise.resolve({ size: target.byteLength + 1, body: stream }),
        target,
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
    expect(cancelled).toBe(true);
  });

  it('hashes a 64 MiB side artifact as a stream', async () => {
    const chunkBytes = 65_536;
    let chunks = 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks === 0) controller.close();
        else {
          chunks -= 1;
          controller.enqueue(new Uint8Array(chunkBytes));
        }
      },
    });

    await expect(
      verifyBlob(
        () => Promise.resolve({ size: chunkBytes * 1024, body: stream }),
        {
          storageRef: 'build/large',
          byteLength: chunkBytes * 1024,
          sha256: '3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351',
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(true);
    expect(chunks).toBe(0);
  });

  it('verifies each candidate in order and retains no outstanding reads', async () => {
    const target = await location();
    const proofs = new Map<string, boolean>();
    const keys: string[] = [];
    let active = 0;
    await verifySeedLocations(
      (key) => {
        expect(active).toBe(0);

        active += 1;
        keys.push(key);
        return Promise.resolve({
          size: target.byteLength,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(BYTES);
              controller.close();
              active -= 1;
            },
          }),
        });
      },
      [target, { ...target, storageRef: 'build/other' }],
      proofs,
    );

    expect(keys).toStrictEqual(['build/shared', 'build/other']);
    expect([...proofs.values()]).toStrictEqual([true, true]);
  });

  it('bounds a never-ending stream and stops before another candidate', async () => {
    const target = await location();
    let calls = 0;
    let cancelled = false;
    const proofs = new Map<string, boolean>();

    await expect(
      verifySeedLocations(
        () => {
          calls += 1;
          return Promise.resolve({
            size: target.byteLength,
            body: new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
                return new Promise<void>(() => {
                  /* Cancellation intentionally never acknowledges. */
                });
              },
            }),
          });
        },
        [target, { ...target, storageRef: 'build/not-started' }],
        proofs,
        20,
      ),
    ).rejects.toThrow('timed out');

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(calls).toBe(1);
    expect(cancelled).toBe(true);
    expect(proofs.size).toBe(0);
  });

  it('releases an object that opens after the deadline', async () => {
    const target = await location();
    const pending = Promise.withResolvers<{ size: number; body: ReadableStream<Uint8Array> }>();
    const proofs = new Map<string, boolean>();
    let cancelled = false;
    const checking = verifySeedLocations(() => pending.promise, [target], proofs, 20);

    await expect(checking).rejects.toThrow('timed out');

    pending.resolve({
      size: target.byteLength,
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(cancelled).toBe(true);
    expect(proofs.has(seedLocationKey(target))).toBe(false);
  });

  it('propagates storage and stream failures without recording a proof', async () => {
    const target = await location();
    const proofs = new Map<string, boolean>();

    await expect(
      verifySeedLocations(() => Promise.reject(new Error('storage failed')), [target], proofs),
    ).rejects.toThrow('storage failed');
    await expect(
      verifySeedLocations(
        () => {
          return Promise.resolve({
            size: target.byteLength,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error('stream failed'));
              },
            }),
          });
        },
        [target],
        proofs,
      ),
    ).rejects.toThrow('stream failed');
    expect(proofs.size).toBe(0);
  });
});
