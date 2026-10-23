import { pageOfPagesData } from '@stayingupwind/core/bundle';
import {
  findRouteEntry,
  isExactPathname,
  matchDynamicRoute,
  type RouteEntry,
} from '@stayingupwind/core/manifest';

import type { CheckedStack } from './answers.ts';
import type { Part, PartKind } from './part-marks.ts';
import type { Sent } from './redirects.ts';
import { classifiedReads } from './routing-reads.ts';

/**
 * The route of the build a router's request at `sent` asks a part of, as the edge finds it
 * (`classifyRequest`): props by their URL (`pageOfPagesData`), where the page has props; a segment
 * or the whole payload by the page's pathname — or, but for one Next.js resolves exactly, a class's
 * member — and whether that is the route's own.
 */
export function routeAskedAt(
  stack: CheckedStack,
  kind: PartKind,
  sent: Sent,
): { readonly route: RouteEntry; readonly exact: boolean } | undefined {
  const { manifest } = stack;
  const { pathname } = sent.url;
  if (kind === 'data') {
    const prefix = manifest.pagesDataPrefix;
    const basePath = manifest.pagesDataBasePath ?? '';
    const trailingSlash = manifest.trailingSlash === true;
    const page =
      prefix === undefined ? undefined : pageOfPagesData(prefix, basePath, pathname, trailingSlash);
    const route =
      page !== undefined && Object.hasOwn(manifest.routes, page)
        ? manifest.routes[page]
        : undefined;
    return route?.pagesData === undefined ? undefined : { route, exact: true };
  }
  const own = findRouteEntry(manifest, pathname);
  if (own !== undefined) {
    return { route: own, exact: true };
  }
  const member = isExactPathname(manifest, pathname)
    ? undefined
    : // On the headers the edge classifies the request on (`classifiedReads`, Codex).
      matchDynamicRoute(manifest, sent.url, classifiedReads(manifest, sent.url, sent.headers));
  return member === undefined ? undefined : { route: member, exact: false };
}

/** A part at the URL a browser fetch actually reached, with that request's headers. */
export function partLandedAt(stack: CheckedStack, part: Part, sent: Sent): Part | undefined {
  const at = routeAskedAt(stack, part.kind, sent);
  return at === undefined
    ? undefined
    : {
        ...part,
        what: `${part.what}, redirected to ${sent.url.pathname}`,
        url: sent.url,
        headers: sent.headers,
        route: at.route,
        built: part.builtOn(at.route),
        exact: at.exact,
      };
}
