import type { StaticFile } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { bundleBlobReader } from '../src/bundle-blobs.ts';
import { staticFileResponse } from '../src/documents.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

// A stored file never invokes a Node handler; keep the Workers-only bridge out of this Node suite.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const BYTES = new TextEncoder().encode('built bytes');
const DIGEST = 'a'.repeat(64);

function missingBlob(): Uint8Array | undefined {
  return undefined;
}

function olderReader(sha256: string): Promise<Uint8Array | undefined> {
  return Promise.resolve(sha256 === DIGEST ? BYTES : undefined);
}

describe('a host bundle blob reader', () => {
  it('forwards the bundle reference size to the host reader', async () => {
    const read = vi.fn(() => Promise.resolve(BYTES));
    const blobs = bundleBlobReader(() => read, { env: undefined });

    await expect(blobs?.(DIGEST, BYTES.byteLength)).resolves.toBe(BYTES);
    expect(read).toHaveBeenCalledExactlyOnceWith(DIGEST, BYTES.byteLength);
  });

  it('still accepts an older host factory with a digest-only reader', async () => {
    const blobs = bundleBlobReader(() => olderReader, { env: undefined });

    await expect(blobs?.(DIGEST, BYTES.byteLength)).resolves.toBe(BYTES);
    await expect(blobs?.('b'.repeat(64))).resolves.toBeUndefined();
  });
});

describe.each([
  { where: 'shipped', calls: 0 },
  { where: 'hosted', calls: 1 },
] as const)('a $where static file', ({ where, calls }) => {
  it('passes the known bundle size only when it must ask the host', async () => {
    const blobs = vi.fn(() => Promise.resolve(BYTES));
    const input = {
      request: new Request('https://site.example/file'),
      blobs,
    } as unknown as RoutedInput;
    const store = {
      tryReadBlob: () => (where === 'shipped' ? BYTES : undefined),
    } as unknown as Store;
    const file: StaticFile = {
      pathname: '/file',
      blob: { sha256: DIGEST, byteLength: BYTES.byteLength, contentType: 'text/plain' },
      immutable: false,
    };
    const response = await staticFileResponse(input, store, file, 200);

    await expect(response?.text()).resolves.toBe('built bytes');

    expect(blobs).toHaveBeenCalledTimes(calls);
    expect(blobs.mock.calls).toStrictEqual(
      Array.from({ length: calls }, () => [DIGEST, BYTES.byteLength]),
    );
  });
});

describe('an unavailable host blob', () => {
  it('keeps an unshipped static file missing when the host gives no bytes', async () => {
    const input = {
      request: new Request('https://site.example/file'),
      blobs: () => Promise.resolve(undefined),
    } as unknown as RoutedInput;
    const store = { tryReadBlob: missingBlob } as unknown as Store;
    const file: StaticFile = {
      pathname: '/file',
      blob: { sha256: DIGEST, byteLength: BYTES.byteLength, contentType: 'text/plain' },
      immutable: false,
    };

    await expect(staticFileResponse(input, store, file, 200)).resolves.toBeUndefined();
  });
});
