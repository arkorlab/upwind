import { pagesDataPathnameUnder, staticFallbackParametersFor } from '@stayingupwind/core/bundle';
import {
  type CachePolicy,
  generationResponseHeaders,
  type OutputSnapshot,
  type PackBodyDigests,
  staticPageHasNoTransform,
  staticPageDataHeadersAllowSharing,
  staticPageHeadersAllowSharing,
} from '@stayingupwind/core/cache';

import type { PackHeaderFields } from './pack-header-fields.ts';

const HTTP_OK = 200;
const FALLBACK_PRIVACY = 3;
const PAGES_DATA = 'pages-data';
type PrivacyVersion = 1 | 2 | typeof FALLBACK_PRIVACY;

function* headerPairs(
  headers: Readonly<Record<string, string | readonly string[]>>,
): IterableIterator<[string, string]> {
  for (const [name, values] of Object.entries(headers)) {
    if (typeof values === 'string') {
      yield [name, values];
    } else {
      for (const value of values) yield [name, value];
    }
  }
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

function memberPathAgrees(fields: PackHeaderFields, version: PrivacyVersion): boolean {
  const { route, pathname } = fields.entry;
  return version === FALLBACK_PRIVACY
    ? route !== null &&
        pathname !== null &&
        staticFallbackParametersFor(route, pathname) !== undefined
    : route?.includes('[') === false;
}

/** A later render needs its own version-two proof; no entry or preceding generation grants it. */
function lifetimeAgrees(fields: PackHeaderFields, version: PrivacyVersion): boolean {
  const { generation } = fields;
  const { revalidateAfter, expireAfter } = generation.policy;
  if (version !== FALLBACK_PRIVACY && fields.entry.route !== fields.entry.pathname) return false;
  if (version === 1) {
    return (
      generation.source === 'build' &&
      generation.seq === 1 &&
      generation.policy.source === 'build-output' &&
      revalidateAfter.kind === 'unbounded' &&
      expireAfter.kind === 'unbounded'
    );
  }
  const sourceAgrees =
    (generation.source === 'build' &&
      generation.seq === 1 &&
      generation.policy.source === 'build-output') ||
    (generation.source === 'runtime' &&
      Number.isSafeInteger(generation.seq) &&
      generation.seq >= (version === FALLBACK_PRIVACY ? 1 : 2) &&
      generation.policy.source === 'runtime-output');
  const pathAgrees = memberPathAgrees(fields, version);
  return (
    sourceAgrees &&
    pathAgrees &&
    Number.isSafeInteger(generation.cacheTimestamp) &&
    Number.isSafeInteger(generation.producedAt) &&
    isrPolicyAgrees(generation.policy)
  );
}

function pageFieldsAgree(fields: PackHeaderFields, digests: PackBodyDigests): boolean {
  const { entry, generation } = fields;
  return (
    entry.kind === 'pages' &&
    fields.scopeId.length > 0 &&
    entry.entryId.length > 0 &&
    entry.route?.startsWith('/') === true &&
    entry.pathname?.startsWith('/') === true &&
    generation.status === HTTP_OK &&
    digests.postponedSha256 === null &&
    digests.postponedLength === 0 &&
    staticPageHeadersAllowSharing(Object.entries(generation.headers))
  );
}

function primaryDocumentOf(fields: PackHeaderFields): OutputSnapshot | undefined {
  const { entry, outputs } = fields;
  const documents = outputs.filter((output) =>
    output.artifacts.some((artifact) => artifact.role === 'html'),
  );
  const output = documents[0];
  if (
    documents.length !== 1 ||
    (output?.staticPagePrivacy !== 1 &&
      output?.staticPagePrivacy !== 2 &&
      output?.staticPagePrivacy !== FALLBACK_PRIVACY) ||
    output.representationKey !== 'html' ||
    output.pathname !== entry.pathname ||
    output.status !== HTTP_OK ||
    output.compute !== 'static' ||
    output.response !== 'complete' ||
    outputs.some((other) => other.artifacts.some((artifact) => artifact.role === 'postponed')) ||
    !staticPageHeadersAllowSharing(headerPairs(output.headers))
  ) {
    return undefined;
  }
  return output;
}

/** Version three proves a complete props representation from the same concrete render. */
function pairedDataOf(fields: PackHeaderFields): OutputSnapshot | undefined {
  const { buildId, entry, outputs } = fields;
  if (buildId === undefined || buildId.length === 0 || entry.pathname === null) return undefined;
  const data = outputs.filter((output) =>
    output.artifacts.some((artifact) => artifact.role === PAGES_DATA),
  );
  const output = data[0];
  const body = output?.artifacts[0];
  // Version-three admission excludes basePath builds; do not infer a prefix from output bytes.
  if (
    outputs.length !== 2 ||
    data.length !== 1 ||
    output?.staticPagePrivacy !== FALLBACK_PRIVACY ||
    output.representationKey !== PAGES_DATA ||
    output.pathname !== pagesDataPathnameUnder(buildId, '', entry.pathname) ||
    output.status !== HTTP_OK ||
    output.compute !== 'static' ||
    output.response !== 'complete' ||
    output.artifacts.length !== 1 ||
    body?.role !== PAGES_DATA ||
    body.encoding !== 'identity' ||
    body.byteLength <= 0 ||
    !staticPageDataHeadersAllowSharing([
      ...headerPairs(output.headers),
      ['content-type', body.contentType],
    ])
  ) {
    return undefined;
  }
  return output;
}

export function staticPagePrivacyOf(
  fields: PackHeaderFields,
  digests: PackBodyDigests,
): PrivacyVersion | undefined {
  if (!pageFieldsAgree(fields, digests)) return undefined;
  const output = primaryDocumentOf(fields);
  const version = output?.staticPagePrivacy;
  if (output === undefined || version === undefined || !lifetimeAgrees(fields, version)) {
    return undefined;
  }
  if (
    version === FALLBACK_PRIVACY &&
    (digests.htmlLength <= 0 || pairedDataOf(fields) === undefined)
  )
    return undefined;
  const bodies = output.artifacts.filter((artifact) => artifact.role === 'html');
  const body = bodies[0];
  return bodies.length === 1 &&
    body?.encoding === 'identity' &&
    body.sha256 === digests.htmlSha256 &&
    body.byteLength === digests.htmlLength &&
    staticPageHeadersAllowSharing([['content-type', body.contentType]])
    ? version
    : undefined;
}

/** Validate runtime claims before storing snapshots, then validate them again against pack bytes. */
export function runtimeStaticPageOutputsOf(fields: PackHeaderFields): readonly OutputSnapshot[] {
  const document = primaryDocumentOf(fields);
  const body = document?.artifacts.find((artifact) => artifact.role === 'html');
  const version =
    body !== undefined && fields.generation.source === 'runtime'
      ? staticPagePrivacyOf(fields, {
          htmlSha256: body.sha256,
          htmlLength: body.byteLength,
          postponedSha256: null,
          postponedLength: 0,
        })
      : undefined;
  const data = version === FALLBACK_PRIVACY ? pairedDataOf(fields) : undefined;
  return fields.outputs.map((output) => {
    return output.staticPagePrivacy === undefined ||
      ((version === 2 || version === FALLBACK_PRIVACY) && (output === document || output === data))
      ? output
      : { ...output, staticPagePrivacy: undefined };
  });
}

/** Keep original transform vetoes without reintroducing application or CDN freshness directives. */
export function staticPageHeadersOf(fields: PackHeaderFields): Record<string, string> {
  const original = fields.outputs.find((output) =>
    output.artifacts.some((artifact) => artifact.role === 'html'),
  );
  const headers = generationResponseHeaders(
    'pages',
    HTTP_OK,
    Object.entries(fields.generation.headers),
  );
  if (
    staticPageHasNoTransform([
      ...Object.entries(fields.generation.headers),
      ...headerPairs(original?.headers ?? {}),
      ...(original?.staticPagePrivacy === FALLBACK_PRIVACY
        ? fields.outputs.flatMap((output) => [...headerPairs(output.headers)])
        : []),
    ])
  ) {
    headers['cache-control'] = 'no-transform';
  }
  return headers;
}
