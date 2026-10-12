import type { ProjectManifest, RouteEntry } from '@stayingupwind/core/manifest';
import { bypassForHolds, hasBypassCookie } from '@stayingupwind/core/request';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';
import { runtimeCacheOf } from '@stayingupwind/host/delivery';

import type { GenerationKey } from '../cache/generation-loader.ts';
import { routeSuspectKey } from '../memory/caches.ts';
import { isDemoted } from '../preview/pointer.ts';
import type { EdgeContext } from '../strategies/context.ts';
import type { MiddlewareOutcome } from './middleware.ts';

/**
 * What a hosted document's route is judged by once it is settled, for a route the build proved and
 * for a member of a class it made no shell of alike: the request as the middleware left it, the
 * record the route is served from, whether the route is off the edge, and whether Next.js would
 * serve its prerender to the request at all.
 */

/** The request as the middleware left it, or as it came: what the route's conditions are judged on. */
export function requestAsLeft(
  input: { readonly url: URL; readonly request: Request },
  middleware: MiddlewareOutcome,
): { readonly url: URL; readonly headers: Headers } {
  return middleware.kind === 'continue'
    ? { url: middleware.url, headers: middleware.requestHeaders }
    : { url: input.url, headers: input.request.headers };
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
  entry: RouteEntry,
): 'demoted' | 'suspect' | undefined {
  const { demotedRoutes } = edge;
  // Tested before the clock is read: a pointer that demotes nothing costs this and nothing more.
  if (demotedRoutes !== undefined && isDemoted(demotedRoutes, entry.pathname, edge.runtime.now())) {
    return 'demoted';
  }
  const key = routeSuspectKey(edge.projectId, edge.manifestId, entry.pathname);
  return edge.runtime.memory.suspects.get(key) === true ? 'suspect' : undefined;
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
  manifest: ProjectManifest,
  entry: RouteEntry,
  url: URL,
  headers: Headers,
): boolean {
  if (hasBypassCookie(headers)) {
    return true;
  }
  return bypassForHolds(entry, url, headers, manifest);
}
