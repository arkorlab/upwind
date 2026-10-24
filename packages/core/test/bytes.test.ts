import { describe, expect, it } from 'vitest';

import {
  commonPrefixLength,
  compareCodeUnits,
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  endsWithBytes,
  equalBytes,
  fromBase64,
  fromBase64Url,
  indexOfBytes,
  longestCommonPrefixLength,
  startsWithBytes,
  toBase64,
  toBase64Url,
  toHex,
} from '../src/util/bytes.ts';

describe('bytes', () => {
  it('concatenates and round-trips text', () => {
    const joined = concatBytes([encodeUtf8('ab'), encodeUtf8(''), encodeUtf8('c')]);

    expect(decodeUtf8(joined)).toBe('abc');
  });

  it('detects prefixes and suffixes', () => {
    const value = encodeUtf8('hello world');

    expect(startsWithBytes(value, encodeUtf8('hello'))).toBe(true);
    expect(startsWithBytes(value, encodeUtf8('world'))).toBe(false);
    expect(endsWithBytes(value, encodeUtf8('world'))).toBe(true);
    expect(endsWithBytes(value, encodeUtf8('hello world!'))).toBe(false);
    expect(equalBytes(value, encodeUtf8('hello world'))).toBe(true);
  });

  it('finds byte sequences', () => {
    const value = encodeUtf8('<a></a><b></b>');

    expect(indexOfBytes(value, encodeUtf8('</b>'))).toBe(10);
    expect(indexOfBytes(value, encodeUtf8('<c>'))).toBe(-1);
    expect(indexOfBytes(value, encodeUtf8('<a>'), 1)).toBe(-1);
  });

  it('computes common prefixes', () => {
    const a = encodeUtf8('prefix-one');
    const b = encodeUtf8('prefix-two');

    expect(commonPrefixLength(a, b)).toBe(7);
    expect(longestCommonPrefixLength([a, b, encodeUtf8('pre')])).toBe(3);
    expect(longestCommonPrefixLength([])).toBe(0);
  });

  it('encodes hex and base64url', () => {
    const bytes = new Uint8Array([0, 255, 16, 251, 3]);

    expect(toHex(bytes)).toBe('00ff10fb03');
    expect(toBase64Url(bytes)).toBe('AP8Q-wM');
    expect([...fromBase64Url('AP8Q-wM')]).toStrictEqual([...bytes]);
  });

  it.each([0, 1, 2, 3, 4, 5])('decodes the base64 of %i bytes back into them', (length) => {
    // Every remainder of three, so every ending: no padding, `==` and `=`.
    const bytes = Uint8Array.from({ length }, (_, index) => 0xff - index);

    expect([...fromBase64(toBase64(bytes))]).toStrictEqual([...bytes]);
  });

  it('decodes every byte value, and padding as optional as `atob` takes it', () => {
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);

    expect([...fromBase64(toBase64(every))]).toStrictEqual([...every]);
    expect([...fromBase64('YQ')]).toStrictEqual([0x61]);
    expect([...fromBase64('YWI')]).toStrictEqual([0x61, 0x62]);
  });

  /**
   * Node.js has no base64 of its own on `Uint8Array`, so what runs here is the string `btoa` is
   * handed a chunk of 8192 bytes at a time: every length across a chunk's edge encodes as Node's
   * own `Buffer` does, and decodes back.
   */
  it.each([8191, 8192, 8193, 3 * 8192 + 1])(
    'encodes %i bytes across the chunks it is made of',
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 7919) % 256);

      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect(fromBase64(toBase64(bytes))).toStrictEqual(bytes);
    },
  );

  it('refuses what is not base64', () => {
    // One character cannot make a byte; `=` is padding only where it ends a whole group of four,
    // and `*` is no character of the alphabet.
    expect(() => fromBase64('a')).toThrow(DOMException);
    expect(() => fromBase64('YQ=')).toThrow(DOMException);
    expect(() => fromBase64('Y*==')).toThrow(DOMException);
  });

  it('orders strings by code units', () => {
    expect(['b', 'B', 'a'].toSorted(compareCodeUnits)).toStrictEqual(['B', 'a', 'b']);
  });
});
