import { describe, expect, it } from 'vitest';

import { encodeUtf8 } from '../src/util/bytes.ts';
import { crc32 } from '../src/util/crc32.ts';

describe('crc32', () => {
  it('matches the reference check value', () => {
    // The IEEE CRC-32 "check" value for the ASCII digits 1-9.
    expect(crc32(encodeUtf8('123456789'))).toBe(0xcb_f4_39_26);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('continues from a previous digest', () => {
    const whole = encodeUtf8('The quick brown fox jumps over the lazy dog');
    const head = whole.subarray(0, 19);
    const tail = whole.subarray(19);

    expect(crc32(tail, crc32(head))).toBe(crc32(whole));
    expect(crc32(whole)).toBe(0x41_4f_a3_39);
  });
});
