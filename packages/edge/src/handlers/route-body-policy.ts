import { NEXT_URL_HEADER, RSC_VARY } from '@stayingupwind/core/request';

/** A transport filter must not erase an owner's denial of shared route-body delivery. */
const PRIVACY_HEADERS: ReadonlySet<string> = new Set([
  'cache-control',
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'content-encoding',
  'content-range',
  'content-type',
  'set-cookie',
  'surrogate-control',
  'vary',
]);
/**
 * Identity bytes ignore compression. Every shared route-body request has no router protocol
 * fields: their presence, even empty, is rejected before and after middleware. Keep those Vary
 * names on the response, while unknown request fields still require a keyed Function answer.
 */
const INVARIANT_VARY: ReadonlySet<string> = new Set([
  'accept-encoding',
  ...RSC_VARY.split(', '),
  NEXT_URL_HEADER,
]);

/** A local veto, read before Connection options remove those fields from middleware headers. */
export function connectionRefusesSharing(headers: Pick<Headers, 'get'>): boolean {
  return (
    headers
      .get('connection')
      ?.split(',')
      .some((name) => PRIVACY_HEADERS.has(name.trim().toLowerCase())) === true
  );
}

function refusesSharing(cacheControl: string | null, vary: string | null): boolean {
  return (
    cacheControl
      ?.split(',')
      .some((part) => /^(?:private|no-store)(?:\s*=|$)/iu.test(part.trim())) === true ||
    vary?.split(',').some((part) => {
      const name = part.trim().toLowerCase();
      return name !== '' && !INVARIANT_VARY.has(name);
    }) === true
  );
}

/** Explicit private policies and unsupported representations remain the Function's to answer. */
export function policyRefusesSharing(headers: Pick<Headers, 'get'>): boolean {
  for (const name of PRIVACY_HEADERS) {
    if (refusesSharing(headers.get(name), null)) return true;
  }
  const encoding = headers.get('content-encoding');
  return (
    headers.get('content-range') !== null ||
    (encoding !== null && encoding.trim().toLowerCase() !== 'identity') ||
    refusesSharing(null, headers.get('vary')) ||
    connectionRefusesSharing(headers)
  );
}
