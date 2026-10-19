import {
  type BlobRef,
  type DeploymentBundle,
  edgeServablePrerenders,
  prefetchSegments,
  type Prerender,
  routePagesData,
  routePathnameOf,
  routePayloads,
} from '@stayingupwind/core/bundle';
import { type RouteEntry, routeRequestPathOf } from '@stayingupwind/core/manifest';
import {
  computeRscCacheBustingParam,
  DEPLOYMENT_ID_REQUEST_HEADER,
  NEXT_DATA_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  RSC_HEADER,
} from '@stayingupwind/core/request';

import type { CheckedStack } from './answers.ts';
import { referrerOf } from './browsers.ts';
import { browserCodingsOf } from './codings.ts';
import type { CookieChanges } from './cookie-jar.ts';
import type { Scoped } from './cookie-scopes.ts';
import { REFERER } from './part-flows.ts';
import type { Part, PrefetchKind } from './part-marks.ts';
import { ACCEPT_ENCODING } from './part-verdicts.ts';
import { type Step, withBusting } from './redirects.ts';
import { stateTreeOf, stateTreeUnproved } from './router-state.ts';

/**
 * A route's parts, asked for apart from its document as the client router asks for each (`checkRoutes`):
 * its prefetch segments, at the page's URL with the segment named (`next-router-segment-prefetch`);
 * its whole React Server Components payload (`rsc`), where the build finished the page; and a Pages
 * Router page's props, at their own URL under `/_next/data/`. Each is the build's — what is asked
 * for, and what an answer is held to: its bytes, its type — not the manifest's, which is held to the
 * build apart (`held-routes.ts`); and held to what the edge says beside a part it answers from them
 * (`segment.ts` in the edge).
 */

/** A part the build wrote: its bytes, and where a client asks for it where that is a URL of its own. */
interface BuiltPart {
  readonly body: BlobRef;
  /** The URL a client asks for it at, where not the page's: a page's props'. */
  readonly at?: string;
}

/** What the build wrote of each page's parts, by the page's pathname as the build named it. */
export interface BuiltParts {
  /** The pathname the build named each page by, by the name a deploy routes it under. */
  readonly documents: ReadonlyMap<string, string>;
  readonly segments: ReadonlyMap<string, ReadonlyMap<string, BlobRef>>;
  readonly payloads: ReadonlyMap<string, BlobRef>;
  readonly pagesData: ReadonlyMap<string, BuiltPart>;
  /** The pages a resume completes, of whose whole payload the build wrote none, by pathname. */
  readonly resumable: ReadonlySet<string>;
}

const builtParts = new WeakMap<DeploymentBundle, BuiltParts>();

/** Each found part by the pathname of the document it is a part of. */
function byDocument(
  found: readonly { readonly document: Prerender; readonly prerender: Prerender }[],
): Map<string, BuiltPart> {
  return new Map(
    found.flatMap(({ document, prerender }) => {
      return prerender.body === undefined
        ? []
        : [[document.pathname, { body: prerender.body, at: prerender.pathname }] as const];
    }),
  );
}

/**
 * Each page's parts as the build wrote them, as a deploy finds them (`routeSegmentsOf`,
 * `routeArtifactsOf`): its prefetch segments by their paths, its whole payload, its props at the
 * URL the build wrote them under (`pagesDataPathnameUnder`). Read once a bundle.
 */
export function builtPartsOf(bundle: DeploymentBundle): BuiltParts {
  const known = builtParts.get(bundle);
  if (known !== undefined) {
    return known;
  }
  const segments = new Map<string, Map<string, BlobRef>>();
  const found = prefetchSegments(bundle, { complete: true });
  for (const { segmentPath, document, prerender } of found) {
    if (prerender.body === undefined) {
      continue;
    }
    const named = segments.get(document.pathname) ?? new Map<string, BlobRef>();
    named.set(segmentPath, prerender.body);
    segments.set(document.pathname, named);
  }
  const payloads = new Map(
    [...byDocument(routePayloads(bundle, { complete: true }))].map(
      ([pathname, part]) => [pathname, part.body] as const,
    ),
  );
  const servable = edgeServablePrerenders(bundle, { complete: true });
  const documents = new Map(
    servable.map((prerender) => [routePathnameOf(bundle, prerender), prerender.pathname] as const),
  );
  const resumable = new Set(
    servable
      .filter((prerender) => prerender.postponed !== undefined)
      .map((prerender) => prerender.pathname),
  );
  const parts = {
    documents,
    segments,
    payloads,
    pagesData: byDocument(routePagesData(bundle, { complete: true })),
    resumable,
  };
  builtParts.set(bundle, parts);
  return parts;
}

