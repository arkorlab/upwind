import {
  bodyHeaders,
  bodyTypeAllowed,
  edgeServableRouteBodies,
  headerRulesOf,
  htmlType,
  narrowCacheControl,
  noTransform,
  pageDataArtifact,
  pageHeaders,
  pageOfDataPathname,
  pagesDataPathnameUnder,
  type Prerender,
  staticFallbackPageFor,
  staticFallbackPagesOf,
  staticPagesPrivacyOf,
} from '@stayingupwind/core/bundle';
import {
  staticPageDataHeadersAllowSharing,
  staticPageHasNoTransform,
  staticPageHeadersAllowSharing,
} from '@stayingupwind/core/cache';
import {
  type ConfiguredHeaders,
  headerRulesFor,
  pathIsReserved,
  type ReservedRoute,
  type RouteBodyEntry,
  type StaticPageEntry,
} from '@stayingupwind/core/manifest';
import {
  dataRequestHeaders,
  hasRouteBodyControlHeader,
  NO_STORE_CACHE_CONTROL,
  NULL_BODY_STATUSES,
  PLATFORM_HEADER_PREFIX,
  policyRefusesSharing,
  removeSharedCacheOverrides,
  REVALIDATE_CACHE_CONTROL,
  SHARED_CACHE_CONTROL_HEADERS,
  unsharedUnlessPublic,
} from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import type { CurrentGeneration } from '../cache/current.ts';
import type { FirstPublish } from '../delivery.ts';
import type { Representation } from '../representations.ts';
import type { RoutedInput } from '../serve.ts';
import { getStore, type Store } from '../store.ts';
import { FIRST_RECORD_MS, firstRecord, letGo, within } from './first-record.ts';

/**
 * The edge's rules for what goes out as everyone's, for a host with no edge in front of it: the
 * native server, where the runtime answers the client itself. On Workers the edge decides these
 * before a request reaches the Function, and the Function answers each request as one visitor's
 * (`../delivery.ts`); here the runtime's answer is the client's, so the same decisions are made on
 * it, from the same checks the edge makes (`@stayingupwind/core`):
 *
 * - a prerendered Pages page (`static-page.ts` in the edge): `public, max-age=0, must-revalidate`,
 *   for a `GET` with no cookie, authorization or condition, no middleware, rules of `next.config`
 *   that hold for everyone and permit sharing, and a current generation the build's own admission
 *   and the record agree on (`staticPagesPrivacyOf`, `pageHeaders`); one with an invalidation the
 *   cache carries, a `HEAD`, or anything else is the visitor's, as it is the Function's there;
 * - the data of a member of a `fallback: true` route (`static-page-data.ts`), on the same terms;
 * - a route's loading fallback, for a member the build left to its first request
 *   (`fallback-page.ts`);
 * - a prerendered route handler's body (`route-body.ts`): the record's own `Cache-Control`, or a
 *   shared revalidation where it has none, and one a middleware admitted kept from shared caches.
 *
 * Decided in two steps, as the answer is made. Where the runtime answers from a generation or the
 * build, what only it knows — the record, the entry's admission, whether a middleware ran — offers
 * the answer: its `Cache-Control` the record's, in place of the visitor's `private, no-store`, and a
 * header of the platform's own saying what was offered (`OFFER`). Once routing has laid the rules of
 * `next.config` and the middleware's headers over it, the client's request and the whole answer
 * decide (`delivered`): shared, or the visitor's `private, no-store` once more. The platform's
 * headers never reach a client (`writeNativeResponse`).
 *
 * Whatever else the runtime answered goes out as the edge passes a Function's answer on
 * (`passthrough.ts`, and its own answers for a middleware, `middleware.ts`): what the application
 * said of its keeping stands for a shared cache only where it said `public` of itself, to a request
 * that carried nothing of a visitor's — as the client sent it, and as a middleware handed it on —
 * and the application set no cookie; otherwise `s-maxage` goes and the answer is the visitor's, and
 * one that said nothing is kept by no one (`unsharedUnlessPublic`). Not a shipped file, nor an image,
 * which the edge answers by handlers of their own: those are decided apart, before routing lays its
 * headers over them (`decidedApart`), and go out as their own rules left them.
 *
 * What the edge decides from its own machinery has its counterpart here: the generation the native
 * cache holds in place of one read from the edge's store, the visitor's own cookie and
 * authorization in place of the host's credentials, which there are none of. A response compressed
 * here would vary on `Accept-Encoding`; nothing here compresses one, so none says so.
 */

