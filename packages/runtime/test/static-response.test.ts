import type { Prerender, StaticFile } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { staticFileResponse } from '../src/documents.ts';
import { type RoutedInput, staticResponse } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

// The prerender is answered as the build wrote it; nothing here reaches the Node bridge.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

const PING = '/api/ping';

/** What a build writes for a route handler that answered `204` while it was prerendered. */
const noContent: Prerender = {
  id: PING,
  route: PING,
  pathname: PING,
  parentOutputId: PING,
  groupId: 1,
  initialStatus: 204,
  body: { sha256: 'e'.repeat(64), byteLength: 0, contentType: 'application/octet-stream' },
};

describe('staticResponse', () => {
  /** A `Response` refuses a body under such a status, the empty one the build wrote included. */
  it('answers a status no body goes with, with none', async () => {
    const store = { readBlob: () => new Uint8Array() } as unknown as Store;

    const response = staticResponse(store, noContent, 'application/octet-stream', 204);

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });
});

/** A request for the file through a rewrite, with the host's blob reader where there is one. */
function input(method: string, blobs?: (sha256: string) => Promise<Uint8Array | undefined>) {
  const request = new Request('https://fixture.test/docs/_next/static/chunks/a.js', { method });
  return { request, blobs } as unknown as RoutedInput;
}

describe('staticFileResponse', () => {
  /** A file of the build a rewrite may land on, which the Function lists and does not carry. */
  const file: StaticFile = {
    pathname: '/_next/static/chunks/a.js',
    blob: { sha256: 'a'.repeat(64), byteLength: 3, contentType: 'text/javascript; charset=utf-8' },
    immutable: true,
  };
  const store = { tryReadBlob: vi.fn() } as unknown as Store;

  it('answers with the bytes the host keeps, under the caching the file was recorded with', async () => {
    const asked: string[] = [];
    const blobs = (sha256: string) => {
      asked.push(sha256);
      return Promise.resolve(new TextEncoder().encode('abc'));
    };

    const response = await staticFileResponse(input('GET', blobs), store, file, 200);

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe('abc');
    expect(response?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asked).toStrictEqual([file.blob.sha256]);
  });

  it('answers a HEAD with the headers alone, reading nothing', async () => {
    const blobs = vi.fn<(sha256: string) => Promise<Uint8Array | undefined>>();

    const response = await staticFileResponse(input('HEAD', blobs), store, file, 200);

    expect(response?.status).toBe(200);
    expect(response?.body).toBeNull();
    expect(blobs).not.toHaveBeenCalled();
  });

  it('has no answer where neither the Function nor a host has the file', async () => {
    await expect(staticFileResponse(input('GET'), store, file, 200)).resolves.toBeUndefined();
    await expect(staticFileResponse(input('HEAD'), store, file, 200)).resolves.toBeUndefined();
  });
});
