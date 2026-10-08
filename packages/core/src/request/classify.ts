import { isImmutableAssetPath } from '../assets/admission.ts';
import { pageOfPagesData } from '../bundle/pages-data.ts';
import type { DeploymentFingerprint } from '../deployment/fingerprint.ts';
import {
  findRouteEntry,
  findStaticFile,
  isExactPathname,
  isReserved,
  matchDynamicRoute,
  type RouteEntry,
  type ProjectManifest,
  type StaticFileEntry,
} from '../manifest/index.ts';
import { acceptsHtml } from './accept.ts';
import { blockingMetadataReason } from './blocking-metadata.ts';
import {
  BYPASS_COOKIE_NAMES,
  BYPASS_QUERY_KEYS,
  BYPASS_QUERY_PREFIXES,
  DEPLOYMENT_ID_QUERY,
  DEPLOYMENT_ID_REQUEST_HEADER,
  INTERNAL_REQUEST_HEADERS,
  isBotUserAgent,
  NAVIGATION_REQUEST_HEADERS,
  NEXT_ACTION_HEADER,
  NEXT_DATA_HEADER,
  NEXT_RESUME_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  PREFETCH_HINT_HEADERS,
  ROUTER_REQUEST_HEADERS,
  RSC_CACHE_BUSTING_QUERY,
  RSC_HEADER,
  SKEW_PROTECTION_COOKIE,
} from './constants.ts';
import { parseCookieHeader } from './cookies.ts';
import { dataRequestHeaders } from './headers.ts';

export type PassthroughReason =
  | 'method'
  | 'service-worker'
  | 'range'
  | 'well-known'
  | 'next-internal'
  | 'router-header'
  | 'internal-header'
  | 'bot'
  | 'html-limited-bots'
  | 'bypass-cookie'
  | 'vdpl-mismatch'
  | 'cookie'
  | 'bypass-query'
  | 'dpl-mismatch'
  | 'sec-fetch-dest'
  | 'sec-fetch-mode'
  | 'accept'
  | 'no-manifest'
  | 'repeated-slash'
  | 'route-not-proved';

export type RequestClass =
  /** `entry.pathname` is the manifest key: the pathname itself, or the template of its class. */
  | { readonly kind: 'document'; readonly entry: RouteEntry }
  | { readonly kind: 'immutable-asset-candidate'; readonly originUrl: URL }
  /** A file the manifest holds by content: served from storage, and nobody is asked. */
  | { readonly kind: 'static-file'; readonly pathname: string; readonly file: StaticFileEntry }
  | { readonly kind: 'rsc' }
  /**
   * A router prefetch of part of a page: `segmentPath` is the `next-router-segment-prefetch` it
   * asks under, and `entry` the route it belongs to — `undefined` where the build proved none, as
   * it is for a document at a pathname the build never wrote.
   */
  | {
      readonly kind: 'segment-prefetch';
      readonly segmentPath: string;
      readonly entry: RouteEntry | undefined;
    }
  /**
   * A router's request for the whole payload of a page, at a route whose payload the build wrote
   * whole (`RouteEntry.payload`): `entry` is the route its URL names. Any other request for React
   * Server Components is `rsc`, as every one was before.
   */
  | { readonly kind: 'rsc-payload'; readonly entry: RouteEntry }
  /**
   * A Pages Router client's request for a page's props, at a page whose props the build wrote
   * (`RouteEntry.pagesData`): `entry` is that page's route. Any other `/_next/data` request is the
   * Function's, as every one was before.
   */
  | { readonly kind: 'pages-data'; readonly entry: RouteEntry }
  | { readonly kind: 'action' }
  | { readonly kind: 'passthrough'; readonly reason: PassthroughReason };

export interface ClassifyInput {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly manifest: ProjectManifest | undefined;
  readonly deployment: DeploymentFingerprint | undefined;
}

