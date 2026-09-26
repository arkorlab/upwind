/**
 * Resource identifiers.
 *
 * Every id is a UUIDv4. The six bits RFC 9562 fixes (four version bits and two variant bits) carry
 * no information, so they are removed and the remaining 122 random bits are the payload. Base58 of
 * 122 bits needs at most 21 characters (`58 ** 21 > 2 ** 122`), so ids are rendered at a fixed width
 * and prefixed with the resource they identify: `project_8k3Qm…`.
 *
 * DNS labels are case-insensitive, so a hostname cannot use Base58: `AbC` and `abc` would resolve to
 * the same host. The same payload is therefore also renderable as lowercase base32, which is what
 * `toDnsLabel` is for. Both renderings are pure functions of the payload, so converting between them
 * costs no lookup.
 */

const UUID_HEX_LENGTH = 32;
const VERSION_NIBBLE_INDEX = 12;
const VARIANT_NIBBLE_INDEX = 15;
const HEX_RADIX = 16;
const VARIANT_BASE = 8;
const VARIANT_VALUES = 4n;
const HIGH_NIBBLES = 15;
const LOW_NIBBLES = 15;
const LOW_SCALE = BigInt(HEX_RADIX) ** BigInt(LOW_NIBBLES);
const ZERO = 0n;
const TWO = 2n;
const BYTE_VALUES = 256n;
// Canonical UUID text is grouped 8-4-4-4-12; the trailing group is whatever remains.
const UUID_TIME_LOW_NIBBLES = 8;
const UUID_GROUP_NIBBLES = 4;
const UUID_GROUP_SIZES: readonly number[] = [
  UUID_TIME_LOW_NIBBLES,
  UUID_GROUP_NIBBLES,
  UUID_GROUP_NIBBLES,
  UUID_GROUP_NIBBLES,
];

/** Bits of entropy in an id: 128 UUID bits minus the four version and two variant bits. */
export const ID_PAYLOAD_BITS = 122;
/** Base58 characters needed for 122 bits: `58 ** 21 > 2 ** 122 > 58 ** 20`. */
export const BASE58_ID_LENGTH = 21;
/** Lowercase base32 characters needed for 122 bits: `ceil(122 / 5)`. */
export const DNS_LABEL_LENGTH = 25;

const DIGIT_1_CODE_POINT = 49;
const DIGIT_COUNT = 9;
const UPPER_A_CODE_POINT = 65;
const LOWER_A_CODE_POINT = 97;
const LETTER_COUNT = 26;
const BASE58_EXCLUDED: ReadonlySet<string> = new Set(['0', 'I', 'l', 'O']);
const BASE32_DIGITS: readonly string[] = ['2', '3', '4', '5', '6', '7'];

function letters(firstCodePoint: number): string[] {
  return Array.from({ length: LETTER_COUNT }, (_unused, index) =>
    String.fromCodePoint(firstCodePoint + index),
  );
}

/**
 * Bitcoin's Base58 alphabet, built from code points: the digits and letters in order, minus the four
 * glyphs that are easy to confuse (`0`, `O`, `I`, `l`).
 */
const BASE58_ALPHABET: readonly string[] = [
  ...Array.from({ length: DIGIT_COUNT }, (_unused, index) =>
    String.fromCodePoint(DIGIT_1_CODE_POINT + index),
  ),
  ...letters(UPPER_A_CODE_POINT),
  ...letters(LOWER_A_CODE_POINT),
].filter((char) => !BASE58_EXCLUDED.has(char));

/** RFC 4648 lowercase alphabet. */
const BASE32_ALPHABET: readonly string[] = [...letters(LOWER_A_CODE_POINT), ...BASE32_DIGITS];

interface Encoding {
  readonly alphabet: readonly string[];
  readonly radix: bigint;
  readonly length: number;
  readonly zero: string;
}

function encodingOf(alphabet: readonly string[], length: number): Encoding {
  return { alphabet, radix: BigInt(alphabet.length), length, zero: alphabet[0] ?? '' };
}

const BASE58 = encodingOf(BASE58_ALPHABET, BASE58_ID_LENGTH);
const BASE32 = encodingOf(BASE32_ALPHABET, DNS_LABEL_LENGTH);
const MAX_PAYLOAD = TWO ** BigInt(ID_PAYLOAD_BITS);

/**
 * The 122 random bits of a UUIDv4.
 */
/* eslint-disable-next-line sonarjs/redundant-type-aliases -- the alias names a domain concept (a UUIDv4 payload) so signatures do not read as accepting any bigint. */
export type IdPayload = bigint;