/** What the runtime offered of an answer: its kind, and what of it only the record said. */
const OFFER = `${PLATFORM_HEADER_PREFIX}offer`;
/** An answer of a kind decided by a rule of its own (`decidedApart`): a shipped file, an image. */
const APART = `${PLATFORM_HEADER_PREFIX}apart`;
/** The `Cache-Control` the offer left on the answer, for routing's own to be told from it. */
const OFFERED_CACHE_CONTROL = `${PLATFORM_HEADER_PREFIX}offer-cache-control`;
/** A page's data, as a request wants it (`PAGES_DATA`, read here without the module it is in). */
const PAGES_DATA = 'pages-data' satisfies Representation;
const CACHE_CONTROL = 'cache-control';
const CONTENT_TYPE = 'content-type';
const SET_COOKIE = 'set-cookie';
const HTTP_OK = 200;
const FALLBACK_PRIVACY = 3;
/** The condition the edge leaves to the Function to judge against its full answer. */
const CONDITIONAL_HEADERS = [
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
] as const;
/** What a loading fallback does not keep of the shell's headers (`fallback-page.ts`). */
const SHELL_ENTITY_HEADERS = ['content-encoding', 'content-range', 'accept-ranges', 'etag'];

const PAGE = 'page';
const PAGE_DATA = 'page-data';
const FALLBACK = 'fallback';
const BODY = 'route-body';
const KINDS = [PAGE, PAGE_DATA, FALLBACK, BODY] as const;
type Kind = (typeof KINDS)[number];
interface Offer {
  readonly kind: Kind;
  readonly noTransform: boolean;
  /** A route body a middleware admitted: kept from shared caches whatever the record says. */
  readonly gated: boolean;
}

interface Admitted {
  readonly pages: ReadonlyMap<string, StaticPageEntry>;
  readonly fallbacks: ReadonlySet<Prerender>;
  readonly bodies: ReadonlyMap<string, Omit<RouteBodyEntry, 'entryId'>>;
  readonly rules: Parameters<typeof headerRulesFor>[0];
  /** The routes that take a request elsewhere ahead of the filesystem (`reservedOf`). */
  readonly reserved: readonly ReservedRoute[];
}

const admissions = new WeakMap<Store['manifest'], Admitted>();

/** Each client's request as the middleware that ran for it handed it on (`handedOn`). */
const handedRequests = new WeakMap<Request, Headers>();

/**
 * The routes Next.js runs ahead of the filesystem that take a request elsewhere: redirects and
 * rewrites ahead of the middleware, and rewrites ahead of the filesystem — what the edge reserves a
 * page's own path from (`reservedRoutes`, `serving.ts`), each with its conditions. A rewrite after
 * the filesystem never reaches a page the build wrote; one ahead of it may lead the request through
 * other names before it lands back, and routing lays on the rules of each, judged against names
 * the decision below never sees.
 */
function reservedOf(bundle: Store['manifest']): ReservedRoute[] {
  const { beforeMiddleware, beforeFiles } = bundle.routing;
  return [...beforeMiddleware, ...beforeFiles]
    .filter((route) => route.status !== undefined || route.destination !== undefined)
    .map((route) => {
      return {
        sourceRegex: route.sourceRegex,
        ...(route.has !== undefined && { has: route.has }),
        ...(route.missing !== undefined && { missing: route.missing }),
        beforeFiles: true as const,
      };
    });
}

/**
 * The outputs the build lets be shared, as a deployment's manifest names them (`staticPagesOf`,
 * `pagesFallbacksOf`, `routeBodiesOf`): judged once for the build. The entry's id is the record's,
 * which the runtime looked it up by.
 */
