import { isDeadlineError } from '@stayingupwind/core/util';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlobLengthError, blobStore } from '../src/scope/io.ts';

const BYTES = new TextEncoder().encode('a stored artifact');

async function storedBody() {
  const key = `read-size/${crypto.randomUUID()}`;
  await env.ARTIFACTS.put(key, BYTES);
  const object = await env.ARTIFACTS.get(key);
  if (object === null) throw new Error('the test blob must exist');
  const get = vi.spyOn(env.ARTIFACTS, 'get').mockResolvedValue(object);
  const head = vi.spyOn(env.ARTIFACTS, 'head');
  const buffered = vi.spyOn(object, 'arrayBuffer');
  const reading = vi.spyOn(object.body, 'getReader');
  return {
    key,
    object,
    get,
    head,
    buffered,
    reading,
    blobs: blobStore(env.ARTIFACTS, () => ({})),
  };
}

/** An object whose body says it holds `size` bytes, and gives what `pull` gives it. */
function objectOf(
  size: number,
  pull: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void> | void,
) {
  const cancelled: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    pull,
    cancel: (reason: unknown) => {
      cancelled.push(reason);
    },
  });
  // As R2's own does, `arrayBuffer` reads the body whole.
  const arrayBuffer = (): Promise<ArrayBuffer> => new Response(body).arrayBuffer();
  return { object: { size, body, arrayBuffer } as unknown as R2ObjectBody, cancelled };
}

describe('projection reads bounded by the generation artifact length', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0, BYTES.byteLength - 1, BYTES.byteLength + 1])(
    'refuses a declaration of %i bytes before buffering the stored body',
    async (byteLength) => {
      const test = await storedBody();
      const cancel = vi.spyOn(test.object.body, 'cancel');

      await expect(test.blobs.read(test.key, byteLength)).rejects.toBeInstanceOf(BlobLengthError);

      expect(test.buffered).not.toHaveBeenCalled();
      expect(test.reading).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(test.get).toHaveBeenCalledTimes(1);
      expect(test.head).not.toHaveBeenCalled();
    },
  );

  it('refuses a wrong size without waiting for cancellation to acknowledge', async () => {
    const test = await storedBody();
    const cancel = vi.spyOn(test.object.body, 'cancel').mockImplementation(() => {
      return new Promise<void>(() => {
        /* Cancellation deliberately never acknowledges. */
      });
    });

    await expect(test.blobs.read(test.key, 1)).rejects.toBeInstanceOf(BlobLengthError);

    expect(test.buffered).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reads a matching object once, with no separate metadata request', async () => {
    const test = await storedBody();

    const bytes = await test.blobs.read(test.key, BYTES.byteLength);

    expect(bytes).toStrictEqual(BYTES);
    expect(test.reading).toHaveBeenCalledTimes(1);
    expect(test.get).toHaveBeenCalledTimes(1);
    expect(test.head).not.toHaveBeenCalled();
  });

  it('gives up on a body that stalls once its time is up, and cancels it (Codex)', async () => {
    const stalled = objectOf(BYTES.byteLength, () => {
      return new Promise<void>(() => {
        /* The body never comes. */
      });
    });
    vi.spyOn(env.ARTIFACTS, 'get').mockResolvedValue(stalled.object);
    const blobs = blobStore(env.ARTIFACTS, () => ({}), { readMs: 20 });

    let failure: unknown;
    try {
      await blobs.read('stalled', BYTES.byteLength);
    } catch (error) {
      failure = error;
    }

    expect(isDeadlineError(failure)).toBe(true);
    expect(stalled.cancelled).toHaveLength(1);
  });

  it('refuses a body that holds more than its object says, without reading past it', async () => {
    let pulls = 0;
    // One byte past its object's size, and then nothing more, ever: a read that took the whole of
    // it would wait for the rest.
    const longer = objectOf(BYTES.byteLength, (controller) => {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array([...BYTES, 0]));
        return Promise.resolve();
      }
      return new Promise<void>(() => {
        /* Nothing more comes. */
      });
    });
    vi.spyOn(env.ARTIFACTS, 'get').mockResolvedValue(longer.object);

    await expect(
      blobStore(env.ARTIFACTS, () => ({})).read('longer', BYTES.byteLength),
    ).rejects.toBeInstanceOf(BlobLengthError);
    expect(longer.cancelled).toHaveLength(1);
    expect(pulls).toBe(1);
  });

  it('keeps missing objects as a miss', async () => {
    const bytes = await blobStore(env.ARTIFACTS, () => ({})).read(
      `missing/${crypto.randomUUID()}`,
      BYTES.byteLength,
    );

    expect(bytes).toBeUndefined();
  });
});
