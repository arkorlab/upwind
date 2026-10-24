import { describe, expect, it } from 'vitest';

import { canonicalJson, contentAddress, sha256Hex, sha256HexOfText } from '../src/artifact/hash.ts';
import { encodeUtf8 } from '../src/util/bytes.ts';

describe('hash', () => {
  it('computes the SHA-256 test vector', async () => {
    await expect(sha256Hex(encodeUtf8('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await expect(sha256HexOfText('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('serialises JSON canonically', () => {
    const left = canonicalJson({ b: [3, { z: 1, y: undefined }], a: 'x', c: undefined });
    const right = canonicalJson({ c: undefined, a: 'x', b: [3, { y: undefined, z: 1 }] });

    expect(left).toBe(right);
    expect(left).toBe('{"a":"x","b":[3,{"z":1}]}');
  });

  it('prefixes content addresses', async () => {
    await expect(contentAddress(encodeUtf8('abc'))).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