function admittedOf(store: Store): Admitted {
  const bundle = store.manifest;
  const held = admissions.get(bundle);
  if (held !== undefined) return held;
  const pages = new Map<string, StaticPageEntry>();
  // A trailing-slash spelling has no proof of its own path (`staticPagesOf`).
  if (!bundle.config.trailingSlash) {
    for (const [page, privacy] of staticPagesPrivacyOf(bundle)) {
      pages.set(page.pathname, {
        pathname: page.pathname,
        route: page.route,
        entryId: '',
        ...(privacy === 2 && { staticPagePrivacy: privacy }),
      });
    }
  }
  const bodies = new Map<string, Omit<RouteBodyEntry, 'entryId'>>();
  for (const body of edgeServableRouteBodies(bundle)) {
    bodies.set(body.pathname, { pathname: body.pathname, route: body.route });
  }
  const admitted: Admitted = {
    pages,
    fallbacks: new Set(staticFallbackPagesOf(bundle)),
    bodies,
    rules: { headerRules: headerRulesOf(bundle), routerReferences: bundle.routerReferences },
    reserved: reservedOf(bundle),
  };
  admissions.set(bundle, admitted);
  return admitted;
}

/** The answer, offered: the `Cache-Control` the record allows in place of the visitor's. */
function offer(answer: Response, made: Offer, cacheControl: string | null): Response {
  const offered = new Response(answer.body, answer);
  if (cacheControl === null) offered.headers.delete(CACHE_CONTROL);
  else offered.headers.set(CACHE_CONTROL, cacheControl);
  offered.headers.set(
    OFFER,
    [
      made.kind,
      ...(made.noTransform ? ['no-transform'] : []),
      ...(made.gated ? ['gated'] : []),
    ].join(';'),
  );
  offered.headers.set(OFFERED_CACHE_CONTROL, cacheControl ?? '');
  return offered;
}

/** The request's pathname, and as `decodeURI` reads it, which leaves an escaped `/` escaped. */
function askedPathnames(request: Request): readonly string[] {
  const asked = new URL(request.url).pathname;
  try {
    const decoded = decodeURI(asked);
    return decoded === asked ? [asked] : [asked, decoded];
  } catch {
    return [asked];
  }
}

/**
 * Whether the client asked for the page, its data or the route body by its own name. The edge shares
 * only what the request's own pathname finds (`findStaticPage`, `pagesDataRequest` and
 * `findRouteBody`, by way of `classifyRequest`); a request a rewrite led to it from another name —
 * whose rules, and their conditions, routing judged against names the decision below never sees —
 * goes to the Function there, and is the visitor's here.
 */
function askedByName(request: Request, store: Store, pathname: string, data: boolean): boolean {
  const named = data
    ? pagesDataPathnameUnder(store.manifest.buildId, store.manifest.config.basePath, pathname)
    : pathname;
  return askedPathnames(request).includes(named);
}

/**
 * The entry the build lets a page be shared as: a member of a `fallback: true` route, the build's or
 * one its first request rendered (`staticFallbackPageFor`, as the edge's classification finds
 * either), or a page the build admitted on its own (`staticPagesPrivacyOf`).
 */
function pageEntryOf(
  store: Store,
  { route, pathname }: { readonly route: string; readonly pathname: string },
  entryId: string,
): StaticPageEntry | undefined {
  const member = store.manifest.config.trailingSlash
    ? undefined
    : staticFallbackPageFor(store.manifest, route, pathname);
  if (member !== undefined) {
    return {
      staticPagePrivacy: FALLBACK_PRIVACY,
      route,
      pathname,
      entryId,
      parameters: { ...member.params },
      dataPathname: member.dataPathname,
    };
  }
  const page = admittedOf(store).pages.get(pathname);
  return page?.route === route ? { ...page, entryId } : undefined;
}

function pageOffered(
  input: RoutedInput,
  current: CurrentGeneration,
  data: boolean,
  answer: Response,
): Response {
  const { pack, validity, entryId } = current;
  const scopeId = input.cache?.scopeId;
  const store = getStore();
  const entry = pageEntryOf(store, pack.header, entryId);
  if (
    scopeId === undefined ||
    entry === undefined ||
    input.middlewareRan === true ||
    !askedByName(input.request, store, entry.pathname, data)
  ) {
    return answer;
  }
  // A build's own page is shared while fresh; an ISR page, or a member, stale as well, unless the
  // cache carries an invalidation of it (`pageDecisionAgrees`, and the edge's invalidated path).
  const isr = entry.staticPagePrivacy !== undefined;
  if (
    (validity !== 'fresh' && !(isr && validity === 'stale')) ||
    (isr && pack.header.invalidation !== undefined)
  ) {
    return answer;
  }
  const headers = pageHeaders(pack, entry, scopeId);
  if (headers === undefined) return answer;
  if (!data) {
    return offer(
      answer,
      { kind: PAGE, noTransform: headers.has(CACHE_CONTROL), gated: false },
      headers.get(CACHE_CONTROL),
    );
  }
  if (pageDataArtifact(pack, entry, scopeId) === undefined) return answer;
  return offer(
    answer,
    {
      kind: PAGE_DATA,
      noTransform: staticPageHasNoTransform(Object.entries(pack.header.headers)),
      gated: false,
    },
    null,
  );
}