/** The path of the front page, as the client router names the page it is on (`next-url`). */
const FRONT_PAGE = '/';

/** A page the client router asks for a page's parts from, as its requests say it. */
export interface Origin {
  /**
   * The page, as the router names the one it is on with every request for a part (`next-url`: its
   * state's `nextUrl`, `extractPathFromFlightRouterState`) — its path but the base path.
   */
  readonly path: string;
  /** Its URL, which a request its script makes says it is asked from (`Referer`). */
  readonly url: URL;
  /**
   * Whether it is the page whose parts are asked for, whose document the browser has fetched — not
   * one a client-side navigation leaves, which fetches none of it.
   */
  readonly itself: boolean;
  /** Where, in a verdict's words, where not the front page. */
  readonly as: string;
}

/**
 * The page at `url` as the client router on it names it (`next-url`): its path but the base path,
 * and a trailing slash — another than the page whose parts are asked for, in a verdict's words.
 */
export function originAt(stack: CheckedStack, url: URL, as: string): Origin {
  const { basePath } = stack.bundle.config;
  const under =
    basePath !== '' && hasPrefix(url.pathname, basePath)
      ? url.pathname.slice(basePath.length) || FRONT_PAGE
      : url.pathname;
  const path = under.length > 1 && under.endsWith('/') ? under.slice(0, -1) : under;
  return { path, url, itself: false, as };
}

/**
 * The pages the client router asks for a page's parts from: the front page, as a visitor who came
 * by it asks; the page itself, as a visitor on it asks for it again — a link to it, a refresh —
 * where it is another; and another page of the build's, the first of its own pathname by name, as a
 * visitor who came by any other asks: each a path a rule or a middleware that tells router requests
 * apart by the page they come from (`next-url`, `Referer`) is judged on — each at the URL it is
 * deployed at, under the base path, and named by the router without it (`originAt`).
 */
export function originsOf(stack: CheckedStack, page: URL): Origin[] {
  const { basePath, trailingSlash } = stack.bundle.config;
  // The front page where Next.js serves it under the base path: `/docs`, or `/docs/`.
  const slash = trailingSlash ? '/' : '';
  const home = basePath === '' ? FRONT_PAGE : `${basePath}${slash}`;
  const front = { path: FRONT_PAGE, url: new URL(home, stack.site), itself: false, as: '' };
  const { path } = originAt(stack, page, '');
  const own =
    path === FRONT_PAGE
      ? [{ ...front, itself: true }]
      : [front, { path, url: page, itself: true, as: ', from the page itself' }];
  // A route of the manifest's by the pathname it is deployed at, under the base path, which the
  // router names it by without (`originAt`).
  const other = Object.keys(stack.manifest.routes)
    .toSorted(compareCodeUnits)
    .filter((key) => !key.includes('['))
    .flatMap((key) => {
      // As the router names it: one no request reaches is no page a visitor came from.
      const asked = routeRequestPathOf(stack.manifest, key);
      return asked === undefined
        ? []
        : [originAt(stack, new URL(asked, stack.site), `, from ${key}`)];
    })
    .find((at) => at.path !== FRONT_PAGE && at.path !== path);
  return other === undefined ? own : [...own, other];
}

/** `a` and `b` in the order of their code units, as a name sorts the same everywhere. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * What a part's request keeps of the page's navigation: the headers that name the site it is asked
 * of, as validation forwards them — and its cookies, which a browser sends with every request of the
 * page's own, its router's among them, with those the page's document and its parts set
 * (`part-flows.ts`).
 */
const KEPT_FROM_NAVIGATION = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto']);

/**
 * The headers the client router asks for a part with: under the site the page's navigation was
 * asked of (`KEPT_FROM_NAVIGATION`), as a browser's script fetches — the browser
 * the page was asked as, or Chrome where it was asked as no browser (`routerBrowserOf`) — of its
 * page's own (`empty`, `cors`, `same-origin`), from the page it is on (`Origin`, its referrer as a
 * browser says it: `referrerOf`),
 * accepting the part as it is, naming the deployment the page was
 * built as: Next.js's router sends that with every request it makes once its build has an id
 * (`createFetch`, `fetchNextData`), and the build's documents name theirs by it.
 */