/**
 * Only a top-level document is served from the edge, and only when the client says it is one.
 *
 * Recovery from a failed continuation reloads with a `SameSite=Lax` cookie, and a cross-site frame
 * sends neither that cookie nor, increasingly, any third-party cookie at all: the reload would hit
 * the same splice and the loop guard would then leave the frame on a truncated document. An
 * embedded document is proxied instead, which costs it the shell but never breaks it. A request
 * with no `sec-fetch-dest` at all is not a browser navigation either (every current browser sends
 * it), so it gets the same treatment, as does one whose `sec-fetch-mode` is not `navigate`: the
 * proof was taken as a navigation, and a client that does not say what it is fetching is one the
 * proof did not cover.
 */
const DOCUMENT_FETCH_DESTINATION = NAVIGATION_REQUEST_HEADERS['sec-fetch-dest'];
const DOCUMENT_REQUEST_INTERNAL_HEADERS: ReadonlySet<string> = new Set([
  DEPLOYMENT_ID_REQUEST_HEADER,
  NEXT_RESUME_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  ...INTERNAL_REQUEST_HEADERS.filter((name) => name !== 'host' && name !== 'x-real-ip'),
]);
const DOCUMENT_REQUEST_INTERNAL_PREFIXES: readonly string[] = ['x-middleware-', 'x-prerender-'];

const BYPASS_QUERY: PassthroughReason = 'bypass-query';
const RSC_CLASS = 'rsc';
const DPL_MISMATCH: PassthroughReason = 'dpl-mismatch';

function passthrough(reason: PassthroughReason): RequestClass {
  return { kind: 'passthrough', reason };
}

/**
 * A request of the client's router — a prefetch of part of a page, or a request for its whole
 * payload — has `x-deployment-id` let through, for `classifyByDeploymentHeader` to judge: on such a
 * request it is the router saying which deployment it is running, not a platform's header.
 * Next.js's router sends it with every request it makes once the build has a deployment id
 * (`createFetch`, `fetch-server-response.ts`), so read as internal it turned every prefetch a
 * browser makes away from the edge, and the parts of pages the build wrote were only ever answered
 * by the Function.
 */
