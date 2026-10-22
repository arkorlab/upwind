/** The legacy TTL values the pinned workerd serializer accepts as signed 32-bit integers. */
const MIN_CACHE_TTL = -2_147_483_648;
const MAX_CACHE_TTL = 2_147_483_647;
const NO_STORE_TTL = -1;

/**
 * Incoming metadata, with the visitor's original encoding kept for the local front line. Workerd
 * serializes a cache mode or legacy TTL with both cacheTtl and an equivalent cacheControl, but
 * rejects that pair when supplied again as explicit RequestInit.cf. Keep the canonical directive
 * and omit only its redundant legacy field when reconstructing an incoming request. Conflicting
 * or unfamiliar pairs remain intact for native validation; application fetch options never pass
 * through this boundary.
 *
 * @see https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/workerd/api/http.c++#L631-L713
 */
export function frontLineCf(
  cf: Readonly<Record<string, unknown>> | undefined,
  clientAcceptEncoding: string,
): Record<string, unknown> {
  const handed: Record<string, unknown> = { ...cf, clientAcceptEncoding };
  const ttl = handed['cacheTtl'];
  const control = handed['cacheControl'];
  const integerTtl =
    typeof ttl === 'number' &&
    Number.isSafeInteger(ttl) &&
    ttl >= MIN_CACHE_TTL &&
    ttl <= MAX_CACHE_TTL;
  if (integerTtl && control === (ttl === NO_STORE_TTL ? 'no-store' : `max-age=${ttl}`)) {
    Reflect.deleteProperty(handed, 'cacheTtl');
  }
  return handed;
}
