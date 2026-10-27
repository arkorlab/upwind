import type { DecodedGenerationPack } from '../cache/pack.ts';
import type { CachePolicy, GenerationPackHeader } from '../cache/schema.ts';
import { staticPageHeadersAllowSharing, staticPageHasNoTransform } from '../cache/static-pages.ts';
import type { StaticPageEntry } from '../manifest/schema.ts';
import { filterStoredResponseHeaders } from '../request/headers.ts';
import { staticFallbackParametersFor } from './fallback-pages.ts';

/**
 * Whether a generation the cache holds for a prerendered Pages page may be served as that page from
 * a shared cache, and the headers it goes out with (`pageHeaders`): the record has to be the one the
 * manifest's entry names, of the source and policy that entry's privacy allows, holding exactly one
 * HTML artifact whose bytes it vouches for. The edge's check, which a host serving the same build
 * without it makes alike.
 */

const HTTP_OK = 200;
const FALLBACK_PRIVACY = 3;

export function htmlType(contentType: string): boolean {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
}

function isrPolicyAgrees(policy: CachePolicy): boolean {
  const { revalidateAfter, expireAfter } = policy;
  return (
    revalidateAfter.kind === 'finite' &&
    Number.isFinite(revalidateAfter.seconds) &&
    revalidateAfter.seconds > 0 &&
    (expireAfter.kind === 'unbounded' ||
      (expireAfter.kind === 'finite' &&
        Number.isFinite(expireAfter.seconds) &&
        expireAfter.seconds >= revalidateAfter.seconds))
  );
}

function memberAgrees(entry: StaticPageEntry): boolean {
  const parameters = staticFallbackParametersFor(entry.route, entry.pathname);
  return (
    parameters !== undefined &&
    entry.parameters !== undefined &&
    entry.dataPathname !== undefined &&
    Object.keys(parameters).length === Object.keys(entry.parameters).length &&
    Object.entries(parameters).every(([name, value]) => entry.parameters?.[name] === value)
  );
}

function isrPageAgrees(header: GenerationPackHeader, entry: StaticPageEntry): boolean {
  const member = entry.staticPagePrivacy === FALLBACK_PRIVACY;
  const sourceAgrees =
    (header.source === 'build' && header.seq === 1 && header.policy.source === 'build-output') ||
    (header.source === 'runtime' &&
      header.seq >= (member ? 1 : 2) &&
      header.policy.source === 'runtime-output');
  return (
    sourceAgrees &&
    (member ? memberAgrees(entry) : entry.route === entry.pathname && !entry.route.includes('[')) &&
    Number.isSafeInteger(header.seq) &&
    Number.isSafeInteger(header.cacheTimestamp) &&
    Number.isSafeInteger(header.producedAt) &&
    isrPolicyAgrees(header.policy)
  );
}

/** A copied marker cannot change source, concrete identity, or the required authority version. */
function pageAgrees(pack: DecodedGenerationPack, entry: StaticPageEntry, scopeId: string): boolean {
  const { header } = pack;
  const expected = entry.staticPagePrivacy ?? 1;
  if (
    header.staticPagePrivacy !== expected ||
    header.kind !== 'pages' ||
    header.scopeId !== scopeId ||
    header.entryId !== entry.entryId ||
    header.route !== entry.route ||
    header.pathname !== entry.pathname ||
    header.status !== HTTP_OK ||
    pack.postponed !== undefined
  )
    return false;
  if (expected === 1) {
    return (
      header.source === 'build' &&
      header.seq === 1 &&
      header.policy.source === 'build-output' &&
      header.policy.revalidateAfter.kind === 'unbounded' &&
      header.policy.expireAfter.kind === 'unbounded'
    );
  }
  return isrPageAgrees(header, entry);
}

/** Legacy records and other representations never inherit a manifest's authority version. */
export function pageHeaders(
  pack: DecodedGenerationPack,
  entry: StaticPageEntry,
  scopeId: string,
): Headers | undefined {
  if (!pageAgrees(pack, entry, scopeId)) return undefined;
  const { header, html } = pack;
  const matching = header.artifacts.filter(
    (item) => item.role === 'html' && item.representationKey === 'html',
  );
  const artifact = matching[0];
  if (
    matching.length !== 1 ||
    (entry.staticPagePrivacy === FALLBACK_PRIVACY && html.byteLength === 0) ||
    artifact?.encoding !== 'identity' ||
    artifact.sha256 !== header.htmlSha256 ||
    artifact.byteLength !== html.byteLength ||
    header.htmlLength !== html.byteLength ||
    !htmlType(artifact.contentType) ||
    !staticPageHeadersAllowSharing(Object.entries(header.headers))
  )
    return undefined;
  let headers: Headers;
  try {
    headers = new Headers(header.headers);
  } catch {
    return undefined;
  }
  const contentType = headers.get('content-type') ?? artifact.contentType;
  if (!htmlType(contentType)) return undefined;
  const noTransform = staticPageHasNoTransform(headers);
  headers = new Headers(filterStoredResponseHeaders(headers));
  if (noTransform) headers.set('cache-control', 'no-transform');
  headers.set('content-type', contentType);
  headers.delete('content-encoding');
  headers.delete('accept-ranges');
  headers.set('content-length', String(html.byteLength));
  return headers;
}

/** Only the paired artifact in that independently proved concrete generation may answer data. */
export function pageDataArtifact(
  pack: DecodedGenerationPack,
  entry: StaticPageEntry,
  scopeId: string,
): GenerationPackHeader['artifacts'][number] | undefined {
  if (
    entry.staticPagePrivacy !== FALLBACK_PRIVACY ||
    pageHeaders(pack, entry, scopeId) === undefined
  )
    return undefined;
  const matching = pack.header.artifacts.filter(
    (artifact) => artifact.role === 'pages-data' && artifact.representationKey === 'pages-data',
  );
  const artifact = matching[0];
  return matching.length === 1 &&
    artifact?.encoding === 'identity' &&
    artifact.byteLength > 0 &&
    artifact.contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json' &&
    artifact.storageRef !== undefined
    ? artifact
    : undefined;
}
