import { compareCodeUnits, encodeUtf8, toHex } from '../util/bytes.ts';

/** How many hex digits a SHA-256 is written in. */
export const SHA256_HEX_LENGTH = 64;

/** SHA-256 of `bytes` as lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** SHA-256 of a UTF-8 string as lower-case hex. */
export async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(encodeUtf8(text));
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, `undefined` values dropped.
 * Used for content-addressed identities (manifest ids) so semantically equal documents hash equally.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sortValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted(compareCodeUnits)) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = sortValue(item);
      }
    }
    return sorted;
  }
  return value;
}

/** Logical identity of a byte sequence: `sha256:<hex>`. */
export async function contentAddress(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}