function hasInternalDocumentHeader(
  headers: Headers,
  fromRouter: boolean,
  pagesData = false,
): boolean {
  for (const [name] of headers) {
    if (fromRouter && name === DEPLOYMENT_ID_REQUEST_HEADER) {
      continue;
    }
    // The Pages Router's client marks every request for a page's props so (`x-nextjs-data`).
    if (pagesData && name === NEXT_DATA_HEADER) {
      continue;
    }
    if (DOCUMENT_REQUEST_INTERNAL_HEADERS.has(name)) {
      return true;
    }
    if (DOCUMENT_REQUEST_INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

function classifyByMethod(method: string, headers: Headers): RequestClass | undefined {
  if (method === 'POST' && headers.has(NEXT_ACTION_HEADER)) {
    return { kind: 'action' };
  }
  // `HEAD` asks what `GET` asks, and is answered with the headers `GET` would carry and no body
  // (RFC 9110 §9.3.2). Next.js routes it as it routes `GET`, the middleware included, so it is
  // classified as `GET` is, and whatever answers it leaves the body off.
  if (method !== 'GET' && method !== 'HEAD') {
    return passthrough('method');
  }
  return undefined;
}

function classifyByPath(url: URL): RequestClass | undefined {
  const { pathname } = url;
  if (pathname.startsWith('/.well-known/')) {
    return passthrough('well-known');
  }
  if (pathname.startsWith('/_next/static/')) {
    if (isImmutableAssetPath(pathname, url.searchParams)) {
      return { kind: 'immutable-asset-candidate', originUrl: url };
    }
    return passthrough('next-internal');
  }
  if (pathname.startsWith('/_next/')) {
    return passthrough('next-internal');
  }
  return undefined;
}

/**
 * The part of a page a router prefetch asks for, or `undefined` for a request asking for none.
 *
 * A header that is present and empty names no part. Next.js writes every segment path with a
 * leading slash, so nothing a build wrote could be found under the empty string, and saying so here
 * keeps the classification from carrying a path no route could hold. Such a request is then read as
 * the plain RSC request it is, and reaches the application as one.
 */
function segmentPrefetchOf(headers: Headers): string | undefined {
  if (headers.get(RSC_HEADER) !== '1') {
    return undefined;
  }
  const segmentPath = headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER);
  return segmentPath === null || segmentPath === '' ? undefined : segmentPath;
}

function classifyByRouterHeaders(headers: Headers): RequestClass | undefined {
  if (headers.get(RSC_HEADER) === '1') {
    // A segment prefetch is classified further down, with the route it is part of: it names one,
    // and every gate a document passes on the way there is its gate too — a draft cookie, a
    // deployment that is not the one being served. Anything else asking for React Server
    // Components names no route of its own and is the application's to answer.
    return segmentPrefetchOf(headers) === undefined ? { kind: 'rsc' } : undefined;
  }
  // The one list, read here and by `mayHoldForDocument`: a header this lets through to a document
  // is one a rule may ask for of a document.
  if (ROUTER_REQUEST_HEADERS.some((name) => headers.has(name))) {
    return passthrough('router-header');
  }
  return undefined;
}

/**
 * Whether these headers put Next.js into draft mode. Such a request is the application's: what
 * it asks for is the page rendered now, not anything the build wrote. Read of a client's own
 * request by the classification, and again of the request the application's middleware left
 * behind, which is free to set the cookie itself.
 */
export function hasBypassCookie(headers: Headers): boolean {
  const cookieHeader = headers.get('cookie');
  if (cookieHeader === null) {
    return false;
  }
  return parseCookieHeader(cookieHeader).some((pair) => BYPASS_COOKIE_NAMES.includes(pair.name));
}

/**
 * Cookies a shell may be served alongside: every one of them, bar the bypass names and a `__vdpl`
 * that asks for another deployment.
 *
 * An application's shell came out of its build, where anything that reads a cookie is rendered
 * after the shell by construction, and what a cookie decides about the route — a redirect, a
 * rewrite — the edge learns by running the application's own middleware first. So nothing here
 * judges a cookie by name.
 */
function classifyByCookies(
  headers: Headers,
  deployment: DeploymentFingerprint | undefined,
): RequestClass | undefined {
  const cookieHeader = headers.get('cookie');
  if (cookieHeader === null) {
    return undefined;
  }
  const pairs = parseCookieHeader(cookieHeader);
  // Read off what is already parsed, which `hasBypassCookie` parses for itself elsewhere.
  if (pairs.some((pair) => BYPASS_COOKIE_NAMES.includes(pair.name))) {
    return passthrough('bypass-cookie');
  }
  // Every occurrence has to name the deployment being served, since the application may read any
  // of them; one that names another is asking for a deployment this manifest is not.
  const pinned = pairs.every(
    (pair) => pair.name !== SKEW_PROTECTION_COOKIE || pair.value === deployment?.dplId,
  );
  return pinned ? undefined : passthrough('vdpl-mismatch');
}

/**
 * Query keys a shell may be served alongside: every one of them, bar the keys that name a
 * different kind of response (RSC, draft mode, a route parameter) and a `dpl` naming another
 * deployment.
 */
function classifyByQuery(
  url: URL,
  headers: Headers,
  deployment: DeploymentFingerprint | undefined,
): RequestClass | undefined {
  const params = url.searchParams;
  if (params.has(RSC_CACHE_BUSTING_QUERY) && headers.get(RSC_HEADER) !== '1') {
    return passthrough(BYPASS_QUERY);
  }
  const keys = [...params.keys()];
  if (
    BYPASS_QUERY_KEYS.some((key) => params.has(key)) ||
    keys.some((key) => BYPASS_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix)))
  ) {
    return passthrough(BYPASS_QUERY);
  }
  const dpls = params.getAll(DEPLOYMENT_ID_QUERY);
  if (dpls.some((value) => value !== deployment?.dplId)) {
    return passthrough(DPL_MISMATCH);
  }
  return undefined;
}

/**
 * The deployment the client's router says it is running, judged as a `dpl` is: the one being
 * served, or the Function's to answer. A repeated header is one value to `Headers`, joined, and
 * names no deployment. Asked only of a router's request (`hasInternalDocumentHeader`); of anything
 * else the header is internal, and was turned away before this.
 */
