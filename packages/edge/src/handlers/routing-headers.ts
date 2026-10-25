import type { MiddlewareMatcher, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  EDGE_BYPASS_COOKIE,
  type ForwardingContext,
  getCookieValue,
  HOP_BY_HOP_HEADERS,
  INTERNAL_REQUEST_HEADER_PREFIXES,
  INTERNAL_REQUEST_HEADERS,
  MIDDLEWARE_PREFETCH_HEADER,
  parseCookieHeader,
  serializeCookieHeader,
} from '@stayingupwind/core/request';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';

import {
  classificationReadsCredentials,
  CLASSIFIED_HEADER_PREFIXES,
  CLASSIFIED_HEADERS,
  STATIC_CLASSIFIED_HEADERS,
} from '../classification-credentials.ts';
import { passthroughHeaders } from '../forwarding.ts';

type Condition = NonNullable<MiddlewareMatcher['has']>[number];

/** Whether taking off the host's credentials can change what a condition reads. */
export function readsCredentials(condition: Condition, credentials: HostCredentials): boolean {
  if (condition.type !== 'cookie' && condition.type !== 'header') {
    return false;
  }
  const name = condition.type === 'cookie' ? 'cookie' : (condition.key ?? '').toLowerCase();
  return (
    (name === 'cookie' && credentials.cookies.length > 0) ||
    credentials.headers.some((header) => header.toLowerCase() === name)
  );
}

/**
 * Whether forwarding can change a condition's value (`sanitizePassthroughHeaders`): removed
 * internal headers, forwarding values and Via supplied by the edge, or its recovery cookie.
 * A condition on the Cookie header whole also sees its serialization after that cookie is removed.
 */
export function readsForwarding(condition: Condition): boolean {
  if (condition.type === 'cookie') {
    return condition.key === EDGE_BYPASS_COOKIE;
  }
  if (condition.type !== 'header') {
    return false;
  }
  const name = (condition.key ?? '').toLowerCase();
  return (
    name === 'cookie' ||
    name === 'via' ||
    HOP_BY_HOP_HEADERS.includes(name) ||
    INTERNAL_REQUEST_HEADERS.includes(name) ||
    (name !== MIDDLEWARE_PREFETCH_HEADER &&
      INTERNAL_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)))
  );
}

interface RoutingReads {
  readonly credentials: HostCredentials;
  readonly reads: boolean;
  readonly forwardedFields: readonly string[];
}

function rememberEntries(
  entries:
    | Readonly<Record<string, { readonly bypassFor?: readonly Condition[] | undefined }>>
    | undefined,
  remember: (conditions: readonly Condition[] | undefined) => void,
): void {
  if (entries === undefined) return;
  for (const entry of Object.values(entries)) remember(entry.bypassFor);
}

const manifestReaders = new WeakMap<ProjectManifest, RoutingReads>();

/** Credential readers and forwarding fields found together, once per manifest and host credentials. */
export function routingReadsFor(
  manifest: ProjectManifest,
  credentials: HostCredentials,
): RoutingReads {
  const known = manifestReaders.get(manifest);
  if (known?.credentials === credentials) return known;
  let reads = false;
  const fields = new Set<string>();
  const remember = (conditions: readonly Condition[] | undefined): void => {
    if (conditions === undefined) return;
    for (const condition of conditions) {
      const credentialsRead = readsCredentials(condition, credentials);
      reads ||= credentialsRead;
      const name = condition.type === 'header' ? condition.key?.toLowerCase() : undefined;
      if (name !== undefined && (credentialsRead || readsForwarding(condition))) {
        fields.add(name);
      }
    }
  };
  if (manifest.reservedRoutes !== undefined) {
    for (const rule of manifest.reservedRoutes) {
      remember(rule.has);
      remember(rule.missing);
    }
  }
  if (manifest.dynamicRoutes !== undefined) {
    for (const route of manifest.dynamicRoutes) {
      remember(route.has);
      remember(route.missing);
      remember(route.members?.bypassFor);
    }
  }
  for (const entry of Object.values(manifest.routes)) remember(entry.bypassFor);
  rememberEntries(manifest.routeBodies, remember);
  rememberEntries(manifest.staticPages, remember);
  rememberEntries(manifest.pagesFallbacks, remember);
  const found = { credentials, reads, forwardedFields: [...fields] };
  manifestReaders.set(manifest, found);
  return found;
}

