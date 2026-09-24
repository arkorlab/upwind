import {
  type ResolveRoutesParams,
  type ResolveRoutesResult,
  type Route as RoutingRoute,
  type resolveRoutes,
} from '@next/routing';
import { isPagesDataRequestPath, type Route } from '@upwind/core/bundle';

import type { Resolved } from './outputs.ts';
import { entrypointKindOf, type Store } from './store.ts';

/**
 * The bundle's routing tables in the shape `@next/routing` takes, what it hands back, and what
 * Next.js's own router does around it that `@next/routing` leaves to the platform.
 */

const STATIC_ASSETS_PREFIX = '/_next/static/';
/** What asks with these `Sec-Fetch-Dest` values cannot show a page (Next.js's own list). */
const SUBRESOURCE_DESTINATIONS: ReadonlySet<string> = new Set([
  'audio',
  'audioworklet',
  'font',
  'image',
  'json',
  'manifest',
  'paintworklet',
  'report',
  'script',
  'serviceworker',
  'sharedworker',
  'style',
  'track',
  'video',
  'webidentity',
  'worker',
  'xslt',
]);

/** The Pages Router's kinds of route, whose handler applies `next.config` rewrites itself. */
const REWRITES_AGAIN: ReadonlySet<string> = new Set(['pages', 'pages-api']);

export type RoutingTables = ResolveRoutesParams['routes'];
export type MiddlewareInvoker = ResolveRoutesParams['invokeMiddleware'];

/** The bundle's routes carry optional fields as `undefined`; the router wants them absent. */
function routingRoutes(routes: readonly Route[]): RoutingRoute[] {
  return routes.map((route) => {
    const out: RoutingRoute = { sourceRegex: route.sourceRegex };
    if (route.destination !== undefined) out.destination = route.destination;
    if (route.headers !== undefined) out.headers = route.headers;
    if (route.has !== undefined) out.has = route.has.map((has) => routingHas(has));
    if (route.missing !== undefined) out.missing = route.missing.map((has) => routingHas(has));
    if (route.status !== undefined) out.status = route.status;
    return out;
  });
}

function routingHas(
  has: NonNullable<Route['has']>[number],
): NonNullable<RoutingRoute['has']>[number] {
  if (has.type === 'host') {
    return { type: 'host', value: has.value ?? '' };
  }
  return {
    type: has.type,
    key: has.key ?? '',
    ...(has.value !== undefined && { value: has.value }),
  };
}

type RoutingI18n = NonNullable<Parameters<typeof resolveRoutes>[0]['i18n']>;

export function routingI18n(i18n: NonNullable<Store['manifest']['config']['i18n']>): RoutingI18n {
  const out: RoutingI18n = { defaultLocale: i18n.defaultLocale, locales: i18n.locales };
  if (i18n.localeDetection === false) out.localeDetection = false;
  if (i18n.domains !== undefined) {
    out.domains = i18n.domains.map((domain) => {
      const entry: NonNullable<RoutingI18n['domains']>[number] = {
        defaultLocale: domain.defaultLocale,
        domain: domain.domain,
      };
      if (domain.http === true) entry.http = true;
      if (domain.locales !== undefined) entry.locales = domain.locales;
      return entry;
    });
  }
  return out;
}