function fetchedFrom(
  stack: CheckedStack,
  asked: {
    readonly navigation: Readonly<Record<string, string>>;
    /** The browser the router runs in, as its requests name it. */
    readonly browser: Readonly<Record<string, string>>;
    readonly origin: Origin;
  },
): Record<string, string> {
  const site = Object.entries(asked.navigation).filter(([name]) =>
    KEPT_FROM_NAVIGATION.has(name.toLowerCase()),
  );
  return {
    ...Object.fromEntries(site),
    ...asked.browser,
    accept: '*/*',
    [ACCEPT_ENCODING]: 'identity',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    [REFERER]: referrerOf(asked.origin.url),
    [DEPLOYMENT_ID_REQUEST_HEADER]: stack.bundle.deploymentId,
  };
}

/**
 * `page` with the router's cache-busting query, as the client router sets it
 * (`setCacheBustingSearchParamWithHash`): the query it had, as it was spelled, and `_rsc` last —
 * the digest of what the request carries (`computeRscCacheBustingParam`), or the name alone.
 */
async function bustedFor(
  page: URL,
  carried: Parameters<typeof computeRscCacheBustingParam>[0],
): Promise<URL> {
  return withBusting(page, await computeRscCacheBustingParam(carried));
}

/** Each way the client router prefetches a page's whole payload (`FetchStrategy`). */
const PREFETCH_KINDS: readonly PrefetchKind[] = ['1', '2', '3'];

/** What a prefetch of a page's props asks a build's middleware to know it by (`fetchNextData`). */
const MIDDLEWARE_PREFETCH = 'x-middleware-prefetch';

/**
 * Whether `pathname`'s last segment names a file — a dot with something after it — which takes no
 * trailing slash (`normalizePathTrailingSlash`'s `/\.[^/]+\/?$/`).
 */
function namesFile(pathname: string): boolean {
  const unslashed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const last = unslashed.slice(unslashed.lastIndexOf('/') + 1);
  const dot = last.indexOf('.');
  return dot !== -1 && dot < last.length - 1;
}

/** Whether `pathname` is `prefix` or under it (`pathHasPrefix`). */
function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * `pathname` as the client router spells a path it tests (`normalizePathTrailingSlash`): as it is
 * where the app skips trailing-slash redirects; else with a trailing slash where the app is on them,
 * but a file's, and with none where it is not.
 */
function routerSpelling(config: CheckedStack['bundle']['config'], pathname: string): string {
  if (config.skipTrailingSlashRedirect) {
    return pathname;
  }
  const bare = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const slashed = config.trailingSlash && !namesFile(pathname) && !bare.endsWith('/');
  return slashed ? `${bare}/` : bare;
}

/**
 * Whether a link's prefetch of a page's props tells the middleware it is one (`hasMiddleware`): where
 * the client router takes the middleware to run for the page (`matchesMiddleware`) — by its pathname
 * alone, which the router spells in the page's own locale or, where it names none, in the front
 * page's (the default), under the base path (`routerSpelling`) — against the build's matchers as
 * compiled, minding case, as the router compiles them (`new RegExp(regexp)`).
 */
