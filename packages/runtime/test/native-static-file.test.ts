/* eslint-disable security/detect-non-literal-fs-filename -- Every path belongs to a test-created fixture directory. */
import type { ReadStream } from 'node:fs';
import { type FileHandle, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Route, StaticFile } from '@stayingupwind/core/bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { afterRouting, staticFileResponse } from '../src/native/static-file.ts';
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

/** A build whose `next.config` header rules are `rules`, ahead of the middleware. */
function storeWith(rules: readonly Route[] = []): Store {
  return {
    manifest: { config: {}, routing: { beforeMiddleware: rules, afterFiles: [], onMatch: [] } },
    tryReadBlob: () => {
      throw new Error('native static files must stream from disk');
    },
  } as unknown as Store;
}

const store = storeWith();
const FILE_PATTERN = String.raw`^/static\.js$`;

/**
 * The answer as routing lays what it collected on it (`withRoutingHeaders`): a cookie one more, any
 * other header over the answer's own.
 */
function routed(answer: Response, laid: readonly (readonly [string, string])[]): Response {
  const headers = new Headers(answer.headers);
  for (const [name, value] of laid) {
    if (name === 'set-cookie') {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  }
  return new Response(answer.body, { status: answer.status, headers });
}

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
      const ask = asked({ 'if-match': '"other"' });
      const refusal = requireResource(await staticFileResponse(ask, store, file(4), 200));

      // A rule's own lifetime over the file's.
      const kept = afterRouting(ask, routed(refusal, [['cache-control', 'public, max-age=60']]));

      expect(kept.status).toBe(412);
      expect(kept.headers.get('cache-control')).toBe('private, no-store');
    });

    it('leaves an answer that is not its own as routing left it', () => {
      const other = new Response('page', { headers: { 'cache-control': 'public, max-age=60' } });

      expect(afterRouting(asked({}), other)).toBe(other);
      expect(other.headers.get('cache-control')).toBe('public, max-age=60');
    });

    it('says the bytes on the wire as the answer has them, whatever a rule laid on them', async () => {
      const ask = asked({});
      const answer = requireResource(await staticFileResponse(ask, store, file(4), 200));

      const laid = afterRouting(
        ask,
        routed(answer, [
          ['etag', '"rule"'],
          ['content-length', '9'],
          ['accept-ranges', 'none'],
          ['content-range', 'bytes 0-1/9'],
        ]),
      );

      expect(laid.headers.get('etag')).toBe(TAG);
      expect(laid.headers.get('content-length')).toBe('4');
      expect(laid.headers.get('accept-ranges')).toBe('bytes');
      expect(laid.headers.has('content-range')).toBe(false);
      await expect(laid.text()).resolves.toBe(BODY);
    });

    it('judges a validator by the tag the middleware set in place of the file’s', async () => {
      const ask: RoutedInput = {
        ...asked({ 'if-none-match': '"mw"' }, true),
        middlewareHeaders: new Headers({ etag: '"mw"' }),
      };

      const response = await staticFileResponse(ask, store, file(4), 200);

      expect(response?.status).toBe(304);
      expect(response?.headers.get('etag')).toBe('"mw"');
      expect(open).not.toHaveBeenCalled();
    });

    it('judges a date by the Last-Modified a rule set, the build keeping none of the file’s', async () => {
      const dated = storeWith([
        {
          sourceRegex: FILE_PATTERN,
          headers: { 'Last-Modified': 'Mon, 26 Oct 2026 00:00:00 GMT' },
        },
      ]);

      const unchanged = await staticFileResponse(
        asked({ 'if-modified-since': 'Mon, 26 Oct 2026 00:00:00 GMT' }),
        dated,
        file(4),
        200,
      );
      const changed = await staticFileResponse(
        asked({ 'if-unmodified-since': 'Sun, 25 Oct 2026 00:00:00 GMT' }),
        dated,
        file(4),
        200,
      );

      expect(unchanged?.status).toBe(304);
      expect(changed?.status).toBe(412);
    });

    it('sends the type a rule gives the file, and neither type nor coding of the middleware’s', async () => {
      const typed = storeWith([
        { sourceRegex: FILE_PATTERN, headers: { 'content-type': 'text/plain' } },
      ]);
      const ask: RoutedInput = {
        ...asked({}, true),
        middlewareHeaders: new Headers({ 'content-type': 'image/png', 'content-encoding': 'gzip' }),
      };
      const answer = requireResource(await staticFileResponse(ask, typed, file(4), 200));

      const laid = afterRouting(
        ask,
        routed(answer, [
          ['content-type', 'image/png'],
          ['content-encoding', 'gzip'],
        ]),
      );

      expect(laid.headers.get('content-type')).toBe('text/plain');
      expect(laid.headers.has('content-encoding')).toBe(false);

      await laid.body?.cancel();
    });

    it('keeps what the middleware wrote of holding the file, where nothing makes it one visitor’s', async () => {
      const ask: RoutedInput = {
        ...asked({}, true),
        middlewareHeaders: new Headers({ 'cache-control': 'public, max-age=5' }),
      };
      const answer = requireResource(await staticFileResponse(ask, store, file(4), 200));

      // A rule laid over it after the middleware: the edge's last word is the middleware's still.
      const laid = afterRouting(ask, routed(answer, [['cache-control', 'public, max-age=60']]));

      expect(laid.headers.get('cache-control')).toBe('public, max-age=5');

      await laid.body?.cancel();
    });

    it('holds the file for the visitor alone where a cookie sits beside the middleware’s word', async () => {
      const ask: RoutedInput = {
        ...asked({}, true),
        middlewareHeaders: new Headers({
          'cache-control': 'public, max-age=5',
          'set-cookie': 'a=1',
        }),
      };
      const answer = requireResource(await staticFileResponse(ask, store, file(4), 200));

      const laid = afterRouting(
        ask,
        routed(answer, [
          ['cache-control', 'public, max-age=5'],
          ['set-cookie', 'a=1'],
          ['cdn-cache-control', 'max-age=99'],
        ]),
      );

      expect(laid.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      expect(laid.headers.has('cdn-cache-control')).toBe(false);
      expect(laid.headers.get('set-cookie')).toBe('a=1');

      await laid.body?.cancel();
    });

    it('holds the file for the visitor alone where a rule the request selected applied', async () => {
      const conditioned = storeWith([
        {
          sourceRegex: FILE_PATTERN,
          has: [{ type: 'header', key: 'x-variant' }],
          headers: { 'cdn-cache-control': 'max-age=99', 'x-variant-seen': '1' },
        },
      ]);
      const ask = asked({ 'x-variant': 'b' });
      const answer = requireResource(await staticFileResponse(ask, conditioned, file(4), 200));

      const laid = afterRouting(
        ask,
        routed(answer, [
          ['cdn-cache-control', 'max-age=99'],
          ['x-variant-seen', '1'],
        ]),
      );

      expect(laid.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      expect(laid.headers.has('cdn-cache-control')).toBe(false);
      expect(laid.headers.get('x-variant-seen')).toBe('1');

      await laid.body?.cancel();
    });

    it('varies on what a router sent, past a Vary routing laid of its own', async () => {
      const ask = asked({ rsc: '1' });
      const answer = requireResource(await staticFileResponse(ask, store, file(4), 200));

      const laid = afterRouting(ask, routed(answer, [['vary', 'accept']]));

      expect(laid.headers.get('vary')).toBe(
        'accept, rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
      );

      await laid.body?.cancel();
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
