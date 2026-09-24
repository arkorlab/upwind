/* eslint-disable no-bitwise -- a CRC is shifts and XORs; there is no other way to write one. */
/**
 * CRC-32 (IEEE 802.3, the gzip polynomial), computed incrementally.
 *
 * A gzip trailer carries the CRC of the whole uncompressed body. The edge only ever sees the suffix
 * of that body, so the shell's CRC is computed once when the shell is encoded and continued over
 * the suffix as it streams: `crc32(suffix, crc32(shell)) === crc32(shell ‖ suffix)`.
 */

const POLYNOMIAL = 0xed_b8_83_20;
const TABLE_SIZE = 256;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;

function buildTable(): Uint32Array {
  const table = new Uint32Array(TABLE_SIZE);
  for (let index = 0; index < TABLE_SIZE; index += 1) {
    let value = index;
    for (let bit = 0; bit < BITS_PER_BYTE; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ POLYNOMIAL;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const TABLE = buildTable();

/** CRC-32 of `bytes`, continuing from `seed` (the CRC of everything before them; 0 to start). */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (const byte of bytes) {
    crc = (TABLE[(crc ^ byte) & BYTE_MASK] ?? 0) ^ (crc >>> BITS_PER_BYTE);
  }
  return ~crc >>> 0;
}
