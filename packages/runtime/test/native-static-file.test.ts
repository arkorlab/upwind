/* eslint-disable security/detect-non-literal-fs-filename -- Every path belongs to a test-created fixture directory. */
import type { ReadStream } from 'node:fs';
import { type FileHandle, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StaticFile } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { staticFileResponse } from '../src/native/static-file.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

const handles = vi.hoisted(() => [] as Promise<FileHandle>[]);
const streams = vi.hoisted(() => [] as ReadStream[]);

vi.mock(import('node:fs/promises'), async (original) => {
  const fs = await original();
  return {
    ...fs,
    open: vi.fn((...args: Parameters<typeof fs.open>) => {
      const opened = fs.open(...args).then((handle) => {
        const create = handle.createReadStream.bind(handle);
        vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          const stream = create(options);
          streams.push(stream);
          return stream;
        });
        return handle;
      });
      handles.push(opened);
      return opened;
    }),
  };
});

const digest = 'a'.repeat(64);
const store = {
  tryReadBlob: () => {
    throw new Error('native static files must stream from disk');
  },
} as unknown as Store;

function input(method: string, signal?: AbortSignal): RoutedInput {
  return {
    request: new Request('https://fixture.test/static.js', {
      method,
      ...(signal !== undefined && { signal }),
    }),
  } as RoutedInput;
}

function file(byteLength: number, immutable = true): StaticFile {
  return {
    pathname: '/static.js',
    blob: { sha256: digest, byteLength, contentType: 'text/javascript' },
    immutable,
  };
}

describe('native static file delivery', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-native-static-'));
    await mkdir(path.join(directory, 'blobs'));
    vi.stubGlobal('__ARKOR_BUNDLE_ROOT__', directory);
    vi.mocked(open).mockClear();
    handles.length = 0;
    streams.length = 0;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('streams a large asset in chunks and closes its descriptor when the reader cancels', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(120);
    await writeFile(path.join(directory, 'blobs', digest), bytes);
    const response = await staticFileResponse(input('GET'), store, file(bytes.byteLength), 200);

    expect(response?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const handle = await handles[0];
    if (handle === undefined) throw new Error('the file was not opened');
    const reader = response?.body?.getReader();
    if (reader === undefined) throw new Error('the response has no streaming body');
    const chunk = await reader.read();

    expect(chunk?.done).toBe(false);
    expect(chunk?.value?.byteLength).toBeGreaterThan(0);
    expect(chunk?.value?.byteLength).toBeLessThan(bytes.byteLength);

    const stream = streams[0];
    if (stream === undefined) throw new Error('the file stream was not created');
    // Cancellation emits AbortError on the Node stream before its final descriptor cleanup.
    const closed = new Promise<void>((resolve) => {
      stream.once('close', resolve);
    });

    await expect(reader.cancel()).resolves.toBeUndefined();

    await closed;

    expect(handle.fd).toBe(-1);
  });

  it('answers HEAD from metadata without opening or reading the body', async () => {
    await writeFile(path.join(directory, 'blobs', digest), 'body');
    const response = await staticFileResponse(input('HEAD'), store, file(4, false), 200);

    expect(response?.body).toBeNull();
    expect(response?.headers.get('content-type')).toBe('text/javascript');
    expect(response?.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(open).not.toHaveBeenCalled();
  });

  it('has no static answer when its build-owned blob is missing', async () => {
    await expect(staticFileResponse(input('GET'), store, file(0), 200)).resolves.toBeUndefined();
    await expect(staticFileResponse(input('HEAD'), store, file(0), 200)).resolves.toBeUndefined();
  });

  it('rejects a file differing from the manifest and closes the failed read', async () => {
    await writeFile(path.join(directory, 'blobs', digest), 'short');

    await expect(staticFileResponse(input('GET'), store, file(20), 200)).rejects.toThrow('differs');

    const handle = await handles[0];

    expect(handle?.fd).toBe(-1);
  });

  it('does not open a file for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('visitor left'));

    await expect(
      staticFileResponse(input('GET', controller.signal), store, file(0), 200),
    ).rejects.toThrow('visitor left');
    expect(open).not.toHaveBeenCalled();
  });
});
