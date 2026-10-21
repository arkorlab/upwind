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
  return { key, object, get, head, buffered, blobs: blobStore(env.ARTIFACTS, () => ({})) };
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
    expect(test.buffered).toHaveBeenCalledTimes(1);
    expect(test.get).toHaveBeenCalledTimes(1);
    expect(test.head).not.toHaveBeenCalled();
  });

  it('keeps missing objects as a miss', async () => {
    const bytes = await blobStore(env.ARTIFACTS, () => ({})).read(
      `missing/${crypto.randomUUID()}`,
      BYTES.byteLength,
    );

    expect(bytes).toBeUndefined();
  });
});