function bodyOffered(input: RoutedInput, current: CurrentGeneration, answer: Response): Response {
  const { pack, entryId } = current;
  const store = getStore();
  const admitted = admittedOf(store).bodies.get(pack.header.pathname);
  if (admitted === undefined || !askedByName(input.request, store, admitted.pathname, false)) {
    return answer;
  }
  const headers = bodyHeaders(pack, { ...admitted, entryId });
  if (headers === undefined) return answer;
  return offer(
    answer,
    { kind: BODY, noTransform: noTransform(headers), gated: input.middlewareRan === true },
    headers.get(CACHE_CONTROL),
  );
}

export function offeredFromGeneration(
  input: RoutedInput,
  current: CurrentGeneration,
  representation: Representation,
  answer: Response,
): Response {
  // A `HEAD` is the Function's on the edge: the build proves a `GET` representation.
  if (input.request.method !== 'GET' || answer.status !== HTTP_OK) return answer;
  const { kind } = current.pack.header;
  if (kind === 'pages' && (representation === 'html' || representation === PAGES_DATA)) {
    return pageOffered(input, current, representation === PAGES_DATA, answer);
  }
  if (kind === 'app-route' && representation === BODY) {
    return bodyOffered(input, current, answer);
  }
  return answer;
}

/**
 * The data of a member whose first generation is in the making. The edge has the member rendered,
 * then reads the record for a while, and shares the props from the generation once it is committed
 * and agrees (`capturePairedPageData`, `dataPage`); otherwise the visitor keeps the answer made for
 * them. So does this: once the generation is there, its answer — offered by the rules above — goes
 * in place of the render's. Where nobody is making one, there is nothing to wait for.
 */
export async function offeredOncePublished(
  input: RoutedInput,
  first: FirstPublish,
  representation: Representation,
  answer: Response,
): Promise<Response> {
  const store = getStore();
  if (
    representation !== PAGES_DATA ||
    input.request.method !== 'GET' ||
    answer.status !== HTTP_OK ||
    input.middlewareRan === true ||
    (first.published === undefined && !first.elsewhere) ||
    !askedByName(input.request, store, first.descriptor.pathname, true) ||
    pageEntryOf(store, first.descriptor, '') === undefined
  ) {
    return answer;
  }
  const until = performance.now() + FIRST_RECORD_MS;
  const current = await firstRecord(input, first, until);
  if (current === undefined) return answer;
  // The generation's answer reads its output from the cache: within the same window, and only
  // while the visitor waits, with the answer made for them ready all the while (greptile).
  const reading = first.fromRecord(current);
  const recorded = await within(reading, until, input.request.signal);
  if (recorded === undefined) {
    input.waitUntil(letGo(reading));
    return answer;
  }
  if (recorded.value?.headers.has(OFFER) !== true) {
    await recorded.value?.body?.cancel();
    return answer;
  }
  await answer.body?.cancel();
  return recorded.value;
}

/**
 * The build's loading fallback as the visitor's own: under `private, no-store` where it says nothing
 * of its own, as the edge's passthrough leaves such an answer of the Function's
 * (`unsharedUnlessPublic`) — the build writes none on it.
 */
function visitorsOwn(answer: Response): Response {
  if (answer.headers.has(CACHE_CONTROL)) return answer;
  const own = new Response(answer.body, answer);
  own.headers.set(CACHE_CONTROL, NO_STORE_CACHE_CONTROL);
  return own;
}

