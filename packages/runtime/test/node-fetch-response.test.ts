import { describe, expect, it, vi } from 'vitest';

import { fetchedResponse } from '../src/node-fetch-response.ts';
import { fetchRewrite as workerFetchRewrite } from '../src/rewrite-fetch.ts';

describe('native fetch content coding boundary', () => {
  it.each(['gzip', 'x-gzip', 'deflate', 'br', 'zstd', 'gzip, br', 'gzip,gzip,gzip,gzip,gzip,gzip'])(
    'removes only decoded wire headers for %s without reading the stream',
    async (encoding) => {
      const headers = new Headers({
        'content-encoding': encoding,
        'content-length': '123',
        'x-origin': 'kept',
      });
      headers.append('set-cookie', 'first=1; Path=/');
      headers.append('set-cookie', 'second=2; Path=/');
      const original = new Response('already decoded by native fetch', { headers });
      const normalized = await fetchedResponse(original, 'GET');

      expect(normalized.body).toBe(original.body);
      expect(original.bodyUsed).toBe(false);
      expect({
        encoding: normalized.headers.get('content-encoding'),
        length: normalized.headers.get('content-length'),
        origin: normalized.headers.get('x-origin'),
        cookies: normalized.headers.getSetCookie(),
      }).toStrictEqual({
        encoding: null,
        length: null,
        origin: 'kept',
        cookies: ['first=1; Path=/', 'second=2; Path=/'],
      });
      await expect(normalized.text()).resolves.toBe('already decoded by native fetch');
    },
  );

  it.each(['unknown', 'gzip, unknown', 'identity, gzip', 'x-deflate', 'gzip,'])(
    'preserves an undecoded or unsupported native response: %s',
    async (encoding) => {
      const response = new Response('raw', {
        headers: { 'content-encoding': encoding, 'content-length': '3' },
      });

      await expect(fetchedResponse(response, 'GET')).resolves.toBe(response);
    },
  );

  it.each(['HEAD', 'CONNECT'])('preserves wire metadata for %s', async (method) => {
    const response = new Response(null, {
      headers: { 'content-encoding': 'gzip', 'content-length': '123' },
    });

    await expect(fetchedResponse(response, method)).resolves.toBe(response);
  });

  it('keeps zstd wire metadata when an older bundled fetch does not decode it', async () => {
    const previous = Object.getOwnPropertyDescriptor(process.versions, 'undici');
    Object.defineProperty(process.versions, 'undici', { value: '7.10.0', configurable: true });
    try {
      const response = new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-encoding': 'zstd', 'content-length': '3' },
      });

      await expect(fetchedResponse(response, 'GET')).resolves.toBe(response);
      expect(response.headers.get('content-encoding')).toBe('zstd');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.versions, 'undici');
      else Object.defineProperty(process.versions, 'undici', previous);
    }
  });

  it('cancels a decoded partial response instead of forwarding encoded byte offsets', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 206,
      headers: {
        'content-encoding': 'gzip',
        'content-range': 'bytes 10-20/100',
        'content-length': '11',
      },
    });

    await expect(fetchedResponse(response, 'GET')).rejects.toThrow('decoded partial response');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves response metadata and native clone body checks', async () => {
    const original = new Response('decoded', { headers: { 'content-encoding': 'gzip' } });
    Object.defineProperties(original, {
      url: { value: 'https://origin.test/final' },
      redirected: { value: true },
      type: { value: 'basic' },
    });
    const normalized = await fetchedResponse(original, 'GET');
    const clone = normalized.clone();
    const metadata = (response: Response) => {
      return {
        url: response.url,
        redirected: response.redirected,
        type: response.type,
        encoding: response.headers.get('content-encoding'),
      };
    };

    expect(metadata(normalized)).toStrictEqual({
      url: 'https://origin.test/final',
      redirected: true,
      type: 'basic',
      encoding: null,
    });
    expect(metadata(clone)).toStrictEqual(metadata(normalized));
    await expect(Promise.all([normalized.text(), clone.text()])).resolves.toStrictEqual([
      'decoded',
      'decoded',
    ]);
    expect(() => normalized.clone()).toThrow(TypeError);
  });

  it('leaves Worker fetch semantics and raw compressed bodies unchanged', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-encoding': 'gzip', 'content-length': '3' },
    });

    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    try {
      await expect(workerFetchRewrite(new URL('https://origin.test/'), {})).resolves.toBe(response);
      expect(response.bodyUsed).toBe(false);
    } finally {
      upstream.mockRestore();
    }
  });
});