/** Strip the version and variant bits, leaving the 122 bits a UUIDv4 actually randomises. */
export function payloadFromUuid(uuid: string): IdPayload | undefined {
  const hex = uuid.replaceAll('-', '').toLowerCase();
  if (hex.length !== UUID_HEX_LENGTH || !/^[0-9a-f]+$/u.test(hex)) {
    return undefined;
  }
  const versionless = hex.slice(0, VERSION_NIBBLE_INDEX) + hex.slice(VERSION_NIBBLE_INDEX + 1);
  const high = BigInt(`0x${versionless.slice(0, HIGH_NIBBLES)}`);
  const variantNibble = Number.parseInt(versionless[VARIANT_NIBBLE_INDEX] ?? '', HEX_RADIX);
  const variant = BigInt(variantNibble - VARIANT_BASE);
  if (variant < ZERO || variant >= VARIANT_VALUES) {
    return undefined;
  }
  const low = BigInt(`0x${versionless.slice(VARIANT_NIBBLE_INDEX + 1)}`);
  return (high * VARIANT_VALUES + variant) * LOW_SCALE + low;
}

/** Re-insert the version and variant bits, recovering the canonical UUIDv4 text. */
export function uuidFromPayload(payload: IdPayload): string {
  const low = payload % LOW_SCALE;
  const rest = payload / LOW_SCALE;
  const variant = rest % VARIANT_VALUES;
  const high = rest / VARIANT_VALUES;
  // `high` holds the nibbles either side of the version nibble, which is re-inserted at index 12.
  const highHex = high.toString(HEX_RADIX).padStart(HIGH_NIBBLES, '0');
  const hex = [
    highHex.slice(0, VERSION_NIBBLE_INDEX),
    '4',
    highHex.slice(VERSION_NIBBLE_INDEX),
    (variant + BigInt(VARIANT_BASE)).toString(HEX_RADIX),
    low.toString(HEX_RADIX).padStart(LOW_NIBBLES, '0'),
  ].join('');
  let out = '';
  let cursor = 0;
  for (const size of UUID_GROUP_SIZES) {
    out += `${hex.slice(cursor, cursor + size)}-`;
    cursor += size;
  }
  return out + hex.slice(cursor);
}

/** A fresh UUIDv4 payload from the platform CSPRNG. */
export function createIdPayload(): IdPayload {
  const payload = payloadFromUuid(crypto.randomUUID());
  if (payload === undefined) {
    throw new Error('crypto.randomUUID did not return a UUIDv4');
  }
  return payload;
}

function encodeFixed(payload: IdPayload, encoding: Encoding): string {
  let value = payload;
  let out = '';
  while (value > ZERO) {
    out = (encoding.alphabet[Number(value % encoding.radix)] ?? encoding.zero) + out;
    value /= encoding.radix;
  }
  return out.padStart(encoding.length, encoding.zero);
}

function decodeFixed(text: string, encoding: Encoding): IdPayload | undefined {
  if (text.length !== encoding.length) {
    return undefined;
  }
  let value = ZERO;
  for (const char of text) {
    const digit = encoding.alphabet.indexOf(char);
    if (digit === -1) {
      return undefined;
    }
    value = value * encoding.radix + BigInt(digit);
  }
  return value < MAX_PAYLOAD ? value : undefined;
}

/** `<prefix>_<21 Base58 characters>`, the form every id takes in an API or a URL path. */
export function formatId(prefix: string, payload: IdPayload): string {
  return `${prefix}_${encodeFixed(payload, BASE58)}`;
}

/**
 * An id of the usual shape derived from `seed` rather than minted at random.
 *
 * For the one row that must exist exactly once per something else. A store without an interactive
 * transaction cannot make "look, then create" atomic; a derived id makes the primary key the
 * serialization point, so the loser of a race gets a constraint error instead of a duplicate. The
 * payload is a digest truncated to the usual width, so it says nothing about the seed.
 */
export async function createDerivedId(prefix: string, seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
  );
  let payload = ZERO;
  for (const byte of digest) {
    payload = payload * BYTE_VALUES + BigInt(byte);
  }
  return formatId(prefix, payload % MAX_PAYLOAD);
}

/** Generate an id for `prefix`. */
export function createId(prefix: string): string {
  return formatId(prefix, createIdPayload());
}

/** Parse `<prefix>_<base58>`, rejecting a different prefix, width or alphabet. */
export function parseId(prefix: string, value: string): IdPayload | undefined {
  const marker = `${prefix}_`;
  return value.startsWith(marker) ? decodeFixed(value.slice(marker.length), BASE58) : undefined;
}

/** True when `value` is a well-formed id for `prefix`. */
export function isId(prefix: string, value: string): boolean {
  return parseId(prefix, value) !== undefined;
}

/** The same payload as a lowercase base32 DNS label, for hostnames where Base58 cannot be used. */
export function toDnsLabel(payload: IdPayload): string {
  return encodeFixed(payload, BASE32);
}

/** Inverse of `toDnsLabel`. */
export function fromDnsLabel(label: string): IdPayload | undefined {
  return decodeFixed(label, BASE32);
}
