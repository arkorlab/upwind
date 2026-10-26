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
  type RouteBodyEntry,
  type StaticPageEntry,
} from '@stayingupwind/core/manifest';
import {
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

import { nowMs } from '../cache/clock.ts';
import { type CurrentGeneration, currentGeneration } from '../cache/current.ts';
import type { FirstPublish } from '../delivery.ts';
import type { Representation } from '../representations.ts';
import type { RoutedInput } from '../serve.ts';
import { getStore, type Store } from '../store.ts';

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
}

const admissions = new WeakMap<Store['manifest'], Admitted>();

/** Each client's request as the middleware that ran for it handed it on (`handedOn`). */
const handedRequests = new WeakMap<Request, Headers>();

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
  const entry = pageEntryOf(getStore(), pack.header, entryId);
  if (scopeId === undefined || entry === undefined || input.middlewareRan === true) {
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
  const admitted = admittedOf(getStore()).bodies.get(pack.header.pathname);
  if (admitted === undefined) return answer;
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

/** How long the first data of a member waits for its generation (the edge's own read window). */
const FIRST_RECORD_MS = 10_000;
/** How often the cache is asked for it meanwhile. */
const FIRST_RECORD_POLL_MS = 100;

/** The entry's generation once there is one, before the deadline or the visitor's going. */
async function firstRecord(
  input: RoutedInput,
  first: FirstPublish,
  until: number,
): Promise<CurrentGeneration | undefined> {
  await first.published;
  for (;;) {
    const lookup = await currentGeneration(
      first.runtime,
      first.descriptor,
      nowMs(),
      input.waitUntil,
    );
    if (lookup.kind === 'generation') return lookup.current;
    if (performance.now() >= until || input.request.signal.aborted) return undefined;
    await new Promise((resolve) => {
      setTimeout(resolve, FIRST_RECORD_POLL_MS);
    });
  }
}

/**
 * The data of a member whose first generation is in the making. The edge has the member rendered,
 * then reads the record for a while, and shares the props from the generation once it is committed
 * and agrees (`capturePairedPageData`, `dataPage`); otherwise the visitor keeps the answer made for
 * them. So does this: once the generation is there, its answer — offered by the rules above — goes
 * in place of the render's.
 */
export async function offeredOncePublished(
  input: RoutedInput,
  first: FirstPublish,
  representation: Representation,
  answer: Response,
): Promise<Response> {
  if (
    representation !== PAGES_DATA ||
    input.request.method !== 'GET' ||
    answer.status !== HTTP_OK ||
    input.middlewareRan === true ||
    pageEntryOf(getStore(), first.descriptor, '') === undefined
  ) {
    return answer;
  }
  const current = await firstRecord(input, first, performance.now() + FIRST_RECORD_MS);
  const recorded = current === undefined ? undefined : await first.fromRecord(current);
  if (recorded?.headers.has(OFFER) !== true) {
    await recorded?.body?.cancel();
    return answer;
  }
  await answer.body?.cancel();
  return recorded;
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
    !admittedOf(store).fallbacks.has(shell)
  ) {
    return answer;
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
  } else if (made.kind === PAGE && !htmlType(contentType)) {
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
  if (made !== undefined && out.status === HTTP_OK && requestShares(request, made.kind === BODY)) {
    const configured = headerRulesFor(
      admittedOf(getStore()).rules,
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
