/** Byte-level helpers shared by the proof engine, the splice and the edge strategies. */

export const textEncoder: TextEncoder = new TextEncoder();
export const textDecoder: TextDecoder = new TextDecoder();

/** Encode a string as UTF-8 bytes. */
export function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** Decode UTF-8 bytes into a string (invalid sequences become U+FFFD). */
export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/** Concatenate byte arrays into one contiguous array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** True when `haystack` starts with `prefix` (byte-wise). */
export function startsWithBytes(haystack: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.byteLength > haystack.byteLength) {
    return false;
  }
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (haystack[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

/** True when `haystack` ends with `suffix` (byte-wise). */
export function endsWithBytes(haystack: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.byteLength > haystack.byteLength) {
    return false;
  }
  const base = haystack.byteLength - suffix.byteLength;
  for (let index = 0; index < suffix.byteLength; index += 1) {
    if (haystack[base + index] !== suffix[index]) {
      return false;
    }
  }
  return true;
}

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const ASCII_WHITESPACE: ReadonlySet<number> = new Set([CARRIAGE_RETURN, LINE_FEED, SPACE, TAB]);

/**
 * Drop trailing ASCII whitespace, at most `maxBytes` of it; returns a view, not a copy. The bound
 * lets a streaming check that keeps only a fixed tail reach the same verdict as a whole-body one.
 */
function trimTrailingWhitespace(bytes: Uint8Array, maxBytes = Infinity): Uint8Array {
  let end = bytes.byteLength;
  const floor = Math.max(0, end - maxBytes);
  while (end > floor) {
    const byte = bytes[end - 1];
    if (byte === undefined || !ASCII_WHITESPACE.has(byte)) {
      break;
    }
    end -= 1;
  }
  return bytes.subarray(0, end);
}

/**
 * `endsWithBytes`, ignoring trailing ASCII whitespace.
 *
 * Whitespace after a document's closing tags is legal and changes nothing, so every check for
 * "did this document finish" uses this rather than a raw byte comparison. They have to agree:
 * proof admits a route on one, the edge serves it on another, and a disagreement would either
 * delegate a healthy route or recover on every request for one.
 */
export function endsWithBytesTrimmed(
  bytes: Uint8Array,
  suffix: Uint8Array,
  maxTrimBytes = Infinity,
): boolean {
  return endsWithBytes(trimTrailingWhitespace(bytes, maxTrimBytes), suffix);
}

function matchesAt(haystack: Uint8Array, needle: Uint8Array, index: number): boolean {
  for (let offset = 1; offset < needle.byteLength; offset += 1) {
    if (haystack[index + offset] !== needle[offset]) {
      return false;
    }
  }
  return true;
}

/** Index of the first occurrence of `needle` in `haystack` at or after `fromIndex`, or -1. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
  if (needle.byteLength === 0) {
    return fromIndex;
  }
  const last = haystack.byteLength - needle.byteLength;
  const first = needle[0];
  for (let index = fromIndex; index <= last; index += 1) {
    if (haystack[index] === first && matchesAt(haystack, needle, index)) {
      return index;
    }
  }
  return -1;
}

/** Byte-wise equality. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && startsWithBytes(a, b);
}

/** Length of the longest common prefix of all arrays (0 when the list is empty). */
export function longestCommonPrefixLength(arrays: readonly Uint8Array[]): number {
  const [first, ...rest] = arrays;
  if (first === undefined) {
    return 0;
  }
  let length = first.byteLength;
  for (const other of rest) {
    length = Math.min(length, commonPrefixLength(first, other));
  }
  return length;
}

/** Number of bytes matched when comparing `candidate` against `reference` from the start. */
export function commonPrefixLength(reference: Uint8Array, candidate: Uint8Array): number {
  const limit = Math.min(reference.byteLength, candidate.byteLength);
  for (let index = 0; index < limit; index += 1) {
    if (reference[index] !== candidate[index]) {
      return index;
    }
  }
  return limit;
}

const HEX_RADIX = 16;
const BASE64_GROUP = 4;

/** Hex encode bytes (lower-case). */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(HEX_RADIX).padStart(2, '0');
  }
  return hex;
}

const HEX_PAIR = 2;
const HEX_RE = /^[0-9a-f]*$/iu;

/** Inverse of `toHex`; case-insensitive. `undefined` for odd length or non-hex characters. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length % HEX_PAIR !== 0 || !HEX_RE.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.length / HEX_PAIR);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const start = index * HEX_PAIR;
    bytes[index] = Number.parseInt(hex.slice(start, start + HEX_PAIR), HEX_RADIX);
  }
  return bytes;
}

/** Base64 encode with the standard alphabet and padding (CSP hash sources need this form). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/** Base64url encode (no padding). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Base64 decode, standard alphabet, padding optional as `atob` takes it; throws on anything else.
 *
 * Into bytes allocated once, from the one string `atob` makes. `Uint8Array.from` over that string
 * would collect every byte into a list first, which costs many times the value it is decoding.
 */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}

/** Base64url decode (tolerates missing padding). */
export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const missing = (BASE64_GROUP - (normalized.length % BASE64_GROUP)) % BASE64_GROUP;
  return fromBase64(normalized + '='.repeat(missing));
}

/** Deterministic, locale-independent string ordering (UTF-16 code units) for hashing and ids. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