function classifyByDeploymentHeader(
  headers: Headers,
  fromRouter: boolean,
  deployment: DeploymentFingerprint | undefined,
): RequestClass | undefined {
  const named = fromRouter ? headers.get(DEPLOYMENT_ID_REQUEST_HEADER) : null;
  return named === null || named === deployment?.dplId ? undefined : passthrough(DPL_MISMATCH);
}

/**
 * What a request's cookies, its query and — on a router's request — its `x-deployment-id` ask for
 * that the deployment being served may not hold: draft mode, another kind of response, another
 * deployment.
 */
function classifyByPins(
  url: URL,
  headers: Headers,
  fromRouter: boolean,
  deployment: DeploymentFingerprint | undefined,
): RequestClass | undefined {
  return (
    classifyByCookies(headers, deployment) ??
    classifyByQuery(url, headers, deployment) ??
    classifyByDeploymentHeader(headers, fromRouter, deployment)
  );
}

/** What a browser puts on a top-level navigation, and what nothing else sends. */
const NAVIGATION_FETCH_MODE = NAVIGATION_REQUEST_HEADERS['sec-fetch-mode'];
const FETCH_DEST_HEADER = 'sec-fetch-dest';
const FETCH_MODE_HEADER = 'sec-fetch-mode';

/**
 * A crawler's own fetch of a page: an agent that names a crawler, with no Fetch Metadata at all.
 * A crawler is no browser and sends none — Googlebot's crawl fetch, whose document its renderer
 * then runs, among them — so the metadata a browser's navigation carries cannot tell it apart.
 */
function crawlerFetch(headers: Headers): boolean {
  const userAgent = headers.get('user-agent');
  return (
    userAgent !== null &&
    !headers.has(FETCH_DEST_HEADER) &&
    !headers.has(FETCH_MODE_HEADER) &&
    isBotUserAgent(userAgent)
  );
}

/** What a resource fetched with no CORS says of itself: what a page's prefetch says, in Firefox. */
const RESOURCE_FETCH_DESTINATION = 'empty';
const NO_CORS_FETCH_MODE = 'no-cors';
const PREFETCH_PURPOSE = 'prefetch';

/**
 * A page prefetched with the metadata of a resource rather than a navigation's: it says it is a
 * prefetch (`PREFETCH_HINT_HEADERS`), with `sec-fetch-dest: empty` and `sec-fetch-mode: no-cors`.
 * Firefox sends a speculation rule's prefetch so (Mozilla bug 2074629: the specification has it
 * say `document` and `navigate`), as browsers send a `<link rel=prefetch>`. A browser adopts either
 * as the navigation the visitor then makes, so it is taken for that navigation; whether it is for
 * a document at all is still for the accept header to say.
 */
function prefetchAsResource(headers: Headers): boolean {
  return (
    headers.get(FETCH_DEST_HEADER) === RESOURCE_FETCH_DESTINATION &&
    headers.get(FETCH_MODE_HEADER) === NO_CORS_FETCH_MODE &&
    PREFETCH_HINT_HEADERS.some(
      (name) => headers.get(name)?.toLowerCase().includes(PREFETCH_PURPOSE) === true,
    )
  );
}

/**
 * A top-level navigation by what a browser says of it, or a crawler's fetch of the page
 * (`crawlerFetch`), taken for one by its agent. Whether a crawler is then served the shell is for
 * its blocking metadata to say (`blockingMetadataReason`): Googlebot is streamed to, as Next.js
 * streams to it, and a crawler on the HTML-limited list is passed on.
 *
 * A navigation the browser made on a guess — a prefetch or a prerender, which says so in
 * `sec-purpose` (`PREFETCH_HINT_HEADERS`) — is one all the same, and is served as one. A browser
 * adopts such a load still in flight as the navigation when the visitor follows the link, so its
 * first byte is that navigation's; and Next.js answers it as it answers any other. So is a page's
 * prefetch that says what a resource fetch does (`prefetchAsResource`).
 */
