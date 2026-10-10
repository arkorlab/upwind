import {
  detectDomainLocale,
  normalizeLocalePath,
  type ResolveRoutesParams,
  type ResolveRoutesResult,
  type Route as RoutingRoute,
  resolveRoutes,
} from '@next/routing';
import {
  type EntrypointKind,
  isPagesDataRequestPath,
  type Route,
} from '@stayingupwind/core/bundle';
import { ORIGINAL_URL_HEADER } from '@stayingupwind/core/paas';
import { NEXT_DATA_HEADER, NULL_BODY_STATUSES } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import { stripPlatformHeaders } from './incoming.ts';
import { escapedNameOf, namesWithSpellings, prerenderedName } from './name-spellings.ts';
import type { Resolved } from './outputs.ts';
import {
  AFTER_FILES,
  BEFORE_FILES,
  BEFORE_MIDDLEWARE,
  FALLBACK,
  markedRewrites,
} from './rewritten-path.ts';
import { routeQuery } from './route-parameters.ts';
import { HTTP_OK } from './serve.ts';
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

/**
 * The client's headers as the middleware and the handler after it are given them: without the
 * platform's own, and with `x-nextjs-data` decided by the path rather than taken from the client.
 *
 * Next.js drops that header from what a client sends (`filterInternalHeaders`) and puts it back
 * itself when the path is a data request (`server/lib/router-utils/resolve-routes.ts`). The edge
 * drops it before a request reaches this Function, and `@next/routing` puts nothing back. It is how a
 * middleware knows it is answering a client navigation's `_next/data` fetch, which it answers with
 * `x-nextjs-redirect` or `x-nextjs-rewrite` for the client's router to follow. Without it a
 * redirect comes back as a `Location` the fetch cannot use and a rewrite comes back unnamed, and
 * the router gives up and loads the whole page.
 */
export function routedHeaders(request: Request, url: URL, basePath: string): Headers {
  const headers = stripPlatformHeaders(request.headers);
  headers.delete(NEXT_DATA_HEADER);
  if (isPagesDataRequestPath(basePath, url.pathname)) {
    headers.set(NEXT_DATA_HEADER, '1');
  }
  return headers;
}

/**
 * Whether a rule is a redirect `next build` writes itself: one that gives a path the trailing slash
 * the application keeps, or takes away the one it does not. Its routes manifest marks them
 * `internal`, and the routing it hands an adapter marks them `priority` — as it does a header rule
 * of its own (`Service-Worker-Allowed`), which is not one of them and stays where it is.
 */
function isInternal(route: Route): boolean {
  return route.priority === true && route.status !== undefined;
}

/**
 * The routing tables as `@next/routing` takes them, with the middleware left out when told to,
 * and without the rules `next build` writes itself, in an application with `i18n` — those are
 * answered ahead of it (`internalRedirect`) — and for a Pages Router data request.
 *
 * Next.js matches those against a data request's own path, which a page's never is: the slash
 * redirects leave a `.json` alone, and where a middleware has the path normalized to the page's
 * first, it gets its trailing slash back where the application keeps one (`maybeAddTrailingSlash`,
 * `resolve-routes.ts`). `@next/routing` normalizes it to the page's without the slash and matches
 * them on that: every data request of an application with `trailingSlash` was redirected to the
 * page's document, and each client navigation became a full page load
 * (`middleware-trailing-slash`).
 */
