import { EDGE_VALIDATED_HEADER } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { handedOnFailure } from '../src/cache-control.ts';
import type { Reading } from '../src/reading.ts';

/** An answer read whole, of no length, under `headers`. */
function answered(headers: Reading['headers']): Reading {
  return {
    status: 200,
    headers,
    length: 0,
    sha256: '',
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    marked: false,
    truncated: false,
  };
}

const SHARED = "answered for shared caches to keep, though the answer is one visitor's";
/** A navigation that carries nothing of a visitor's. */
const ANONYMOUS = { accept: 'text/html', 'sec-fetch-dest': 'document' };

/**
 * An answer the edge hands on as the application gave it keeps a bare `public` where it sets no
 * cookie, names no field `private`, and answers a request that carried nothing of a visitor's
 * (`unsharedUnlessPublic`, decided 2026-10-22); anything else is kept from shared caches.
 */
describe('an answer handed on as the application gave it', () => {
  it.each([
    'private, max-age=60',
    'no-store',
    'public, max-age=3600',
    'Public, max-age=0, must-revalidate',
  ])('may say %j', (cacheControl) => {
    expect(handedOnFailure(answered({ 'cache-control': cacheControl }), ANONYMOUS)).toBeUndefined();
  });

  it.each(['max-age=60', 'public=1, max-age=60', 'public, private="X-User", max-age=60'])(
    'may not say %j, which leaves a lifetime for shared caches without saying public of it all',
    (cacheControl) => {
      expect(handedOnFailure(answered({ 'cache-control': cacheControl }), ANONYMOUS)).toBe(SHARED);
    },
  );

  it('may not say public beside a cookie', () => {
    expect(
      handedOnFailure(
        answered({ 'cache-control': 'public, max-age=60', 'set-cookie': ['seen=1; Path=/'] }),
        ANONYMOUS,
      ),
    ).toBe(SHARED);
  });

  it.each([
    ['a cookie', { ...ANONYMOUS, cookie: 'session=1' }],
    ['an Authorization', { ...ANONYMOUS, authorization: 'Bearer token' }],
    ["the router's protocol", { ...ANONYMOUS, rsc: '1' }],
  ])('may not say public to a request that carried %s', (_, sent) => {
    expect(handedOnFailure(answered({ 'cache-control': 'public, max-age=60' }), sent)).toBe(SHARED);
  });

  it('may not say public to a validation the edge took', () => {
    expect(
      handedOnFailure(
        answered({ 'cache-control': 'public, max-age=60', [EDGE_VALIDATED_HEADER]: '1' }),
        ANONYMOUS,
      ),
    ).toBe(SHARED);
  });

  it('may not carry what a CDN reads ahead of Cache-Control, public or not', () => {
    expect(
      handedOnFailure(
        answered({ 'cache-control': 'public, max-age=60', 'cdn-cache-control': 'max-age=600' }),
        ANONYMOUS,
      ),
    ).toBe(
      "answered with cdn-cache-control, by which a shared cache keeps it, though the answer is one visitor's",
    );
  });
});