function queryString(query: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      params.append(key, item);
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The routing tables as `@next/routing` takes them, with the middleware left out when told to. */
export function routingTables(store: Store, skipMiddleware: boolean): RoutingTables {
  const { routing } = store.manifest;
  return {
    beforeMiddleware: routingRoutes(routing.beforeMiddleware),
    middlewareMatchers: skipMiddleware ? [] : routingRoutes(routing.middlewareMatchers),
    beforeFiles: routingRoutes(routing.beforeFiles),
    afterFiles: routingRoutes(routing.afterFiles),
    dynamicRoutes: routingRoutes(routing.dynamicRoutes),
    onMatch: routingRoutes(routing.onMatch),
    fallback: routingRoutes(routing.fallback),
    shouldNormalizeNextData: routing.shouldNormalizeNextData,
  };
}

/**
 * The headers routing decided a response carries — `next.config` header rules, what the
 * middleware set — added to the response that was produced. Cookies accumulate; anything else
 * routing said wins over what the handler said, as it does on Next.js's own server.
 */
export function withRoutingHeaders(response: Response, added: Headers | undefined): Response {
  if (added === undefined) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of added) {
    if (name === 'set-cookie') {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  }
  return new Response(response.body, { status: response.status, headers });
}

/** A redirect routing decided, whether from a rule or the middleware, with everything else it set. */
export function redirectResponse(
  url: string,
  status: number,
  headers: Headers | undefined,
): Response {
  const out = new Headers(headers);
  out.set('location', url);
  return new Response(null, { status, headers: out });
}

/**
 * Whether every parameter a dynamic route matched decodes. Next.js's route matcher decodes each
 * one (`shared/lib/router/utils/route-matcher.ts`) and its router answers a parameter that does
 * not decode with 400 (`DecodeError`, `server/lib/router-server.ts`). `@next/routing` hands them
 * over as they came, so a request for `/%2` rendered a `[slug]` page with a slug of `%2`.
 */
export function parametersDecode(matches: Readonly<Record<string, string>> | undefined): boolean {
  if (matches === undefined) {
    return true;
  }
  return Object.values(matches).every((value) => decodes(value));
}

function decodes(value: string): boolean {
  try {
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where Next.js sends a request whose path repeats a slash, before any routing: to the same URL
 * with each run of slashes made one, with a 308 (`normalizeRepeatedSlashes`, at the top of
 * `server/lib/router-utils/resolve-routes.ts`). The backslashes it makes slashes of too are slashes
 * by now, as the URL parser reads them. `@next/routing` takes the path as it came, so a `//`
 * matched no rule and no page, and the edge, which leaves such a path to this, got a 404 back.
 */
export function withoutRepeatedSlashes(url: URL): string | undefined {
  if (!url.pathname.includes('//')) {
    return undefined;
  }
  return `${url.pathname.replaceAll(/\/{2,}/gu, '/')}${url.search}`;
}

/**
 * Whether Next.js answers a miss for this request in plain text rather than with the not-found
 * page (`server/lib/router-server.ts`): a file under `_next/static`, which no page stands in for,
 * and a read by something that could not show a page if it got one — an image, a script, a font
 * (`isNonHtmlSecFetchDest`).
 */
export function missesInPlainText(request: Request, at: URL, basePath: string): boolean {
  const underBase =
    basePath !== '' && (at.pathname === basePath || at.pathname.startsWith(`${basePath}/`))
      ? at.pathname.slice(basePath.length)
      : at.pathname;
  if (underBase.startsWith(STATIC_ASSETS_PREFIX)) {
    return true;
  }
  const destination = request.headers.get('sec-fetch-dest');
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    destination !== null &&
    SUBRESOURCE_DESTINATIONS.has(destination)
  );
}

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * The URL a route's handler is handed: the one routing ended on, unless `next.config` rewrote the
 * request to a page or an API route of the Pages Router. That handler applies the rewrites again
 * itself, to the URL the client asked for (`handleRewrites`, in `RouteModule.prepare`), and reads
 * `asPath` and `req.url` off that URL, as a platform that rewrites ahead of it hands it over;
 * handed the destination, a page showed the rewrite's target where Next.js shows its source. What
 * the middleware rewrote to (`asked` is then absent) is no rewrite the handler could apply again,
 * and a data request's URL is the build's to name (`servePagesData`).
 *
 * A member of a route the build closed resolves by its own name, which names no entrypoint: the
 * route it was built from does, and that is the page whose handler is asked.
 */
function handlerUrl(
  store: Store,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
  asked: URL | undefined,
): string {
  const routed = `${target.pathname}${queryString(target.query)}`;
  if (
    asked === undefined ||
    asked.pathname === target.pathname ||
    isPagesDataRequestPath(store.manifest.config.basePath, asked.pathname) ||
    !REWRITES_AGAIN.has(
      entrypointKindOf(store, store.prerendersByPathname.get(route)?.route ?? route) ?? '',
    )
  ) {
    return routed;
  }
  return `${asked.pathname}${asked.search}`;
}

/**
 * What routing resolved, as the build filed it. A page resolved under its spelling with a trailing
 * slash is that page. Whatever it resolved to, the URL is looked up without a trailing slash, as
 * Next.js names what it builds and keeps (`removeTrailingSlash`, in `RouteModule.prepare`): a
 * member of a dynamic route asked for as `/en/legacy/` is the build's `/en/legacy`, its shell and
 * its generations. The handler is still handed the URL as it was asked for.
 */
export function resolvedOf(
  store: Store,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
  asked: { readonly url: URL; readonly rewrite: URL | undefined },
): Resolved {
  const page = store.slashSpellings.get(route) ?? route;
  return {
    route: page,
    pathname: withoutTrailingSlash(target.pathname),
    // The URL asked for goes to the handler only if the middleware did not rewrite it.
    url: handlerUrl(store, page, target, asked.rewrite === undefined ? asked.url : undefined),
  };
}
