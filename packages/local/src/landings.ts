import {
  findRouteEntry,
  isExactPathname,
  isReserved,
  matchDynamicRoute,
  type ProjectManifest,
  type RouteEntry,
  staticFileBuildWithoutDpl,
  staticFileKey,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { bypassForHolds, hasBypassCookie, routeDebugValue } from '@stayingupwind/core/request';

import {
  type CheckedStack,
  CLAIMED,
  failed,
  middlewareCovers,
  skipped,
  unrunFailure,
  type Verdict,
  edgeReads,
} from './answers.ts';
import { routedReads } from './routing-reads.ts';

/**
 * Where a document landed, as the check reads it (`documents.ts`): the route the edge's account of
 * its answer names, and the one the request lands on once the application's middleware let it on —
 * rewritten, or routed again by the headers it left it with — in a verdict's words.
 */

/** Where the edge's account of a document names its route: last, but for its generation's. */
export const ROUTE_MARKER = ';route=';

/** What follows the route where a record served the document: its state, its sequence, a member's. */
const GENERATION_MARKERS = /;cache=[^;]*;seq=\d+(?:;member=1)?$/u;

/** Undo only the writer's canonical quoted spelling; malformed accounts remain unmatched. */
function routeName(value: string): string {
  if (!value.startsWith('~')) {
    return value;
  }
  try {
    const named: unknown = JSON.parse(`"${decodeURIComponent(value.slice(1))}"`);
    return typeof named === 'string' && routeDebugValue(named) === value ? named : value;
  } catch {
    return value;
  }
}

/**
 * The routes the edge's account of a document could name: its manifest key, after the marker — the
 * route entry's own pathname, which the edge writes there (`document.ts` in the edge), so a class's
 * template for a member of it, never the member's pathname. A pathname may hold a `;` (`/docs/a;b`),
 * so it is not read as one of the account's `;`-parted fields; and the edge writes a generation's
 * markers after it where a record served the document, which a pathname could end like. So both
 * readings are offered — all of it, and all of it less what reads as a generation's markers — and
 * the manifest's routes say which is meant. The current writer quotes unsafe names; undo that
 * spelling only after separating the generation fields, retaining older unquoted accounts.
 */
export function namedRoutes(answered: string): string[] {
  const at = answered.indexOf(ROUTE_MARKER);
  if (at === -1) {
    return [];
  }
  const named = answered.slice(at + ROUTE_MARKER.length);
  const bare = named.replace(GENERATION_MARKERS, '');
  return bare === named ? [routeName(named)] : [routeName(named), routeName(bare)];
}

/**
 * Whether a request at `pathname` asks for the route `key` as one of the manifest's own pathnames,
 * as the edge looks it up (`findRouteEntry`, its escapes undone as the build named it): which only
 * the rules ahead of the filesystem claim — not a member of a class, which every rule does.
 */
export function exactRouteAt(manifest: ProjectManifest, pathname: string, key: string): boolean {
  return findRouteEntry(manifest, pathname)?.pathname === key;
}

/**
 * The route of the manifest a document request at `url` asks for, by its key, as the edge routes
 * one before any middleware runs: the pathname's own, or — but for one Next.js resolves exactly — a
 * class's member (`matchDynamicRoute`); none where no route of the build's is it.
 */
export function documentRouteAt(
  manifest: ProjectManifest,
  url: URL,
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const route =
    findRouteEntry(manifest, url.pathname) ??
    (isExactPathname(manifest, url.pathname)
      ? undefined
      : matchDynamicRoute(manifest, url, edgeReads(headers)));
  return route?.pathname;
}

/** The route of the manifest the edge's account of a document says it served it as, by its key (`namedRoutes`). */
export function landedRouteOf(manifest: ProjectManifest, answered: string): string | undefined {
  return namedRoutes(answered).find((each) => Object.hasOwn(manifest.routes, each));
}

/**
 * The route the edge's account of a document says it served it as, by its key, where it names a route
 * of the manifest's other than `key` (`namedRoutes`): one the middleware moved the document onto —
 * none where one of its readings is `key` itself, which the route asked for, served as itself, is
 * read first by.
 */
export function servedOtherThan(
  manifest: ProjectManifest,
  answered: string,
  key: string,
): string | undefined {
  if (namedRoutes(answered).includes(key)) {
    return undefined;
  }
  return landedRouteOf(manifest, answered);
}

/**
 * The route of the build the edge says it composed a document as, if it names one: of two the
 * account could mean (`namedRoutes`) — a route, and another whose name reads like the first's with a
 * generation's markers after it — the one the request was taken to (`landed`), where it is either.
 */
export function servedAs(
  manifest: ProjectManifest,
  answered: string,
  landed: RouteEntry | undefined,
): RouteEntry | undefined {
  const held = namedRoutes(answered).filter((named) => Object.hasOwn(manifest.routes, named));
  const key = held.find((named) => named === landed?.pathname) ?? held[0];
  return key === undefined ? undefined : manifest.routes[key];
}

/**
 * Where the application's middleware rewrote a request, if it did, as the edge ran it — read back
 * from the stack (`keptOf`), since what the edge answers a visitor with says only that the
 * middleware ran (`mw=hit`), never that it rewrote: the rewrite is a header of the middleware's
 * protocol, which never reaches a client.
 */
export function rewriteOf(decided: MiddlewareResult | undefined): URL | undefined {
  return decided?.kind === 'continue' && decided.rewritten ? decided.url : undefined;
}

/**
 * How the application's middleware moved a request onto another route, in a verdict's words: by
 * rewriting it, or — where it rewrote nothing — by changing the headers it is routed by, which the
 * edge routes the request again by (`hostedEntry`). Each is followed by where it landed.
 */
export function moveOf(decided: MiddlewareResult | undefined): {
  readonly did: string;
  readonly done: string;
} {
  const onto = rewriteOf(decided);
  return onto === undefined
    ? {
        did: 'changed the headers it is routed by, onto',
        done: "routed by the headers the application's middleware changed onto",
      }
    : { did: `rewrote it to ${onto.pathname},`, done: `rewritten to ${onto.pathname},` };
}

/** Where a request landed, in a verdict's words. */
export function whereLanded(landed: RouteEntry | undefined): string {
  return landed === undefined ? 'no route of the build' : `the route ${landed.pathname}`;
}

/**
 * Where a request lands once the middleware let it on, as the edge finds the route for it as the
 * middleware left it (`hostedEntry`) — at `onto`, and routed by the headers the middleware left it
 * with, which is the route asked for again where it changed neither: none where a rule ahead of the
 * filesystem claims it — the middleware runs before those, so they claim what it rewrote to as they
 * would have claimed what was asked — else a pathname of the build, or, but for one Next.js
 * resolves exactly, a class's member.
 */
export function landingOf(
  stack: Pick<CheckedStack, 'manifest'>,
  onto: URL,
  decided: MiddlewareResult,
): RouteEntry | undefined {
  const { manifest } = stack;
  const routedBy = decided.kind === 'continue' ? decided.requestHeaders : new Headers();
  if (isReserved(manifest, onto, routedBy, true)) {
    return undefined;
  }
  return (
    findRouteEntry(manifest, onto.pathname) ??
    (isExactPathname(manifest, onto.pathname) ||
    (decided.kind === 'continue' && decided.rewritten && hasShippedFile(manifest, onto))
      ? undefined
      : matchDynamicRoute(manifest, onto, routedBy))
  );
}

/** A rewritten target is judged as this deployment's file, never by the source request's dpl. */
function hasShippedFile(manifest: ProjectManifest, onto: URL): boolean {
  const pathname = staticFileKey(manifest, onto.pathname);
  const file = pathname === undefined ? undefined : manifest.staticFiles?.[pathname];
  return (
    file !== undefined && staticFileBuildWithoutDpl(file, manifest.deployment.dplId) !== undefined
  );
}

/**
 * Why a document answered as the route asked for should have been another's: the application's
 * middleware moved the request — rewrote it, or changed the headers it is routed by — and the edge
 * routes it, as the middleware left it, to another route, or to none it composes (`landingOf`).
 */
export function movedFailure(
  stack: Pick<CheckedStack, 'manifest'>,
  route: RouteEntry,
  decided: MiddlewareResult | undefined,
): string | undefined {
  if (decided?.kind !== 'continue') {
    return undefined;
  }
  const landed = landingOf(stack, decided.url, decided);
  if (landed?.pathname === route.pathname) {
    return undefined;
  }
  const { done } = moveOf(decided);
  return `served as the route asked for, though ${done} ${whereLanded(landed)}`;
}

/** Whether the middleware moved a request away from `route`, asked for: onto another, or none. */
export function movedAway(
  stack: Pick<CheckedStack, 'manifest'>,
  route: RouteEntry,
  decided: MiddlewareResult | undefined,
): boolean {
  if (decided?.kind !== 'continue') {
    return false;
  }
  return landingOf(stack, decided.url, decided)?.pathname !== route.pathname;
}

/** A request for a route as it reached the edge's routing: where, and with which headers. */
export interface SentRequest {
  readonly route: RouteEntry;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** Whether its URL is one only the rules ahead of the filesystem claim. */
  readonly exact?: boolean | undefined;
}

/**
 * Whether the middleware left a request's headers as they were handed it, each with its value and
 * none added (`headersLeftAlone` in the edge): the stack's edge takes no credentials off them.
 */
export function headersLeftAlone(asked: Readonly<Record<string, string>>, left: Headers): boolean {
  const handed = edgeReads(asked);
  let names = 0;
  for (const [name, value] of left) {
    if (handed.get(name) !== value) {
      return false;
    }
    names += 1;
  }
  return names === [...handed.keys()].length;
}

/** A route asked for, as the edge's routing reads it (`SentRequest`): under the site's origin. */
export function sentOf(
  stack: CheckedStack,
  asked: {
    readonly route: RouteEntry;
    readonly requested: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly exact?: boolean | undefined;
  },
): SentRequest {
  const { route, headers, exact } = asked;
  return { route, url: new URL(asked.requested, stack.site), headers, exact };
}

/**
 * Whether a rule of `next.config` claims a request as the middleware left it — or as it was sent,
 * where none ran — which the edge then routes to no route it serves (`entryFor`, `hostedEntry`):
 * the application's to answer.
 */
export function claimedAsLeft(
  stack: CheckedStack,
  sent: SentRequest,
  decided: MiddlewareResult | undefined,
): boolean {
  // Moved — rewritten, or its headers changed — the edge routes it again behind the rules ahead of
  // the filesystem alone, as the path a client asked for (`hostedEntry`); left as it was, a pathname
  // of the manifest so too, and a member of a class behind every rule ahead of the class
  // (`dynamicRouteFor`).
  const moved =
    decided?.kind === 'continue' &&
    (decided.rewritten || !headersLeftAlone(sent.headers, decided.requestHeaders));
  if (moved) {
    return isReserved(stack.manifest, decided.url, decided.requestHeaders, true);
  }
  return isReserved(
    stack.manifest,
    sent.url,
    routedReads(sent.url, sent.headers),
    sent.exact ?? true,
  );
}

/**
 * What a document the edge handed on for want of a route of its own is (`unprovedRoute`): the
 * application's, where a rule of `next.config` claims the request as the middleware left it — but a
 * failure where the build's middleware covers the request and the edge ran none, which runs ahead
 * of a claim and may lift it (`hostedEntry`). None where no rule claims it either.
 */
export function unprovedVerdict(
  stack: CheckedStack,
  sent: SentRequest,
  decided: MiddlewareResult | undefined,
): Verdict | undefined {
  const unrun = unrunFailure(
    decided,
    middlewareCovers(stack, sent.url, sent.headers),
    'handed it on',
  );
  if (unrun !== undefined) {
    return failed(unrun);
  }
  return claimedAsLeft(stack, sent, decided) ? skipped(CLAIMED) : undefined;
}

/**
 * Whether Next.js renders a request for a route itself (`bypassed` in the edge), by `headers` as the
 * edge reads them: as it was handed the request (`edgeReads`), or as the middleware left it.
 */
function bypassHolds(
  stack: CheckedStack,
  sent: Pick<SentRequest, 'route' | 'url'>,
  headers: Headers,
): boolean {
  return hasBypassCookie(headers) || bypassForHolds(sent.route, sent.url, headers, stack.manifest);
}

/**
 * Why a page the edge composed from its shell should have been the application's to answer: a rule
 * of `next.config` claims the request, or Next.js renders it itself — a draft mode's cookie stands,
 * or the route's `bypassFor` holds — as the middleware left it, or as it was sent where no
 * middleware ran, and the middleware moved it nowhere else (`hostedEntry`, `bypassed`).
 */
export function shellBypassFailure(
  stack: CheckedStack,
  sent: SentRequest,
  decided: MiddlewareResult | undefined,
): string | undefined {
  if (movedAway(stack, sent.route, decided)) {
    return undefined;
  }
  if (claimedAsLeft(stack, sent, decided)) {
    return 'answered from its shell, though a rule of next.config claims the request';
  }
  const left =
    decided?.kind === 'continue'
      ? { at: { ...sent, url: decided.url }, headers: decided.requestHeaders }
      : { at: sent, headers: edgeReads(sent.headers) };
  return bypassHolds(stack, left.at, left.headers)
    ? "answered from its shell, though its route's bypassFor holds for the request, which Next.js renders itself"
    : undefined;
}

/**
 * A page the edge handed to its Function for Next.js to render itself (`bypass-for`): the check
 * asks as an agent the route's `bypassFor` does not hold for (`browsers.ts`), so only the middleware
 * can have led it there — by moving the request onto a route whose `bypassFor` holds for it as the
 * middleware left it, or by changing the request so that the one asked for's does, or a draft
 * mode's cookie stands (`bypassed` in the edge). That is the middleware's to choose, and skipped;
 * anything else is no answer of the edge's. The edge judges the bypass once the middleware covering
 * the request ran (`serveHostedDocument`), so one handed on with it unrun fails.
 */
export function bypassedVerdict(
  stack: CheckedStack,
  decided: MiddlewareResult | undefined,
  sent?: SentRequest,
): Verdict | undefined {
  if (decided?.kind !== 'continue') {
    if (sent === undefined) {
      return undefined;
    }
    const covered = middlewareCovers(stack, sent.url, sent.headers);
    const unrun = unrunFailure(decided, covered, 'handed it on for Next.js to render');
    if (unrun !== undefined) {
      return failed(unrun);
    }
    // No middleware ran: Next.js's where the route's bypassFor holds for the request as it was
    // sent, as for a coding the check asks for a page in as a browser does.
    return bypassHolds(stack, sent, edgeReads(sent.headers))
      ? skipped(
          `left for Next.js to render as the route ${sent.route.pathname} itself, as its bypassFor holds for the request`,
        )
      : undefined;
  }
  const landed = landingOf(stack, decided.url, decided);
  const left = decided.requestHeaders;
  if (
    landed === undefined ||
    !(hasBypassCookie(left) || bypassForHolds(landed, decided.url, left, stack.manifest))
  ) {
    return undefined;
  }
  return skipped(
    `the application's middleware left it for Next.js to render as the route ${landed.pathname} itself (bypassFor)`,
  );
}
