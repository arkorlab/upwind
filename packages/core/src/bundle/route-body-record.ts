import type { DecodedGenerationPack } from '../cache/pack.ts';
import type { RouteBodyEntry } from '../manifest/schema.ts';
import {
  GATED_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  SHARED_CACHE_CONTROL_HEADERS,
} from '../request/constants.ts';
import { filterStoredResponseHeaders } from '../request/headers.ts';
import { policyRefusesSharing } from '../request/route-body-policy.ts';

/**
 * Whether a generation the cache holds for a prerendered route body — a metadata route, a static
 * `GET` handler — may be served as that body from a shared cache, and with what headers
 * (`bodyHeaders`, `narrowCacheControl`). The edge's check, which a host serving the same build
 * without it makes alike.
 */

const HTTP_OK = 200;
const CACHE_CONTROL = 'cache-control';
const NO_TRANSFORM = 'no-transform';
const CACHE_CONTROL_FIELDS = [CACHE_CONTROL, ...SHARED_CACHE_CONTROL_HEADERS];
const CONTENT_TYPE = 'content-type';
const CONTENT_ENCODING = 'content-encoding';
const SET_COOKIE = 'set-cookie';
const ROUTE_BODY = 'route-body';

/** Whether a route body of this type may be served from a shared cache: one type, and no document. */
export function bodyTypeAllowed(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    type !== undefined &&
    type !== '' &&
    !type.includes(',') &&
    type !== 'text/html' &&
    type !== 'application/xhtml+xml'
  );
}

function noTransformDirective(value: string | null): boolean {
  return (
    value?.split(',').some((directive) => directive.trim().toLowerCase() === NO_TRANSFORM) === true
  );
}

/** Whether any of the answer's cache-control fields says `no-transform`. */
export function noTransform(headers: Pick<Headers, 'get'>): boolean {
  return CACHE_CONTROL_FIELDS.some((name) => noTransformDirective(headers.get(name)));
}

/**
 * The `Cache-Control` a route body goes out with: the record's own where it has a policy, a shared
 * revalidation where it has none; a `gated` answer — one a middleware admitted, which is
 * visitor-specific — kept from shared caches whatever the record said.
 */
export function narrowCacheControl(headers: Headers, gated: boolean, untransformed: boolean): void {
  const existing = headers.get(CACHE_CONTROL);
  // A stored prohibition alone does not supply the missing browser revalidation policy.
  const policyMissing =
    existing === null ||
    existing.split(',').every((part) => {
      const directive = part.trim().toLowerCase();
      return directive === '' || directive === NO_TRANSFORM;
    });
  const ungated = policyMissing ? REVALIDATE_CACHE_CONTROL : existing;
  const policy = gated ? GATED_CACHE_CONTROL : ungated;
  headers.set(
    CACHE_CONTROL,
    `${policy}${untransformed && !noTransformDirective(policy) ? ', no-transform' : ''}`,
  );
}

function bodyArtifact(pack: DecodedGenerationPack) {
  const { header, html: body } = pack;
  const artifact = header.artifacts.find(
    (item) => item.role === ROUTE_BODY && item.representationKey === ROUTE_BODY,
  );
  if (
    artifact?.encoding !== 'identity' ||
    artifact.sha256 !== header.htmlSha256 ||
    artifact.byteLength !== body.byteLength ||
    !bodyTypeAllowed(artifact.contentType)
  ) {
    return;
  }
  return artifact;
}

/** A verified pack of another representation cannot be reinterpreted as this route's body. */
export function bodyHeaders(
  pack: DecodedGenerationPack,
  entry: RouteBodyEntry,
): Headers | undefined {
  const { header, html: body } = pack;
  if (
    header.kind !== 'app-route' ||
    header.route !== entry.route ||
    header.pathname !== entry.pathname ||
    header.entryId !== entry.entryId ||
    header.status !== HTTP_OK ||
    pack.postponed !== undefined
  ) {
    return undefined;
  }
  const artifact = bodyArtifact(pack);
  if (artifact === undefined) return undefined;
  let headers: Headers;
  try {
    headers = new Headers(header.headers);
  } catch {
    return undefined;
  }
  const contentType = headers.get(CONTENT_TYPE) ?? artifact.contentType;
  if (!bodyTypeAllowed(contentType) || headers.has(SET_COOKIE) || policyRefusesSharing(headers)) {
    return undefined;
  }
  // Packs admit a header map, not transport semantics. Check vetoes before filtering their evidence.
  const cacheControl = headers.get(CACHE_CONTROL);
  const untransformed = noTransform(headers);
  headers = new Headers(filterStoredResponseHeaders(headers));
  if (cacheControl !== null) headers.set(CACHE_CONTROL, cacheControl);
  if (untransformed && !noTransformDirective(cacheControl)) {
    headers.set(
      CACHE_CONTROL,
      cacheControl === null || cacheControl === ''
        ? NO_TRANSFORM
        : `${cacheControl}, ${NO_TRANSFORM}`,
    );
  }
  try {
    headers.set(CONTENT_TYPE, contentType);
  } catch {
    return undefined;
  }
  headers.delete(CONTENT_ENCODING);
  headers.delete('accept-ranges');
  headers.set('content-length', String(body.byteLength));
  return headers;
}