function middlewarePrefetches(stack: CheckedStack, page: URL): boolean {
  const { config } = stack.bundle;
  const { basePath, i18n } = config;
  const { pathname } = page;
  const cleaned =
    basePath !== '' && hasPrefix(pathname, basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname;
  const lower = cleaned.toLowerCase();
  const named =
    hasPrefix(lower, '/api') ||
    i18n?.locales.some((locale) => hasPrefix(lower, `/${locale.toLowerCase()}`)) === true;
  const localized =
    i18n === undefined || i18n === null || named ? cleaned : `/${i18n.defaultLocale}${cleaned}`;
  const tested = routerSpelling(config, `${basePath}${localized}`);
  return (stack.bundle.middleware?.matchers ?? []).some(
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- the build's own matcher, compiled as the client router compiles it.
    (matcher) => new RegExp(matcher.sourceRegex).test(tested),
  );
}

/**
 * What a browser's navigation of a page came to (`PartsAsked.navigatedBy`): what its answers did to
 * the cookies the browser keeps, in order (`documentRedirects`), and the route it was served as,
 * where another than the page's own — and where it came from, in a verdict's words, where that is
 * said.
 */
export interface Navigated {
  readonly steps: readonly Step[];
  readonly served?: string | undefined;
  readonly as?: string | undefined;
}

/** A route whose parts are asked for: as its document was asked for, under its key. */
export interface PartsAsked {
  /** The route's key in the manifest: the name a deploy routes the page under. */
  readonly key: string;
  /** The route, whose recorded headers a part of its page goes out with. */
  readonly route: RouteEntry;
  readonly requested: string;
  /** The navigation its document was asked with, which its parts are fetched from. */
  readonly headers: Readonly<Record<string, string>>;
  /** Whether `requested` is one only the rules ahead of the filesystem claim. */
  readonly exact: boolean;
  /** What its document's answer did to the cookies a browser keeps (`CookieChanges`). */
  readonly cookieChanges?: CookieChanges | undefined;
  /**
   * What each browser's own navigations of the page came to, by its agent — one from each place a
   * navigation comes from: what its router asks with and from, where it was asked so — else what
   * the document as it was asked came to.
   */
  readonly navigatedBy?: ReadonlyMap<string, readonly Navigated[]> | undefined;
  /**
   * The route the document was served as, by its key, where the middleware moved it onto another
   * (its account's `route=`): whose parts the page's router asks for as well, at the page's URL.
   */
  readonly served?: string | undefined;
  /** Whether its parts are asked for as the browser the page was asked as alone (`routersOf`). */
  readonly onlyOwn?: boolean | undefined;
  /**
   * The URL its navigation's cookies were sent to, where another than the page's: the one a
   * navigation was asked for before it redirected to the page — which the browser keeps them for,
   * and sends them to the page by (`seedsOf`).
   */
  readonly sentTo?: URL | undefined;
  /** The one way its navigation's cookies are kept in that its parts are asked in, where one alone is. */
  readonly scoped?: Scoped | undefined;
}

/** What the build wrote of a part of a route's page, by what `of` finds of the page's. */
function builtOnRoute(
  built: BuiltParts,
  of: (document: string) => BlobRef | undefined,
): (route: RouteEntry) => BlobRef | undefined {
  return (route) => {
    const document = built.documents.get(route.pathname);
    return document === undefined ? undefined : of(document);
  };
}

/**
 * The parts the build wrote of a route's page, each as the client router asks for it in `browser`,
 * from `origin` — but for the cookies it holds, and whether it says the page it asks from
 * (`part-flows.ts`).
 */
export async function partsOf(
  stack: CheckedStack,
  asked: PartsAsked,
  router: { readonly browser: Readonly<Record<string, string>>; readonly origin: Origin },
): Promise<Part[]> {
  const { browser, origin } = router;
  const built = builtPartsOf(stack.bundle);
  // The page the build prerendered under the route's name, not the route's own say of it.
  const document = built.documents.get(asked.key);
  if (document === undefined) {
    return [];
  }
  const page = new URL(asked.requested, stack.site);
  const fetched = fetchedFrom(stack, { navigation: asked.headers, browser, origin });
  const parts: Part[] = [];
  const segments = built.segments.get(document) ?? new Map<string, BlobRef>();
  // And those of the page the document was served as, where the middleware moved it onto another:
  // what its router's tree names, asked for at the page's own URL — the build's of the page asked
  // for none, where it wrote none of the path.
  const served = asked.served === undefined ? undefined : built.documents.get(asked.served);
  const paths = new Set(segments.keys());
  const servedSegments = served === undefined ? undefined : built.segments.get(served);
  if (servedSegments !== undefined) {
    for (const segmentPath of servedSegments.keys()) {
      paths.add(segmentPath);
    }
  }
  for (const segmentPath of paths) {
    const body = segments.get(segmentPath);
    const headers = {
      ...fetched,
      [RSC_HEADER]: '1',
      [NEXT_ROUTER_PREFETCH_HEADER]: '1',
      [NEXT_ROUTER_SEGMENT_PREFETCH_HEADER]: segmentPath,
      [NEXT_URL_HEADER]: origin.path,
    };
    parts.push({
      kind: 'segment',
      what: `its prefetch segment ${segmentPath}`,
      // As the router names the request, which a cache that keys on the URL alone tells apart by.
      url: await bustedFor(page, {
        prefetch: '1',
        segmentPrefetch: segmentPath,
        nextUrl: origin.path,
      }),
      headers,
      built: body,
      builtOn: builtOnRoute(built, (on) => built.segments.get(on)?.get(segmentPath)),
      route: asked.route,
      exact: asked.exact,
    });
  }
  const payload = built.payloads.get(document);
  // A resumable page's as well, of which the build wrote none: the edge answers it from a generation
  // the runtime rendered whole since, where it holds one (`composePayload`), and hands it on else —
  // and a page the document was served as that has one.
  const wholeOf = (on: string | undefined): boolean =>
    on !== undefined && (built.payloads.has(on) || built.resumable.has(on));
  if (wholeOf(document) || wholeOf(served)) {
    const stateTree = stateTreeOf(origin.path);
    const from = { stateTree, nextUrl: origin.path };
    const navigated = {
      ...fetched,
      [RSC_HEADER]: '1',
      [NEXT_ROUTER_STATE_TREE_HEADER]: stateTree,
      [NEXT_URL_HEADER]: origin.path,
    };
    // Proved by none where what tells requests apart sees the state they are asked from.
    const unproved = stateTreeUnproved(stack, page, navigated);
    const whole = {
      built: payload,
      builtOn: builtOnRoute(built, (on) => built.payloads.get(on)),
      route: asked.route,
      exact: asked.exact,
      ...(unproved !== undefined && { unproved }),
    };
    parts.push(
      // As a navigation to the page asks for it, from the router state of the page it is on.
      {
        ...whole,
        kind: 'payload',
        what: 'its whole React Server Components payload',
        url: await bustedFor(page, from),
        headers: navigated,
      },
      // And as the router prefetches the page whole (`fetchSegmentPrefetchesUsingDynamicRequest`):
      // down to its loading boundary (`1`), with its runtime parts (`2`), as its runtime shell (`3`).
      ...(await Promise.all(
        PREFETCH_KINDS.map(async (prefetch) => {
          return {
            ...whole,
            kind: 'payload' as const,
            what: `its whole React Server Components payload, prefetched (${NEXT_ROUTER_PREFETCH_HEADER}: ${prefetch})`,
            url: await bustedFor(page, { ...from, prefetch }),
            headers: { ...navigated, [NEXT_ROUTER_PREFETCH_HEADER]: prefetch },
            prefetch,
          };
        }),
      )),
    );
    // And as a refresh of the page itself asks for it, which names no page it is on where its
    // tree holds no interception route (`refreshDynamicData`'s `nextUrl: null`).
    if (origin.itself) {
      const refreshed = Object.fromEntries(
        Object.entries(navigated).filter(([name]) => name !== NEXT_URL_HEADER),
      );
      parts.push({
        ...whole,
        kind: 'payload',
        what: `its whole React Server Components payload, as a refresh asks for it (no ${NEXT_URL_HEADER})`,
        url: await bustedFor(page, { stateTree }),
        headers: refreshed,
      });
    }
  }
  const props = built.pagesData.get(document);
  if (props?.at !== undefined) {
    // With the page's query, as the Pages Router asks for a page's props (`getDataHref`), and
    // marked as its every request for them is (`fetchRetry`) — and as a link prefetches them
    // (`fetchNextData`'s `isPrefetch`), saying so.
    const asProps = {
      kind: 'data' as const,
      url: new URL(`${props.at}${page.search}`, stack.site),
      built: props.body,
      builtOn: builtOnRoute(built, (on) => built.pagesData.get(on)?.body),
      route: asked.route,
      exact: true,
    };
    const fetchedProps = { ...fetched, [NEXT_DATA_HEADER]: '1' };
    const prefetched = { ...fetchedProps, purpose: 'prefetch' };
    parts.push(
      { ...asProps, what: `its page's props (${props.at})`, headers: fetchedProps },
      { ...asProps, what: `its page's props (${props.at}), prefetched`, headers: prefetched },
    );
    // Telling the middleware so as well, where the router takes it to run for the page: a link asks
    // that first (`withMiddlewareEffects`) — but under `proxyPrefetch: 'strict'`, which a bundle does
    // not say — and a hover's prefetch asks as above all the same, past the client's cache
    // (`unstable_skipClientCache`).
    if (middlewarePrefetches(stack, page)) {
      parts.push({
        ...asProps,
        what: `its page's props (${props.at}), prefetched with the middleware told`,
        headers: { ...prefetched, [MIDDLEWARE_PREFETCH]: '1' },
      });
    }
  }
  const browserCodings = browserCodingsOf(browser['user-agent']);
  return parts.map((part) => ({ ...part, browserCodings }));
}
