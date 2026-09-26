import { encodeUtf8, toBase64Url } from '../util/bytes.ts';

const CACHE_BUSTING_HASH_BYTES = 12;
const DEFAULT_INPUT = '0';

export interface RscCacheBustingInput {
  readonly prefetch?: string | undefined;
  readonly segmentPrefetch?: string | undefined;
  readonly stateTree?: string | undefined;
  readonly nextUrl?: string | undefined;
}

/**
 * Port of `shared/lib/router/utils/cache-busting-search-param.js`: the `_rsc` value is the
 * base64url (no padding) of the first 12 bytes of SHA-256 over the comma-joined inputs, where every
 * absent header is normalised to `'0'`. When nothing but the default prefetch value is present the
 * client sends no `_rsc` at all, mirrored here by an empty string.
 */
export async function computeRscCacheBustingParam(input: RscCacheBustingInput): Promise<string> {
  const prefetch = input.prefetch ?? DEFAULT_INPUT;
  const isDefault =
    prefetch === DEFAULT_INPUT &&
    input.segmentPrefetch === undefined &&
    input.stateTree === undefined &&
    input.nextUrl === undefined;
  if (isDefault) {
    return '';
  }
  const material = [
    prefetch,
    input.segmentPrefetch ?? DEFAULT_INPUT,
    input.stateTree ?? DEFAULT_INPUT,
    input.nextUrl ?? DEFAULT_INPUT,
  ].join(',');
  const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(material) as BufferSource);
  return toBase64Url(new Uint8Array(digest).subarray(0, CACHE_BUSTING_HASH_BYTES));
}
