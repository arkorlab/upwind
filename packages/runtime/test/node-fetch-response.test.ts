import { describe, expect, it } from 'vitest';

import { fetchedResponse as workerResponse } from '../src/fetch-response.ts';
import { fetchedResponse } from '../src/node-fetch-response.ts';

describe('native fetch content coding boundary', () => {
  it.each(['gzip', 'x-gzip', 'deflate', 'br', 'zstd', 'gzip, br'])(
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
      const normalized = fetchedResponse(original, 'GET');

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

  it.each([
    'unknown',
    'gzip, unknown',
    'identity, gzip',
    'x-deflate',
    'gzip,',
    'gzip,gzip,gzip,gzip,gzip,gzip',
  ])('preserves an undecoded or unsupported native response: %s', (encoding) => {
    const response = new Response('raw', {
      headers: { 'content-encoding': encoding, 'content-length': '3' },
    });

    expect(fetchedResponse(response, 'GET')).toBe(response);
  });

  it.each(['HEAD', 'CONNECT'])('preserves wire metadata for %s', (method) => {
    const response = new Response(null, {
      headers: { 'content-encoding': 'gzip', 'content-length': '123' },
    });

    expect(fetchedResponse(response, method)).toBe(response);
  });

  it('leaves Worker fetch semantics and raw compressed bodies unchanged', () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-encoding': 'gzip', 'content-length': '3' },
    });

    expect(workerResponse(response, 'GET')).toBe(response);
  });
});
