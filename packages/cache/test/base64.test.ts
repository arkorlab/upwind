import { fromBase64, toBase64 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

/**
 * workerd has base64 of its own on `Uint8Array`, and the helpers take it where it is there: the
 * data cache's values travel as base64 both ways, up to 25 MiB of them, which a string made in
 * JavaScript takes seconds over. Here, where the runtime runs, what they give is what `btoa` and
 * `atob` give.
 */

/** What `btoa` makes of bytes handed to it a character at a time: the answer, however slow. */
function slowBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

describe('base64 in workerd', () => {
  it('is workerd’s own', () => {
    const native = Uint8Array as unknown as { readonly fromBase64?: unknown };
    const encoder = Uint8Array.prototype as unknown as { readonly toBase64?: unknown };

    expect(native.fromBase64).toBeTypeOf('function');
    expect(encoder.toBase64).toBeTypeOf('function');
  });

  it.each([0, 1, 2, 3, 8191, 8192, 8193, 100_003])(
    'encodes %i bytes as btoa does, and decodes them back',
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 7919) % 256);
      const encoded = toBase64(bytes);

      expect(encoded).toBe(slowBase64(bytes));
      expect(fromBase64(encoded)).toStrictEqual(bytes);
    },
  );

  it('takes what atob takes, and refuses what it refuses', () => {
    expect([...fromBase64('YQ')]).toStrictEqual([0x61]);
    expect([...fromBase64(' YW\nI= ')]).toStrictEqual([0x61, 0x62]);
    expect(() => fromBase64('a')).toThrow(SyntaxError);
    expect(() => fromBase64('YQ=')).toThrow(SyntaxError);
    expect(() => fromBase64('Y*==')).toThrow(SyntaxError);
  });
});