export function offeredFromFallback(
  input: RoutedInput,
  store: Store,
  shell: Prerender,
  answer: Response,
): Response {
  if (
    input.request.method !== 'GET' ||
    answer.status !== HTTP_OK ||
    input.middlewareRan === true ||
    !admittedOf(store).fallbacks.has(shell) ||
    // Asked for by a member's own name, as the edge finds a fallback page (`findPagesFallback`).
    askedPathnames(input.request).every(
      (asked) => staticFallbackPageFor(store.manifest, shell.route, asked)?.kind !== 'fallback',
    )
  ) {
    return visitorsOwn(answer);
  }
  return offer(
    answer,
    { kind: FALLBACK, noTransform: false, gated: false },
    answer.headers.get(CACHE_CONTROL),
  );
}

function offerOf(value: string): Offer | undefined {
  const [named, ...flags] = value.split(';');
  const kind = KINDS.find((each) => each === named);
  return kind === undefined
    ? undefined
    : { kind, noTransform: flags.includes('no-transform'), gated: flags.includes('gated') };
}

/** Whether the client's request is one the edge answers from a shared cache at all. */
function requestShares(request: Request, body: boolean): boolean {
  const { headers } = request;
  return (
    request.method === 'GET' &&
    !headers.has('cookie') &&
    !headers.has('authorization') &&
    CONDITIONAL_HEADERS.every((name) => !headers.has(name)) &&
    !(body && hasRouteBodyControlHeader(headers))
  );
}

/**
 * Whether a route of `reservedOf` takes the request, its conditions judged against it: the request's
 * own name, and for a page's data the data's (as the router reads a data request, `x-nextjs-data`
 * set) and the page's too (`reservedRequest`, `pages-fallback.ts`). The edge leaves such a request to
 * the Function, whose answer is the visitor's: so is this one (Codex).
 */
function reservedFor(store: Store, request: Request, data: boolean): boolean {
  const { reserved } = admittedOf(store);
  if (reserved.length === 0) return false;
  const url = new URL(request.url);
  if (!data) return pathIsReserved(reserved, url, request.headers, true);
  if (pathIsReserved(reserved, url, dataRequestHeaders(request.headers), true)) return true;
  const { buildId, config } = store.manifest;
  const page = pageOfDataPathname(buildId, config.basePath, url.pathname);
  if (page === undefined) return true;
  const pageUrl = new URL(url.href);
  pageUrl.pathname = page;
  return pathIsReserved(reserved, pageUrl, request.headers, true);
}

/** The rules of `next.config` hold for everyone, and none keeps the answer from being shared. */
function configuredShares(configured: ConfiguredHeaders, made: Offer): boolean {
  if (configured.conditioned) return false;
  const set = Object.entries(configured.headers);
  if (made.kind === BODY) {
    const fields = new Map(set.map(([name, value]) => [name.toLowerCase(), value]));
    return (
      !fields.has(SET_COOKIE) && !policyRefusesSharing({ get: (name) => fields.get(name) ?? null })
    );
  }
  return (
    made.kind === PAGE_DATA ? staticPageDataHeadersAllowSharing : staticPageHeadersAllowSharing
  )(set);
}

/** Shared as the edge shares it: its policy over the answer's, and the cache's own fields gone. */
function shared(headers: Headers, made: Offer, configured: ConfiguredHeaders): boolean {
  const contentType = headers.get(CONTENT_TYPE) ?? '';
  if (made.kind === BODY) {
    if (headers.has(SET_COOKIE) || !bodyTypeAllowed(contentType) || policyRefusesSharing(headers)) {
      return false;
    }
    const untransformed = made.noTransform || noTransform(headers);
    removeSharedCacheOverrides(headers);
    narrowCacheControl(headers, made.gated, untransformed);
    return true;
  }
  if (made.kind === FALLBACK) {
    if (!htmlType(contentType) || !staticPageHeadersAllowSharing(headers)) return false;
    for (const name of SHELL_ENTITY_HEADERS) headers.delete(name);
  } else if (
    // The whole answer as routing left it, as the edge judges its own once the rules are on it:
    // anything routing laid on — a `Set-Cookie`, a private policy — keeps it the visitor's (Codex).
    !(made.kind === PAGE_DATA ? staticPageDataHeadersAllowSharing : staticPageHeadersAllowSharing)(
      headers,
    )
  ) {
    return false;
  }
  const untransformed =
    made.noTransform ||
    staticPageHasNoTransform(Object.entries(configured.headers)) ||
    (made.kind === FALLBACK && staticPageHasNoTransform(headers));
  removeSharedCacheOverrides(headers);
  headers.set(CACHE_CONTROL, `${REVALIDATE_CACHE_CONTROL}${untransformed ? ', no-transform' : ''}`);
  return true;
}