function classifyByNavigationHints(headers: Headers): RequestClass | undefined {
  if (crawlerFetch(headers) || prefetchAsResource(headers)) {
    return acceptsHtml(headers.get('accept')) ? undefined : passthrough('accept');
  }
  if (headers.get(FETCH_DEST_HEADER) !== DOCUMENT_FETCH_DESTINATION) {
    return passthrough(FETCH_DEST_HEADER);
  }
  if (headers.get(FETCH_MODE_HEADER) !== NAVIGATION_FETCH_MODE) {
    return passthrough(FETCH_MODE_HEADER);
  }
  if (!acceptsHtml(headers.get('accept'))) {
    return passthrough('accept');
  }
  return undefined;
}

const STATIC_FILE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * A file the manifest names, when the request asks for it by a deployment that built it.
 *
 * Before every other rule: the file is the same bytes for every visitor, so nothing a request
 * carries — cookies, query keys, who is asking — changes the answer. The one exception is a `dpl`
 * naming a deployment this manifest holds no build of the file for, which is asking for a file
 * this manifest may not hold. On its own as well, for the edge to ask before it has decided
 * anything else about the request.
 */
export function classifyStaticFile(
  input: Pick<ClassifyInput, 'deployment' | 'manifest' | 'method' | 'url'>,
): RequestClass | undefined {
  if (!STATIC_FILE_METHODS.has(input.method) || input.manifest === undefined) {
    return undefined;
  }
  const file = findStaticFile(input.manifest, input.url.pathname);
  if (file === undefined) {
    return undefined;
  }
  const dpls = input.url.searchParams.getAll(DEPLOYMENT_ID_QUERY);
  if (dpls.length > 1) {
    return passthrough(DPL_MISMATCH);
  }
  const build =
    dpls[0] === undefined ? file : staticFileBuild(file, dpls[0], input.deployment?.dplId);
  if (build === undefined) {
    return passthrough(DPL_MISMATCH);
  }
  return { kind: 'static-file', pathname: input.url.pathname, file: build };
}

/**
 * The file as the deployment a request names built it. A content-addressed file is the same
 * bytes whichever deployment asks for the name. Any other belongs to one deployment — the
 * manifest's own, or the one a kept file names — and the deployment before may have built the
 * same name with bytes of its own. `undefined` when the manifest holds no build of the file for
 * that deployment.
 */
function staticFileBuild(
  file: StaticFileEntry,
  dplId: string,
  activeDplId: string | undefined,
): StaticFileEntry | undefined {
  if (file.immutable || dplId === (file.deploymentId ?? activeDplId)) {
    return file;
  }
  if (file.previous?.deploymentId === dplId) {
    return { ...file.previous, immutable: file.immutable };
  }
  return undefined;
}

/**
 * Decide how the edge handles a request. Evaluated in order; the first decisive rule wins.
 * The manifest's `mode` is decided by the caller (a passthrough pointer never reaches this).
 */