export function routingTables(store: Store, skipMiddleware: boolean, url: URL): RoutingTables {
  const { routing, config } = store.manifest;
  const internalLeftOut =
    (config.i18n !== null && config.i18n !== undefined) ||
    isPagesDataRequestPath(config.basePath, url.pathname);
  return {
    beforeMiddleware: markedRewrites(
      routingRoutes(
        internalLeftOut
          ? routing.beforeMiddleware.filter((route) => !isInternal(route))
          : routing.beforeMiddleware,
      ),
      BEFORE_MIDDLEWARE,
    ),
    middlewareMatchers: skipMiddleware ? [] : routingRoutes(routing.middlewareMatchers),
    beforeFiles: markedRewrites(routingRoutes(routing.beforeFiles), BEFORE_FILES),
    afterFiles: markedRewrites(routingRoutes(routing.afterFiles), AFTER_FILES),
    dynamicRoutes: routingRoutes(store.dynamicRoutes),
    onMatch: routingRoutes(routing.onMatch),
    fallback: markedRewrites(routingRoutes(routing.fallback), FALLBACK),
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

/**
 * The kind of entrypoint that answers a route: its own, or, for a member of a route the build
 * closed — which resolves by its own name and names no entrypoint — the route it was built from.
 */
function answeringKind(store: Store, route: string): EntrypointKind | undefined {
  return entrypointKindOf(store, store.prerendersByPathname.get(route)?.route ?? route);
}

/**
 * What a route answered, under the status a middleware rewrote the request with.
 *
 * Next.js's router puts a middleware's status on the response before the route renders
 * (`res.statusCode = middlewareRes.status`, in `resolve-routes.ts`), and a render that sets none
 * of its own leaves it there: `NextResponse.rewrite(url, { status: 404 })` to the not-found page
 * is answered 404. `@next/routing` reads no status off a rewrite, and the page's own 200 went out
 * (`app-dir/not-found-non-document-dynamic`).
 *
 * A route handler renders nothing: the `Response` it returns is sent as it is, its status over
 * whatever was on the response (`sendResponse`), so a 200 it answers with stays a 200.
 */
export function withRewriteStatus(
  store: Store,
  route: string,
  response: Response,
  status: number | undefined,
): Response {
  if (
    status === undefined ||
    response.status !== HTTP_OK ||
    answeringKind(store, route) === 'app-route'
  ) {
    return response;
  }
  if (!NULL_BODY_STATUSES.has(status)) {
    return new Response(response.body, { status, headers: response.headers });
  }
  releaseStream(response.body, 'rewrite status: no body');
  return new Response(null, { status, headers: response.headers });
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

type Config = Store['manifest']['config'];

/** Next.js's `pathHasPrefix`, for a pathname. */
function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Next.js's `removePathPrefix`, for a pathname. */
function withoutPrefix(pathname: string, prefix: string): string {
  if (!hasPrefix(pathname, prefix)) {
    return pathname;
  }
  const rest = pathname.slice(prefix.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Next.js's `addPathPrefix`, for a pathname. */
function withPrefix(pathname: string, prefix: string): string {
  return prefix !== '' && pathname.startsWith('/') ? `${prefix}${pathname}` : pathname;
}

/** A path given the trailing slash where the application keeps one (`maybeAddTrailingSlash`). */
function slashed(config: Config, pathname: string): string {
  return config.trailingSlash && config.skipProxyUrlNormalize !== true && !pathname.endsWith('/')
    ? `${pathname}/`
    : pathname;
}

/**
 * The path Next.js's router routes in an application with `i18n`: the path asked for, with the
 * default locale put in front of it when it names no locale (`resolve-routes.ts`).
 */
function localizedPathname(
  config: Config,
  locales: string[],
  defaultLocale: string,
  path: string,
): string {
  const { basePath } = config;
  const underBase = hasPrefix(path, basePath);
  const initial = normalizeLocalePath(
    basePath !== '' && underBase ? withoutPrefix(path, basePath) : path,
    locales,
  );
  if (initial.detectedLocale !== undefined || initial.pathname.startsWith('/_next/')) {
    return path;
  }
  const locale = `/${defaultLocale}`;
  const localized = withPrefix(
    initial.pathname === '/' ? locale : `${locale}${initial.pathname}`,
    underBase ? basePath : '',
  );
  return path.endsWith('/') ? slashed(config, localized) : localized;
}

/**
 * The path Next.js's router matches a rule it marks `internal` against, in an application with
 * `i18n` (`handleRoute`): the path it routes, with the default locale taken out again. `/about/`
 * and `/en-US/about/` are both `/about/`, and the root is the root.
 */
export function internalPathname(config: Config, i18n: RoutingI18n, url: URL): string {
  const { basePath } = config;
  const defaultLocale =
    detectDomainLocale(i18n.domains, url.hostname)?.defaultLocale ?? i18n.defaultLocale;
  const routed = localizedPathname(config, i18n.locales, defaultLocale, url.pathname);
  const bare = basePath === '' ? routed : withoutPrefix(routed, basePath);
  // The base path the routed path was under, which comes back once the locale is out.
  const base = bare === routed ? '' : basePath;
  const { pathname, detectedLocale } = normalizeLocalePath(bare, i18n.locales);
  const isDefault = detectedLocale === defaultLocale;
  if (!isDefault && base === '') {
    return routed;
  }
  const rest = isDefault ? pathname : bare;
  const matched = rest === '/' && base !== '' ? base : withPrefix(rest, base);
  return routed.endsWith('/') ? slashed(config, matched) : matched;
}

/**
 * Next.js's own trailing-slash redirect for a request to an application with `i18n`, matched where
 * its router matches it.
 *
 * `@next/routing` matches every rule against the path it routes, which has the default locale put
 * in front of it — the root's own slash kept behind the locale (16.3.6, and 16.4.0-canary.41 the
 * same). The redirect `next build` writes for a path ending in a slash then sent `/`, as
 * `/en-US/`, to `/en-US`: every visit to the home page was a redirect first. And it sent `/about/`
 * to `/en-US/about`, where Next.js sends it to `/about`. Next.js matches the rules it writes itself
 * with the default locale taken out (`internalPathname`), so they are left out of what
 * `@next/routing` is handed (`routingTables`) and matched here first, as Next.js matches them ahead
 * of everything but the header rules, whose headers a redirect does not carry.
 */
export async function internalRedirect(
  store: Store,
  url: URL,
  headers: Headers,
): Promise<Response | undefined> {
  const { routing, config, buildId } = store.manifest;
  const { i18n } = config;
  if (i18n === null || i18n === undefined) {
    return undefined;
  }
  const internal = routing.beforeMiddleware.filter((route) => isInternal(route));
  if (internal.length === 0) {
    return undefined;
  }
  const pathname = internalPathname(config, routingI18n(i18n), url);
  const routed = await resolveRoutes({
    url: new URL(`${pathname}${url.search}`, url),
    buildId,
    basePath: config.basePath,
    requestBody: new ReadableStream(),
    headers,
    pathnames: [],
    routes: {
      beforeMiddleware: routingRoutes(internal),
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
    },
    invokeMiddleware: () => Promise.resolve({}),
  });
  const location = routed.resolvedHeaders?.get('location') ?? undefined;
  return location === undefined || routed.status === undefined
    ? undefined
    : redirectResponse(location, routed.status, undefined);
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

/** `pathname` with `prefix` taken off its front, when it is there. */
function withoutPathPrefix(pathname: string, prefix: string | undefined): string {
  return prefix !== undefined &&
    prefix !== '' &&
    (pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? pathname.slice(prefix.length)
    : pathname;
}

/**
 * Whether Next.js answers a miss for this request in plain text rather than with the not-found
 * page (`server/lib/router-server.ts`): a file under `_next/static`, which no page stands in for —
 * behind the asset prefix, which Next.js's own rewrite takes off the path as the request spelled
 * it, base path and all, or else behind the base path — and a read by something that could not
 * show a page if it got one — an image, a script, a font (`isNonHtmlSecFetchDest`).
 */
export function missesInPlainText(
  request: Request,
  at: URL,
  config: { readonly basePath: string; readonly assetPrefix?: string | undefined },
): boolean {
  const unprefixed = withoutPathPrefix(at.pathname, config.assetPrefix);
  const file =
    unprefixed === at.pathname ? withoutPathPrefix(at.pathname, config.basePath) : unprefixed;
  if (file.startsWith(STATIC_ASSETS_PREFIX)) {
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
 * The pathnames the router resolves by name for a request: the store's, each with its escaped
 * spellings (`namesWithSpellings`), and the request's own spelling of one of them escaped
 * (`escapedNameOf`); a spelling resolves to the name it spells (`resolvedOf`). Next.js's
 * filesystem check looks a path up as it came and then decoded (`getItem`); `@next/routing`
 * matches the names it is handed as they are, so a member of a route built with
 * `dynamicParams = false`, which resolves by its own name alone, asked for escaped —
 * `/sticks%20%26%20stones`, `/%E8%A8%98%E4%BA%8B` — answered 404 (`prerender-encoding`).
 */
export function pathnamesFor(store: Store, url: URL): string[] {
  const names = namesWithSpellings(store);
  return escapedNameOf(store, url.pathname) === undefined || names.includes(url.pathname)
    ? names
    : [...names, url.pathname];
}

/** A route's own name in brackets (`/[id]`), which only a dynamic route resolves to. */
function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

/** What `@next/routing` writes into a dynamic route's destination for its parameters. */
const ROUTE_PARAM_PREFIXES = ['nxtP', 'nxtI'];
/** The Pages Router's kinds of route, whose `query` holds the parameters a rewrite named. */
const PAGES_ROUTER: ReadonlySet<string> = new Set(['pages', 'pages-api']);

/**
 * The route a rewrite landed on, where `@next/routing` let a dynamic route claim a page of the
 * build's own.
 *
 * After a `next.config` rewrite, `@next/routing` asks its dynamic routes before the pathnames the
 * build named (`checkDynamicRoutes` ahead of `matchesPathname`, in its `afterFiles` and `fallback`
 * phases; the latest canary too). Next.js's own router looks the rewritten path up in the
 * filesystem first, and only then among the dynamic routes. So a rewrite of `/rewrite-1` to
 * `/ssr-page` was answered by `pages/[id].js`, which matches `/ssr-page` as well. A path that names
 * a page of its own — an entrypoint, or a file the build wrote for a page — is that page, and the
 * parameters the dynamic route wrote into the query are no parameters of it.
 */
export function landedRoute(
  store: Store,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
): {
  readonly route: string;
  readonly target: NonNullable<ResolveRoutesResult['invocationTarget']>;
} {
  // By the name the build gave it: a rewrite's destination may spell it escaped (`/hello%20world`).
  const spelled = withoutTrailingSlash(target.pathname);
  const page = escapedNameOf(store, spelled) ?? spelled;
  if (
    !isTemplate(route) ||
    isTemplate(page) ||
    (entrypointKindOf(store, page) === undefined && !store.staticFiles.has(page))
  ) {
    return { route, target };
  }
  const query = Object.fromEntries(
    Object.entries(target.query).filter(([key]) =>
      ROUTE_PARAM_PREFIXES.every((prefix) => !key.startsWith(prefix)),
    ),
  );
  return { route: page, target: { ...target, query } };
}

/**
 * The URL a route's handler is handed: the one routing ended on, unless the request was rewritten
 * to a route that runs code. Each such handler reads the URL the client asked for, as a platform
 * that rewrites ahead of it hands it over: a page of the Pages Router its `asPath` and `req.url`,
 * an App Router page the URL it renders as its own — what `usePathname` says, and the router's
 * canonical URL (`renderToHTMLOrFlight`) — and a route handler its request's. Handed the
 * destination, a page showed the rewrite's target where Next.js shows its source (`app-dir/hooks`,
 * "should have the canonical url pathname on rewrite"). What the build keeps the route's output
 * under is named off the route itself either way (`resolvedPathname`, in `RouteModule.prepare`).
 *
 * A `next.config` rewrite the handler applies again itself, to that URL (`handleRewrites`, in
 * `RouteModule.prepare`), so it is handed that URL as it came — an App Router route with the
 * route's parameters after it (`withRouteParameters`). A middleware's it cannot, so the path asked
 * for comes with the query routing ended on: what the middleware added, and the route's
 * parameters, which the handler takes from the query and leaves out of `req.url` (`nxtP…`,
 * `normalizeCdnUrl`) — "deployed proxies include query values added while resolving rewrites in
 * the URL passed to the function" (`middleware-rewrites`). A data request's URL is the build's to
 * name (`servePagesData`).
 *
 * A member of a route the build closed resolves by its own name, which names no entrypoint: the
 * route it was built from does, and that is the page whose handler is asked.
 */
function handlerUrl(
  store: Store,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
  asked: Asked,
): string {
  const routed = `${target.pathname}${queryString(target.query)}`;
  const { url } = asked;
  const kind = answeringKind(store, route);
  if (
    kind === undefined ||
    url.pathname === target.pathname ||
    isPagesDataRequestPath(store.manifest.config.basePath, url.pathname)
  ) {
    return routed;
  }
  if (asked.rewrite !== undefined) {
    const query = routeQuery(store, route, target, withoutTrailingSlash(target.pathname));
    return `${inLocaleOf(store, url.pathname, target.pathname)}${queryString(query)}`;
  }
  return PAGES_ROUTER.has(kind)
    ? `${url.pathname}${url.search}`
    : `${url.pathname}${withRouteParameters(
        url.search,
        routeQuery(store, route, target, withoutTrailingSlash(target.pathname)),
      )}`;
}

/**
 * The query asked for, with the route's parameters as routing ended on (`nxtP…`, `nxtI…`) after
 * it, the query itself left as it was spelled.
 *
 * An App Router route that a `next.config` rewrite led to applies the rewrite again, and the
 * rewrite puts the dynamic route's parameters in the query it renders (`handleRewrites`, in
 * `server-utils.ts`), which is its `searchParams`. It takes them out again only for the parameters
 * the platform handed it as `nxtP…` (`RouteModule.prepare`, "Remove any normalized params from the
 * query"), so without them a page's `searchParams` said its own `params` as well
 * (`app-dir/rewrite-with-search-params`).
 */
function withRouteParameters(search: string, query: Record<string, string | string[]>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const items = Array.isArray(value) ? value : [value];
    if (ROUTE_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      for (const item of items) {
        parameters.append(key, item);
      }
    }
  }
  const added = parameters.toString();
  if (added === '') {
    return search;
  }
  return search === '' ? `?${added}` : `${search}&${added}`;
}

/**
 * The path asked for, in the locale a middleware rewrote it to. The handler reads the locale off
 * the path it is handed (`RouteModule.prepare`), and a rewrite into another one — `url.locale =
 * 'es'` — rendered in the locale the client asked in (`middleware-rewrites`, "should allow to
 * rewrite to a different locale").
 */
function inLocaleOf(store: Store, asked: string, target: string): string {
  const { i18n, basePath } = store.manifest.config;
  if (i18n === null || i18n === undefined) {
    return asked;
  }
  const bare = (pathname: string): string =>
    basePath === '' ? pathname : withoutPrefix(pathname, basePath);
  const { detectedLocale } = normalizeLocalePath(bare(target), i18n.locales);
  if (detectedLocale === undefined) {
    return asked;
  }
  const rest = normalizeLocalePath(bare(asked), i18n.locales).pathname;
  return withPrefix(`/${detectedLocale}${rest === '/' ? '' : rest}`, basePath);
}

/** The URL a request was asked by, and the one a middleware rewrote it to, if it did. */
export interface Asked {
  readonly url: URL;
  readonly rewrite: URL | undefined;
}

/**
 * What a request was asked by (`Asked`). The Function's own middleware says where it rewrote the
 * request as it runs (`rewrite`); one the edge ran has sent the request on to where it rewrote it,
 * with the URL the client asked for beside it (`x-arkor-original-url`, which is `initURL`).
 */
export function askedOf(
  request: Request,
  initURL: string,
  url: URL,
  rewrite: URL | undefined,
): Asked {
  if (rewrite !== undefined || !request.headers.has(ORIGINAL_URL_HEADER)) {
    return { url, rewrite };
  }
  return { url: new URL(initURL), rewrite: url };
}

/**
 * What routing resolved, as the build filed it. A page resolved under its spelling with a trailing
 * slash is that page. Whatever it resolved to, the URL is looked up without a trailing slash, as
 * Next.js names what it builds and keeps (`removeTrailingSlash`, in `RouteModule.prepare`): a
 * member of a dynamic route asked for as `/en/legacy/` is the build's `/en/legacy`, its shell and
 * its generations. One asked for escaped is looked up by the name its prerender was given
 * (`prerenderedName`). The handler is still handed the URL as it was asked for.
 */
export function resolvedOf(
  store: Store,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
  asked: Asked,
): Resolved {
  // Unescaped before the slash is taken off: an escaped spelling of a page kept behind a trailing
  // slash (`/about%20us/`) is that slash spelling (`/about us/`) first.
  const unescaped = escapedNameOf(store, route) ?? route;
  const page = store.slashSpellings.get(unescaped) ?? unescaped;
  return {
    route: page,
    pathname: prerenderedName(store, withoutTrailingSlash(target.pathname)),
    url: handlerUrl(store, page, target, asked),
  };
}
