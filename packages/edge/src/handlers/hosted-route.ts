import type { ProjectManifest, RouteEntry } from '@stayingupwind/core/manifest';
import {
  BYPASS_COOKIE_NAMES,
  bypassForHolds,
  hasBypassCookie,
  RSC_HEADER,
} from '@stayingupwind/core/request';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';
import { runtimeCacheOf } from '@stayingupwind/host/delivery';

import type { GenerationKey } from '../cache/generation-loader.ts';
import { routeSuspectKey } from '../memory/caches.ts';
import { isDemoted } from '../preview/pointer.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { handedHeaders, type MiddlewareContinued, type MiddlewareOutcome } from './middleware.ts';
import { readsCredentials, readsForwarding } from './routing-headers.ts';

/**
 * What a hosted document's route is judged by once it is settled, for a route the build proved and
 * for a member of a class it made no shell of alike: the request as the middleware left it, the
 * record the route is served from, whether the route is off the edge, and whether Next.js would
 * serve its prerender to the request at all.
 */

/**
 * The request as the middleware left it, or as it came: what the route's conditions are judged on.
 * As it came, on the headers it was classified on (`classifiedHeaders`), which have the host's
 * credentials taken off where a rule of the application's would read one, as the middleware's
 * request has them taken off: the application's routing is never handed them.
 */
export function requestAsLeft(
  input: {
    readonly url: URL;
    readonly request: Request;
    readonly classifiedHeaders?: Headers | undefined;
  },
  middleware: MiddlewareOutcome,
): { readonly url: URL; readonly headers: Headers } {
  return middleware.kind === 'continue'
    ? { url: middleware.url, headers: middleware.requestHeaders }
    : { url: input.url, headers: input.classifiedHeaders ?? input.request.headers };
}

/**
 * Whether the middleware left the request's headers as it was handed them — the request's own,
 * without the host's credentials (`withoutHostCredentials`) — every one with the value it had, and
 * none added. A cookie it set for the render counts as a change, as Next.js's router reads the
 * request with it.
 */
export function headersLeftAlone(
  asked: Headers,
  left: Headers,
  credentials: HostCredentials,
): boolean {
  const handed = withoutHostCredentials(new Headers(asked), credentials);
  let names = 0;
  for (const [name, value] of left) {
    if (handed.get(name) !== value) {
      return false;
    }
    names += 1;
  }
  return names === [...handed.keys()].length;
}

/** The shared forwarded view for a changed middleware request and a shell-less member lookup. */
export function headersAfterMiddleware(
  input: { readonly request: Request; readonly edge: EdgeContext },
  middleware: MiddlewareOutcome,
): Headers | undefined {
  return middleware.kind === 'continue' &&
    (middleware.rewritten ||
      !headersLeftAlone(
        input.request.headers,
        middleware.requestHeaders,
        input.edge.host.credentials,
      ))
    ? handedHeaders(input.edge, middleware.requestHeaders)
    : undefined;
}

/** Only after raw Flight intent: confirm the headers the Function actually receives. */
export function middlewareRequestsFlight(
  edge: EdgeContext,
  middleware: MiddlewareContinued,
  routedHeaders: Headers | undefined,
): boolean {
  return (routedHeaders ?? handedHeaders(edge, middleware.requestHeaders)).get(RSC_HEADER) === '1';
}

/**
 * The record to read for a route: when the deployment has a runtime cache, the route an entry
 * in it, and the policy serves from records. A validation request proves the build's shell and
 * reads none.
 */
export function generationKeyOf(
  input: { readonly manifest: ProjectManifest; readonly edge: EdgeContext },
  entry: RouteEntry,
): GenerationKey | undefined {
  const { manifest } = input;
  const scope = manifest.cache;
  if (scope === undefined || entry.cache === undefined || input.edge.validated) {
    return undefined;
  }
  if (runtimeCacheOf(input.edge.policy).generations !== 'on') {
    return undefined;
  }
  return { scopeId: scope.scopeId, entryId: entry.cache.entryId };
}