export function classifyRequest(input: ClassifyInput): RequestClass {
  const { headers, url } = input;
  const early = classifyEarly(input);
  if (early !== undefined) {
    return early;
  }
  const segmentPath = segmentPrefetchOf(headers);
  if (hasInternalDocumentHeader(headers, segmentPath !== undefined)) {
    return passthrough('internal-header');
  }
  const late = classifyByPins(url, headers, segmentPath !== undefined, input.deployment);
  if (late !== undefined) {
    return late;
  }
  // What a browser puts on a top-level navigation is asked only of one. A prefetch is fetched by
  // the router rather than navigated to, so it carries none of those hints and every one of them
  // would turn it away.
  const hints = segmentPath === undefined ? classifyByNavigationHints(headers) : undefined;
  if (hints !== undefined) {
    return hints;
  }
  // A prefetch of part of a page is turned away here with everything else that needed a route,
  // rather than carried on as its own class with no route to go with it. Review read that as an
  // oversight twice, so: with no manifest there is no table of parts to look one up in, so a host
  // hands the request to its Function either way, and the reason it reports is the only difference.
  // `no-manifest` is the reason that says something — the deployment has published none — where the
  // class would only repeat what the headers already said.
  if (input.manifest === undefined) {
    return passthrough('no-manifest');
  }
  // Next.js answers a path that repeats a slash with a redirect before any routing, the
  // middleware's included (`normalizeRepeatedSlashes`). Such a request names no route, and it is
  // not one to show the middleware on the chance of a rewrite either: the Function redirects it first.
  if (url.pathname.includes('//')) {
    return passthrough('repeated-slash');
  }
  const entry = entryFor(input.manifest, url, headers);
  if (segmentPath !== undefined) {
    return { kind: 'segment-prefetch', segmentPath, entry };
  }
  // Only a visitor Next.js renders a partially prerendered page whole for, by the application's
  // list or its own, is passed on here (`wantsBlockingMetadata`): any other crawler, Googlebot
  // included, is served the shell as a browser is. Asked last, of a navigation the edge would
  // otherwise answer, so the application's pattern runs for nothing else. Not of a page the build
  // finished: Next.js renders no page whole for this but a partially prerendered one, and resolves
  // a prerendered page's metadata at build time, so the finished document is what such a visitor
  // is sent either way. Of a pathname that names no proved route, though: the middleware may
  // rewrite it onto one. Under a list the edge will not run, every visitor that names an agent is
  // passed on, and says so: for the list, not for being a crawler (`blockingMetadataReason`).
  const userAgent = headers.get('user-agent');
  if (renderedWholeForCrawlers(input.manifest, entry, userAgent)) {
    return passthrough('bot');
  }
  const blocking = blockingMetadataReason(entry, userAgent, input.manifest);
  if (blocking !== undefined) {
    return passthrough(blocking);
  }
  return entry === undefined ? passthrough('route-not-proved') : { kind: 'document', entry };
}

/**
 * What the request is by what it says of itself, before any route is asked for: a file the manifest
 * holds, its method, its path, the router's headers. A request for React Server Components is then
 * asked whether it is one for a page's whole payload, which the route it names may hold.
 */
function classifyEarly(input: ClassifyInput): RequestClass | undefined {
  const { headers, url } = input;
  const early =
    classifyStaticFile(input) ??
    classifyByMethod(input.method, headers) ??
    (headers.has('service-worker') ? passthrough('service-worker') : undefined) ??
    (headers.has('range') ? passthrough('range') : undefined) ??
    pagesDataRequest(input) ??
    classifyByPath(url) ??
    classifyByRouterHeaders(headers);
  return early?.kind === RSC_CLASS ? (payloadRequest(input) ?? early) : early;
}

/**
 * A Pages Router client's request for a page's props, where the page has the ones the build wrote
 * (`RouteEntry.pagesData`), asked at the manifest's `pagesDataPrefix`: past the gates a router's
 * request passes, with the `x-nextjs-data` its client sends let through.
 *
 * Judged on the data URL itself, which is what Next.js's routing matches its rules against in a
 * build that holds such props — one with no middleware, which leaves a data URL as it is
 * (`routePagesData`) — and with the `x-nextjs-data` that routing puts on it, whatever the client
 * sent (`dataRequestHeaders`): a rule ahead of the filesystem that holds for it claims the request
 * first.
 *
 * `undefined` for any other request, which is classified as it always was: a data request for a
 * page with no props here is the Function's (`next-internal`).
 */
function pagesDataRequest(input: ClassifyInput): RequestClass | undefined {
  const { headers, url, manifest } = input;
  const prefix = manifest?.pagesDataPrefix;
  if (manifest === undefined || prefix === undefined) {
    return undefined;
  }
  const basePath = manifest.pagesDataBasePath ?? '';
  const page = pageOfPagesData(prefix, basePath, url.pathname, manifest.trailingSlash === true);
  // By the name exactly, which is the build's own (`pageOfPagesData`): decoded again, a name that
  // keeps a parameter's escaped `/` would find another page.
  const entry =
    page !== undefined && Object.hasOwn(manifest.routes, page) ? manifest.routes[page] : undefined;
  if (entry?.pagesData === undefined) {
    return undefined;
  }
  if (
    hasInternalDocumentHeader(headers, true, true) ||
    classifyByPins(url, headers, true, input.deployment) !== undefined ||
    isReserved(manifest, url, dataRequestHeaders(headers), true)
  ) {
    return undefined;
  }
  return { kind: 'pages-data', entry };
}

