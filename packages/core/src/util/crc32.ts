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
  // By index, not `for…of`: that takes every byte through the array's iterator, which ran at half
  // this speed in Node 24 (some 135 MB/s against 270, the best of 300 runs over 16 KiB and over
  // 1 MiB) — and this runs over every chunk of a gzip suffix as it streams (`gzipWire`). The
  // fallbacks are only what the index types ask for: an index under the length, or masked to the
  // table's, always reads a number, and they cost nothing that was measured.
  const { length } = bytes;
  for (let index = 0; index < length; index += 1) {
    crc = (TABLE[(crc ^ (bytes[index] ?? 0)) & BYTE_MASK] ?? 0) ^ (crc >>> BITS_PER_BYTE);
  }
  return ~crc >>> 0;
}
