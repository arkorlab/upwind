/* eslint-disable security/detect-non-literal-fs-filename -- Every path belongs to a test-created fixture directory. */
import type { ReadStream } from 'node:fs';
import { type FileHandle, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StaticFile } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keptAfterRouting, staticFileResponse } from '../src/native/static-file.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

const handles = vi.hoisted(() => [] as Promise<FileHandle>[]);
const streams = vi.hoisted(() => [] as ReadStream[]);

vi.mock(import('node:fs/promises'), async (original) => {
  const fs = await original();
  const observeOpen = async (...args: Parameters<typeof fs.open>): Promise<FileHandle> => {
    const handle = await fs.open(...args);
    const create = handle.createReadStream.bind(handle);
    vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
      const stream = create(options);
      streams.push(stream);
      return stream;
    });
    return handle;
  };
  return {
    ...fs,
    open: vi.fn((...args: Parameters<typeof fs.open>) => {
      const opened = observeOpen(...args);
      handles.push(opened);
      return opened;
    }),
  };
});

function requireResource<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('the response resource was not created');
  return value;
}

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

/** A read of the file, with the headers a client sent and whether a middleware ran for it. */
function asked(headers: HeadersInit, middlewareRan = false, method = 'GET'): RoutedInput {
  return {
    request: new Request('https://fixture.test/static.js', { method, headers }),
    ...(middlewareRan && { middlewareRan: true }),
  } as RoutedInput;
}