/** `answer` again under `headers`: its status and its body, but none for a status that has none. */
function reframed(answer: Response, headers: Headers): Response {
  const bodyless = NULL_BODY_STATUSES.has(answer.status);
  if (bodyless) releaseStream(answer.body, 'a status with no body');
  return new Response(bodyless ? null : answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

export function decidedApart(answer: Response): Response {
  const headers = new Headers(answer.headers);
  headers.set(APART, '1');
  return reframed(answer, headers);
}

export function handedOn(request: Request, headers: Headers): void {
  handedRequests.set(request, headers);
}

/**
 * Whether headers a request carried hold nothing of a visitor's an answer could have been told by,
 * as the edge judges them (`anonymousRequest`): no cookie and no `Authorization` — all the
 * visitor's own here, a host having no credentials of its own to take off — and none of Next.js's
 * control or router-protocol headers (`hasRouteBodyControlHeader`), which a navigation's payload is
 * told apart from its document by. A validation, the edge's other case, is the edge's own.
 */
function carriesNothingOfAVisitor(headers: Headers): boolean {
  return (
    !headers.has('cookie') && !headers.has('authorization') && !hasRouteBodyControlHeader(headers)
  );
}

/** As the client sent the request, and as the middleware that ran for it handed it on. */
function anonymous(request: Request): boolean {
  const handed = handedRequests.get(request);
  return (
    carriesNothingOfAVisitor(request.headers) &&
    (handed === undefined || carriesNothingOfAVisitor(handed))
  );
}

/**
 * An answer as the edge passes on a Function's (`passthrough.ts`, `unsharedUnlessPublic`): the
 * application's word that shared caches may keep it standing where it said `public`, to an
 * anonymous request and with no cookie set; `s-maxage` gone and the answer the visitor's otherwise;
 * no word, kept by no one. The same answer where none of that changes it.
 */
function passedOn(request: Request, answer: Response): Response {
  const headers = new Headers(answer.headers);
  unsharedUnlessPublic(headers, anonymous(request));
  const unchanged =
    headers.get(CACHE_CONTROL) === answer.headers.get(CACHE_CONTROL) &&
    SHARED_CACHE_CONTROL_HEADERS.every((name) => !answer.headers.has(name));
  return unchanged ? answer : reframed(answer, headers);
}

export function delivered(request: Request, answer: Response): Response {
  if (answer.headers.has(APART)) {
    const headers = new Headers(answer.headers);
    headers.delete(APART);
    return reframed(answer, headers);
  }
  const value = answer.headers.get(OFFER);
  if (value === null) return passedOn(request, answer);
  const left = answer.headers.get(OFFERED_CACHE_CONTROL) ?? '';
  const out = new Response(answer.body, answer);
  const { headers } = out;
  headers.delete(OFFER);
  headers.delete(OFFERED_CACHE_CONTROL);
  const made = offerOf(value);
  const store = getStore();
  if (
    made !== undefined &&
    out.status === HTTP_OK &&
    requestShares(request, made.kind === BODY) &&
    !reservedFor(store, request, made.kind === PAGE_DATA)
  ) {
    const configured = headerRulesFor(
      admittedOf(store).rules,
      new URL(request.url),
      request.headers,
    );
    if (configuredShares(configured, made)) {
      const answered = new Headers(headers);
      if (shared(answered, made, configured)) {
        return new Response(out.body, {
          status: out.status,
          statusText: out.statusText,
          headers: answered,
        });
      }
    }
  }
  // The visitor's, as the Function answers it on the edge — but for a `Cache-Control` routing laid
  // over the offer, which is what it would have laid over the visitor's too — and passed on as the
  // edge passes on the Function's answer.
  if ((headers.get(CACHE_CONTROL) ?? '') === left)
    headers.set(CACHE_CONTROL, NO_STORE_CACHE_CONTROL);
  return passedOn(request, out);
}