/**
 * A copy of `headers` with the host's credentials taken off, keeping the edge's own cookie
 * (`EDGE_BYPASS_COOKIE`) where the visitor sent it. The edge's recovery sets it for the edge, which
 * turns the visitor's next request away from the shell for it, and forwarding takes it off what
 * any application is handed (`sanitizePassthroughHeaders`). Taken off here with the `cookie`
 * header whole, or by its name, it would leave a visitor whose page broke on the same shell again.
 */
export function withoutCredentials(headers: Headers, credentials: HostCredentials): Headers {
  const copy = withoutHostCredentials(new Headers(headers), credentials);
  const own = getCookieValue(headers.get('cookie'), EDGE_BYPASS_COOKIE);
  const left = copy.get('cookie');
  if (own !== undefined && getCookieValue(left, EDGE_BYPASS_COOKIE) === undefined) {
    const pairs = [...parseCookieHeader(left), { name: EDGE_BYPASS_COOKIE, value: own }];
    copy.set('cookie', serializeCookieHeader(pairs));
  }
  return copy;
}

/** The classifier reads these before routing; removing one would admit a request it must pass on. */
function keptForClassification(name: string, headers: Headers): boolean {
  if (name === 'cookie') {
    return getCookieValue(headers.get('cookie'), EDGE_BYPASS_COOKIE) !== undefined;
  }
  return (
    (name !== 'host' &&
      name !== 'x-real-ip' &&
      (CLASSIFIED_HEADERS.has(name) || STATIC_CLASSIFIED_HEADERS.has(name))) ||
    CLASSIFIED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The headers a request is classified on (`classifyRequest`), and its route's conditions are judged
 * on where no middleware runs (`requestAsLeft`): the class of a member served from its record, what
 * a route is not served a prerender under. The application's conditions among them are judged
 * without the host's own credentials (`withoutHostCredentials`), as the middleware's matchers are
 * (`routedHeaders`): the application's routing is never handed them, so a `missing` that names one
 * holds for every request, and a `has` that names one for none. Removing credentials copies only
 * where a condition can read one (`routingReadsFor`), not for any condition at all: Next.js writes
 * one on `rsc` into every build with a deployment id.
 *
 * What the classification reads by name besides — a router's headers, a navigation's, draft mode's
 * cookies — is read on the same headers, and a host that keeps one of those as its own has them
 * copied for that alone (`classificationReadsCredentials`): Next.js is never handed it either.
 * Every forwarding field read by the manifest (`routingReadsFor`) takes its forwarded value,
 * including the public country header the forwarder supplies. The client markers used by
 * classification, including the recovery cookie, stay as they came (`keptForClassification`).
 */
export function headersToClassify(
  manifest: ProjectManifest | undefined,
  headers: Headers,
  credentials: HostCredentials,
  forwarding: ForwardingContext,
): Headers {
  const kept = credentials.cookies.length > 0 || credentials.headers.length > 0;
  const routing = manifest === undefined ? undefined : routingReadsFor(manifest, credentials);
  const staticPages = manifest?.staticPages !== undefined || manifest?.pagesFallbacks !== undefined;
  const copied =
    kept && (classificationReadsCredentials(credentials, staticPages) || routing?.reads === true);
  const classified = copied ? withoutCredentials(headers, credentials) : headers;
  const fields = routing?.forwardedFields ?? [];
  if (fields.length === 0) return classified;
  let forwarded: Headers | undefined;
  let routed = classified;
  for (const name of fields) {
    if (keptForClassification(name, headers)) continue;
    forwarded ??= passthroughHeaders(headers, forwarding, credentials);
    if (routed === headers) routed = new Headers(classified);
    const value = forwarded.get(name);
    if (value === null) routed.delete(name);
    else routed.set(name, value);
  }
  return routed;
}