/**
 * Why a route the manifest proves is not to be split here, if it is not: demoted on the pointer —
 * the host has the word, which every isolate reads — or condemned in this isolate, until that word
 * arrives. Both under the route's own name: the pointer lookup checked the client's pathname, and a
 * class shell goes under its template, a rewrite target under the pathname rewritten to.
 */
export function offTheEdge(
  edge: EdgeContext,
  entry: Pick<RouteEntry, 'pathname'>,
): 'demoted' | 'suspect' | undefined {
  const { demotedRoutes } = edge;
  // Tested before the clock is read: a pointer that demotes nothing costs this and nothing more.
  if (demotedRoutes !== undefined && isDemoted(demotedRoutes, entry.pathname, edge.runtime.now())) {
    return 'demoted';
  }
  const key = routeSuspectKey(edge.projectId, edge.manifestId, entry.pathname);
  return edge.runtime.memory.suspects.get(key) === true ? 'suspect' : undefined;
}

/** Fixed cookie names, matched only at a Set-Cookie boundary, including after an Expires comma. */
// eslint-disable-next-line security/detect-non-literal-regexp -- Fixed core cookie-name list.
const MIDDLEWARE_BYPASS_COOKIE = new RegExp(
  // eslint-disable-next-line unicorn/prefer-string-raw -- Avoid a new module startup tag call.
  `(?:^|,)\\s*(?:${BYPASS_COOKIE_NAMES.join('|')})\\s*=`,
  'u',
);

type BypassConditions = NonNullable<RouteEntry['bypassFor']>;
const bypassReaders = new WeakMap<
  BypassConditions,
  { readonly credentials: HostCredentials; readonly reads: boolean }
>();

/** Normalize only conditions forwarding can change, caching the condition scan with the manifest. */
function bypassHeaders(
  edge: EdgeContext,
  conditions: BypassConditions | undefined,
  headers: Headers,
): Headers {
  if (conditions === undefined) return headers;
  const { credentials } = edge.host;
  const known = bypassReaders.get(conditions);
  const reads =
    known?.credentials === credentials
      ? known.reads
      : conditions.some(
          (condition) => readsCredentials(condition, credentials) || readsForwarding(condition),
        );
  if (known?.credentials !== credentials) bypassReaders.set(conditions, { credentials, reads });
  return reads ? handedHeaders(edge, headers) : headers;
}

/**
 * Whether Next.js itself would not serve the prerender to this request (`bypassFor`), or the
 * request is in draft mode.
 *
 * The two are the same thing said twice, because `next build` says it only once: it records
 * `bypassFor` for an App Router page and nothing for a Pages Router one, whose draft is entered
 * through the same two cookies. The classification read the cookies the client sent; these are
 * the ones the middleware left, which it is free to set itself.
 *
 * The user-agent condition `next build` writes from `htmlLimitedBots` is asked of the bounded judge
 * the classification asks, not run as the application wrote it, and not of a page the build
 * finished (`bypassForHolds`); every other condition is run as Next.js's router runs it, at a cost
 * its shape does not bound.
 */
export function bypassed(
  input: { readonly manifest: ProjectManifest; readonly edge: EdgeContext },
  entry: RouteEntry,
  left: ReturnType<typeof requestAsLeft>,
  middleware: MiddlewareOutcome,
): boolean {
  // The recovery cookie is edge-owned and deliberately removed from the application's view.
  if (hasBypassCookie(left.headers)) {
    return true;
  }
  if (
    middleware.kind === 'continue' &&
    middleware.setCookie !== undefined &&
    MIDDLEWARE_BYPASS_COOKIE.test(middleware.setCookie)
  ) {
    return true;
  }
  const headers =
    middleware.kind === 'continue'
      ? bypassHeaders(input.edge, entry.bypassFor, left.headers)
      : left.headers;
  return bypassForHolds(entry, left.url, headers, input.manifest);
}
