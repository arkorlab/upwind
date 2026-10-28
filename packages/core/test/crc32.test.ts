/* eslint-disable no-bitwise -- the reference is shifts and XORs, as the CRC it checks is. */
import { describe, expect, it } from 'vitest';

import { encodeUtf8 } from '../src/util/bytes.ts';
import { crc32 } from '../src/util/crc32.ts';

/** CRC-32 a bit at a time, from the polynomial alone: a reference that shares no table with it. */
function bitwise(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xed_b8_83_20;
    }
  }
  return ~crc >>> 0;
}

/** Bytes no pattern runs through (xorshift32), the same every run. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x9e_37_79_b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

const NOISE = noise(4099);

describe('crc32', () => {
  it.each([1, 2, 3, 7, 8, 9, 255, 256, 257, 1024, 4099])(
    'matches a reference computed bit by bit over %i bytes, whole and continued',
    (length) => {
      const whole = NOISE.subarray(0, length);
      const split = Math.floor(length / 3);
      const head = crc32(whole.subarray(0, split));

      expect(crc32(whole)).toBe(bitwise(whole));
      // A view that starts inside the buffer, as a chunk of a stream may.
      expect(crc32(whole.subarray(split), head)).toBe(bitwise(whole));
    },
  );

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