/**
 * A router's request for a page's whole payload, where the route its URL names has one the build
 * wrote (`RouteEntry.payload`) and nothing the request carries asks for anything else: past every
 * gate a prefetch of part of the page passes, its `x-deployment-id` judged as that prefetch's is.
 * A `HEAD` is classified as its `GET` is, as every request is (`classifyByMethod`), and left to the
 * Function where it would be answered.
 *
 * Only an exact route holds a payload (`routePayloads`), so only the exact routes are looked in, and
 * a rule ahead of the filesystem — an intercepting route's, by `next-url` — claims the page first, as
 * it claims a document's (`entryFor`). A request for React Server Components is answered with no
 * dynamic route tested against it, as it was before. Nor is one that carries a
 * `next-router-segment-prefetch` at all: an empty one names no part (`segmentPrefetchOf`), and
 * Next.js answers it as a prefetch of a part it has none of, not with the page.
 *
 * `undefined` for any other, which stays `rsc` and goes to the Function as it always did: a route
 * with no payload to serve is not run past the middleware at the edge for nothing, and a request
 * the gates turn away is reported as it was.
 */
function payloadRequest(input: ClassifyInput): RequestClass | undefined {
  const { headers, url, manifest } = input;
  if (
    manifest === undefined ||
    url.pathname.includes('//') ||
    headers.has(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
  ) {
    return undefined;
  }
  const entry = findRouteEntry(manifest, url.pathname);
  if (entry?.payload === undefined) {
    return undefined;
  }
  if (
    hasInternalDocumentHeader(headers, true) ||
    classifyByPins(url, headers, true, input.deployment) !== undefined ||
    isReserved(manifest, url, headers, true)
  ) {
    return undefined;
  }
  return { kind: 'rsc-payload', entry };
}

/**
 * Whether the build's Next.js renders this page whole for a crawler of this agent whatever its
 * list says: before 16.3, it does for every crawler on a partially prerendered page
 * (`crawlersStreamed`), and each of them is passed on, as every crawler was before. Not a page the
 * build finished, which is served whole to any agent.
 */
function renderedWholeForCrawlers(
  manifest: ProjectManifest,
  entry: RouteEntry | undefined,
  userAgent: string | null,
): boolean {
  return (
    userAgent !== null &&
    manifest.crawlersStreamed !== true &&
    entry?.cache?.delivery !== 'complete' &&
    isBotUserAgent(userAgent)
  );
}

/**
 * The route a pathname is served: an exact entry first, as Next.js resolves an exact pathname
 * first, and then, unless the pathname is one Next.js resolves exactly to something with no
 * shell, the dynamic class it belongs to.
 *
 * A page of the application is the filesystem step of Next.js's routing, so a redirect or a
 * `beforeFiles` rewrite claims its path first — the same gate a shipped file clears, and a
 * narrower one than a dynamic class clears, since an `afterFiles` rewrite runs after the
 * filesystem and not before it. Asked only of a pathname the build named, which is the only
 * kind of answer that step decides: a dynamic class carries the gate in `matchDynamicRoute`,
 * and a claimed pathname matches no class there either.
 *
 * The same route for a document and for a prefetch of part of it. A prefetch asks for a piece of
 * the page at its own URL, so the page it is a piece of is the page that URL names.
 */
function entryFor(manifest: ProjectManifest, url: URL, headers: Headers): RouteEntry | undefined {
  const exact = findRouteEntry(manifest, url.pathname);
  if (exact !== undefined && isReserved(manifest, url, headers, true)) {
    return undefined;
  }
  return exact ?? dynamicEntry(manifest, url, headers);
}

function dynamicEntry(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): RouteEntry | undefined {
  return isExactPathname(manifest, url.pathname)
    ? undefined
    : matchDynamicRoute(manifest, url, headers);
}
