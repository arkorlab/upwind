import { isImmutableAssetPath } from '../assets/admission.ts';
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
  NAVIGATION_REQUEST_HEADERS,
  NEXT_ACTION_HEADER,
  NEXT_RESUME_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  RSC_CACHE_BUSTING_QUERY,
  RSC_HEADER,
  SKEW_PROTECTION_COOKIE,
} from './constants.ts';
import { parseCookieHeader } from './cookies.ts';

export type PassthroughReason =
  | 'method'
  | 'head'
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
const DPL_MISMATCH: PassthroughReason = 'dpl-mismatch';

function passthrough(reason: PassthroughReason): RequestClass {
  return { kind: 'passthrough', reason };
}

function hasInternalDocumentHeader(headers: Headers): boolean {
  for (const [name] of headers) {
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
  if (method === 'HEAD') {
    return passthrough('head');
  }
  if (method !== 'GET') {
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
  if (
    headers.has(RSC_HEADER) ||
    headers.has(NEXT_ROUTER_PREFETCH_HEADER) ||
    headers.has(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER) ||
    headers.has(NEXT_ROUTER_STATE_TREE_HEADER) ||
    headers.has(NEXT_ACTION_HEADER)
  ) {
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

/** What a browser puts on a top-level navigation, and what nothing else sends. */
const NAVIGATION_FETCH_MODE = NAVIGATION_REQUEST_HEADERS['sec-fetch-mode'];

/**
 * A navigation the browser made on a guess — a prefetch or a prerender, which says so in
 * `sec-purpose` (`PREFETCH_HINT_HEADERS`) — is one all the same, and is served as one. A browser
 * adopts such a load still in flight as the navigation when the visitor follows the link, so its
 * first byte is that navigation's; and Next.js answers it as it answers any other. A
 * `<link rel=prefetch>` is not a navigation at all, and says so in `sec-fetch-dest`.
 */
function classifyByNavigationHints(headers: Headers): RequestClass | undefined {
  if (headers.get('sec-fetch-dest') !== DOCUMENT_FETCH_DESTINATION) {
    return passthrough('sec-fetch-dest');
  }
  if (headers.get('sec-fetch-mode') !== NAVIGATION_FETCH_MODE) {
    return passthrough('sec-fetch-mode');
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
  const early =
    classifyStaticFile(input) ??
    classifyByMethod(input.method, headers) ??
    (headers.has('service-worker') ? passthrough('service-worker') : undefined) ??
    (headers.has('range') ? passthrough('range') : undefined) ??
    classifyByPath(url) ??
    classifyByRouterHeaders(headers);
  if (early !== undefined) {
    return early;
  }
  if (hasInternalDocumentHeader(headers)) {
    return passthrough('internal-header');
  }
  const late =
    classifyByCookies(headers, input.deployment) ?? classifyByQuery(url, headers, input.deployment);
  if (late !== undefined) {
    return late;
  }
  // What a browser puts on a top-level navigation is asked only of one. A prefetch is fetched by
  // the router rather than navigated to, so it carries none of those hints and every one of them
  // would turn it away.
  const segmentPath = segmentPrefetchOf(headers);
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
  const blocking = blockingMetadataReason(entry, headers.get('user-agent'), input.manifest);
  if (blocking !== undefined) {
    return passthrough(blocking);
  }
  return entry === undefined ? passthrough('route-not-proved') : { kind: 'document', entry };
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