const TAG = `"${digest}"`;
const BODY = 'body';

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

    const handle = requireResource(await handles[0]);
    const reader = requireResource(response?.body?.getReader());
    const chunk = await reader.read();

    expect(chunk.done).toBe(false);
    expect(chunk.value?.byteLength).toBeGreaterThan(0);
    expect(chunk.value?.byteLength).toBeLessThan(bytes.byteLength);

    const stream = requireResource(streams[0]);
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

  describe('as the edge answers a file', () => {
    beforeEach(async () => {
      await writeFile(path.join(directory, 'blobs', digest), BODY);
    });

    it('names the file by its hash and length, and takes a range of it', async () => {
      const response = await staticFileResponse(asked({}), store, file(4, false), 200);

      expect(response?.status).toBe(200);
      expect(Object.fromEntries(response?.headers ?? [])).toStrictEqual({
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=0, must-revalidate',
        'content-length': '4',
        'content-type': 'text/javascript',
        etag: TAG,
      });
      await expect(response?.text()).resolves.toBe(BODY);
    });

    it('answers HEAD with the length and tag a read would carry, reading nothing', async () => {
      const response = await staticFileResponse(asked({}, false, 'HEAD'), store, file(4), 200);

      expect(response?.body).toBeNull();
      expect(response?.headers.get('content-length')).toBe('4');
      expect(response?.headers.get('etag')).toBe(TAG);
      expect(open).not.toHaveBeenCalled();
    });

    it.each([TAG, `W/${TAG}`, `"other", ${TAG}`, '*'])(
      'answers 304 to an If-None-Match of %s, reading nothing',
      async (validator) => {
        const response = await staticFileResponse(
          asked({ 'if-none-match': validator }),
          store,
          file(4),
          200,
        );

        expect(response?.status).toBe(304);
        expect(response?.body).toBeNull();
        expect(response?.headers.get('etag')).toBe(TAG);
        expect(response?.headers.has('content-length')).toBe(false);
        expect(response?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(open).not.toHaveBeenCalled();
      },
    );

    it('answers 412 to an If-Match it fails, kept by nobody', async () => {
      const response = await staticFileResponse(
        asked({ 'if-match': '"other"' }),
        store,
        file(4),
        200,
      );

      expect(response?.status).toBe(412);
      expect(response?.body).toBeNull();
      expect(response?.headers.get('cache-control')).toBe('private, no-store');
      expect(response?.headers.has('content-length')).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });

    it('sends the one range asked, and only its bytes', async () => {
      const response = await staticFileResponse(asked({ range: 'bytes=1-2' }), store, file(4), 200);

      expect(response?.status).toBe(206);
      expect(response?.headers.get('content-range')).toBe('bytes 1-2/4');
      expect(response?.headers.get('content-length')).toBe('2');
      await expect(response?.text()).resolves.toBe('od');
    });

    it('refuses a range no byte satisfies with 416, kept by nobody', async () => {
      const response = await staticFileResponse(asked({ range: 'bytes=10-' }), store, file(4), 200);

      expect(response?.status).toBe(416);
      expect(response?.headers.get('content-range')).toBe('bytes */4');
      expect(response?.headers.has('content-length')).toBe(false);
      expect(response?.headers.get('cache-control')).toBe('private, no-store');
    });

    it('sends the whole file where If-Range names another entity, or names it weakly', async () => {
      for (const condition of ['"other"', `W/${TAG}`]) {
        const response = await staticFileResponse(
          asked({ range: 'bytes=1-2', 'if-range': condition }),
          store,
          file(4),
          200,
        );

        expect(response?.status).toBe(200);
        await expect(response?.text()).resolves.toBe(BODY);
      }
    });

    it('varies on what a router sent, where it asked for React Server Components', async () => {
      const response = await staticFileResponse(asked({ rsc: '1' }), store, file(4), 200);

      expect(response?.headers.get('vary')).toBe(
        'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
      );

      await response?.body?.cancel();
    });

    it('is held by the visitor alone where a middleware ran', async () => {
      const response = await staticFileResponse(asked({}, true), store, file(4), 200);

      expect(response?.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');

      await response?.body?.cancel();
    });

    it('judges no validator or range under the status a rewrite named, sending the file whole', async () => {
      const response = await staticFileResponse(
        { ...asked({ 'if-none-match': TAG, range: 'bytes=1-2' }), rewriteStatus: 404 },
        store,
        file(4),
        200,
      );

      expect(response?.status).toBe(404);
      expect(response?.headers.get('accept-ranges')).toBe('none');
      await expect(response?.text()).resolves.toBe(BODY);
    });

    it('names no length under a bodyless status a rewrite named', async () => {
      const response = await staticFileResponse(
        { ...asked({}), rewriteStatus: 205 },
        store,
        file(4),
        200,
      );

      expect(response?.status).toBe(205);
      expect(response?.body).toBeNull();
      expect(response?.headers.has('content-length')).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });

    it('keeps a refusal by nobody once routing has laid a lifetime on it', async () => {
      const refusal = requireResource(
        await staticFileResponse(asked({ 'if-match': '"other"' }), store, file(4), 200),
      );
      // As routing's headers come to it: a rule's own lifetime over the file's.
      const routed = new Response(null, { status: refusal.status, headers: refusal.headers });
      routed.headers.set('cache-control', 'public, max-age=60');

      const kept = keptAfterRouting(routed);

      expect(kept.status).toBe(412);
      expect(kept.headers.get('cache-control')).toBe('private, no-store');
      expect(kept.headers.has('x-arkor-file-refusal')).toBe(false);
    });

    it('leaves an answer it did not refuse as routing left it', async () => {
      const response = requireResource(await staticFileResponse(asked({}), store, file(4), 200));
      response.headers.set('cache-control', 'public, max-age=60');

      expect(keptAfterRouting(response).headers.get('cache-control')).toBe('public, max-age=60');

      await response.body?.cancel();
    });

    it('sends an error document whole under its status, judging no validator or range', async () => {
      const response = await staticFileResponse(
        asked({ 'if-none-match': TAG, range: 'bytes=1-2' }),
        store,
        file(4),
        404,
      );

      expect(response?.status).toBe(404);
      expect(response?.headers.get('accept-ranges')).toBe('none');
      await expect(response?.text()).resolves.toBe(BODY);
    });
  });
});
