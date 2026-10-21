import {
  isReserved,
  type ProjectManifest,
  type ReservedRoute,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import {
  bypassForHolds,
  NAVIGATION_REQUEST_HEADERS,
  passesOnEveryAgent,
  PREFETCH_HINT_HEADERS,
  wantsBlockingMetadata,
} from '@stayingupwind/core/request';
import { isHtmlContentType } from '@stayingupwind/core/util';

import { forwarded, edgeReads } from './answers.ts';
import {
  type Browser,
  BROWSERS,
  UPGRADE_INSECURE_REQUESTS,
  USER_AGENT,
} from './browser-samples.ts';
import { claimedBy, escaping, type Target } from './escaping.ts';
import { routedReads } from './routing-reads.ts';

/**
 * The agents a check asks a page or a file as, in the order it tries them, as a deployment's
 * validation tries its own: its own agent first (the prover's), then five browsers, each with what it
 * sends beside its agent, Chrome's Client Hints among them, and in a language of its own. A rule of `next.config` written for one of them — one
 * that claims a request without Client Hints (`missing: sec-ch-ua`), or a language — or a list of
 * crawlers that names one passes over the others, which are served the shell: so a page is asked as
 * the first the edge serves the shell to and no rule claims. A page every one of them is claimed
 * for is the application's only where the rules that claim it ask nothing of what a browser sends
 * of itself; a rule that does — of the agent, its hints, its language, what it accepts — may pass
 * over a browser the check does not ask as, which is served a shell nothing checked.
 */

/** What a browser names itself by beside its agent: its Client Hints. */
const CLIENT_HINT_PREFIX = 'sec-ch-ua';
/** What a browser says of a request: what it is for, and how it was made. */
const FETCH_METADATA_PREFIX = 'sec-fetch-';
/**
 * What a check makes up for each browser beside those: what it sends of itself, and no prefetch
 * hint — but the encodings it accepts, which no rule reads a browser's of: Cloudflare's front line
 * hands the edge every request accepting what it sets in the visitor's place (`edgeReads`).
 */
const SAMPLED_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  // The page a CORS request comes from, which only one from another site's page says.
  'origin',
  // The page any request comes from, which a browser says of every one but a navigation typed.
  'referer',
  UPGRADE_INSECURE_REQUESTS,
  USER_AGENT,
  ...PREFETCH_HINT_HEADERS,
]);

const UNPROVED_CLAIMED =
  'a rule of next.config that asks of the user agent, its client hints, its language, its accept or upgrade-insecure-requests header, its origin, its referrer, its fetch metadata or a prefetch hint claims every browser the check asks as, but not every agent: no browser proves the shell';
const UNPROVED_FILE =
  'a rule of next.config that asks of the user agent, its client hints, its language, its accept or upgrade-insecure-requests header, its origin, its referrer or its fetch metadata claims every browser the check asks for the file as, but not every agent: no browser proves the file';
const UNPROVED_ANONYMOUS =
  'htmlLimitedBots names every browser the check asks as, but not every agent, and a rule of next.config that asks of the user agent claims a request that names none: no request proves the shell';
const UNPROVED_ANONYMOUS_SAMPLE =
  "a rule of next.config that asks of more than the user agent of a request that names none claims the check's, but not every such request: no request proves the shell";
/** What every browser accepts for a style sheet a page links to. */
const STYLE_ACCEPT = 'text/css,*/*;q=0.1';
/** What a browser accepts for a script, a font, or a fetch: any type. */
const ANY_ACCEPT = '*/*';
/** What a browser accepts for a JSON module it imports ("fetch a single module script"). */
const JSON_ACCEPT = 'application/json,*/*;q=0.5';

/**
 * What a browser accepts for a file a page asks for as `destination` (`Sec-Fetch-Dest`): an image
 * by the types it names for one, a style sheet as every browser asks for one, and anything else —
 * a script, a font, a fetch — as any type.
 */
function acceptFor(browser: Browser, destination: string): string {
  if (destination === 'image') {
    return browser.imageAccept;
  }
  if (destination === 'json') {
    return JSON_ACCEPT;
  }
  return destination === 'style' ? STYLE_ACCEPT : ANY_ACCEPT;
}

/**
 * A browser's request for a file of a page — a script, a style sheet, an image — accepting what it
 * accepts for one of its kind: its agent, its language and its hints, as it sends them beside a
 * navigation, but the upgrade it asks for with a navigation alone.
 */
function fileRequestWith(browser: Browser, destination: string): Record<string, string> {
  const own = Object.entries(browser.navigation).filter(
    ([name]) => name !== UPGRADE_INSECURE_REQUESTS,
  );
  return {
    ...Object.fromEntries(own),
    accept: acceptFor(browser, destination),
    'accept-encoding': 'identity',
  };
}

/**
 * A JSON MIME type, as the HTML standard names one: `application/json`, `text/json`, or any whose
 * subtype ends `+json` — what a page imports as a JSON module (`with { type: 'json' }`), or fetches.
 */
const JSON_TYPE = /^(?:application\/json|text\/json|[^/]+\/[^/]+\+json)$/u;
/** The kind of a file of a JSON MIME type, which a page fetches or imports as a module. */
const JSON_KIND = 'json';

/** What a request a page's script makes (`fetch()`, `XMLHttpRequest`) is for: nothing it names. */
const FETCHED = 'empty';
/** What a browser asks a file of one of these types for, by the element or link that loads it. */
const DESTINATION_TYPES: ReadonlyMap<string, string> = new Map([
  ['application/manifest+json', 'manifest'],
  ['text/css', 'style'],
  ['text/vtt', 'track'],
]);
/** What a browser asks a file of a type under one of these for, by the element that loads it. */
const DESTINATION_PREFIXES: readonly (readonly [prefix: string, destination: string])[] = [
  ['image/', 'image'],
  ['audio/', 'audio'],
  ['video/', 'video'],
  ['font/', 'font'],
];

/**
 * What a browser asks a file for (`Sec-Fetch-Dest`), by the type it is served as: a page loads a
 * script, a style sheet, an image, a font, a sound, a video or its text track by an element of that
 * kind, and its manifest by a link, and fetches anything else; an HTML file is a page a visitor
 * goes to, as well.
 */
function destinationOf(contentType: string): string {
  if (isHtmlContentType(contentType)) {
    return 'document';
  }
  const [media = ''] = contentType.toLowerCase().split(';', 1);
  const type = media.trim();
  if (type.endsWith('javascript') || type.endsWith('ecmascript')) {
    return 'script';
  }
  return (
    DESTINATION_TYPES.get(type) ??
    DESTINATION_PREFIXES.find(([prefix]) => type.startsWith(prefix))?.[1] ??
    (JSON_TYPE.test(type) ? JSON_KIND : FETCHED)
  );
}

/** A request for a file: what it is for (`Sec-Fetch-Dest`), and how it is made (`Sec-Fetch-Mode`). */
type FileFetch = readonly [destination: string, mode: string];
const NO_CORS = 'no-cors';
const CORS = 'cors';
const SAME_ORIGIN = 'same-origin';

/**
 * The requests a browser makes for a file of each kind: an element's load without CORS, or with
 * it — a module script, or an element that asks for it (`crossorigin`, which Next.js writes on its
 * own tags where `crossOrigin` is set) — and the script a worker of any kind a page starts runs — from
 * the page's own origin alone (`same-origin`), whether classic or a module ("fetch a single module
 * script" in the HTML standard sets a top-level worker script's mode so) — and each module a module
 * worker imports, under CORS with the worker's destination, as an import is fetched. A text track is loaded from the page's own origin alone, or under CORS. A JSON file is
 * fetched, or imported as a JSON module, under CORS with its own destination (`json`). A font, a
 * manifest, or anything else fetched, is asked under CORS alone — and every file is fetched by a
 * page's script besides (`fetchesOf`).
 */
const FILE_FETCHES: Readonly<Record<string, readonly FileFetch[]>> = {
  script: [
    ['script', NO_CORS],
    ['script', CORS],
    ['worker', SAME_ORIGIN],
    ['worker', CORS],
    ['sharedworker', SAME_ORIGIN],
    ['sharedworker', CORS],
    ['serviceworker', SAME_ORIGIN],
    ['serviceworker', CORS],
  ],
  style: [
    ['style', NO_CORS],
    ['style', CORS],
  ],
  image: [
    ['image', NO_CORS],
    ['image', CORS],
  ],
  audio: [
    ['audio', NO_CORS],
    ['audio', CORS],
  ],
  video: [
    ['video', NO_CORS],
    ['video', CORS],
  ],
  track: [
    ['track', SAME_ORIGIN],
    ['track', CORS],
  ],
  [JSON_KIND]: [
    [FETCHED, CORS],
    ['json', CORS],
  ],
};
/**
 * The requests a browser makes for a file of `kind` (`FILE_FETCHES`), and a fetch of it besides — a
 * page's script fetches a file of any type (`fetch()`), under CORS, whatever an element would ask it
 * for by.
 */
function fetchesOf(kind: string): readonly FileFetch[] {
  const own = FILE_FETCHES[kind] ?? [[kind, CORS]];
  return own.some(([destination]) => destination === FETCHED) ? own : [...own, [FETCHED, CORS]];
}

/** What a page embeds a file of any type by, as a document of its own: `<embed>`, `<object>`. */
const EMBEDDING_DESTINATIONS: readonly string[] = ['embed', 'object'];
/** What a browser says of a service worker's script it asks for. */
const SERVICE_WORKER: Readonly<Record<string, string>> = { 'service-worker': 'script' };

/** Where a page that asks for a file is: on the file's own site, or on another. */
const CROSS_SITE = 'cross-site';
/** Where a navigation the browser makes itself comes from — typed, a bookmark: no page. */
const NO_SITE = 'none';
/** A page of the same site under another origin of it (`siblingOriginOf`). */
const SAME_SITE = 'same-site';
/**
 * The origins another site's page is put under, which a CORS request from it carries (`Origin`):
 * the first whose site is not the target's (`otherSiteOf`).
 */
const OTHER_ORIGINS: readonly [string, string] = [
  'https://elsewhere.example',
  'https://elsewhere.test',
];
/**
 * Where a navigation comes from, as a browser says it: typed, a link of the site's own page, of a
 * page of the same site under another origin, of another site's.
 */
const NAVIGATION_SITES: readonly string[] = [NO_SITE, SAME_ORIGIN, SAME_SITE, CROSS_SITE];

/** The ports a page of the site is put under, to be another origin of it. */
const SIBLING_PORT = '8443';
const OTHER_SIBLING_PORT = '9443';

/**
 * Another origin of the same site as `url`'s: its host under another port, which only the origin
 * tells apart — a site is its scheme and its registrable domain, whatever the port. Not a subdomain
 * of the host: one of a host that is a public suffix itself (`github.io`), or an address, is
 * another site, and which hosts are takes the public suffix list to say.
 */
function siblingOriginOf(url: URL): string {
  const port = url.port === SIBLING_PORT ? OTHER_SIBLING_PORT : SIBLING_PORT;
  return `https://${url.hostname}:${port}`;
}

/**
 * The origin of a page of another site than `url`'s: of `OTHER_ORIGINS`, the first whose host is
 * neither `url`'s nor a domain of it, nor under it — a host under the other's would share its
 * registrable domain, and be the same site, as `--hostname` may name one.
 */
function otherSiteOf(url: URL): string {
  const host = url.hostname;
  const [first, second] = OTHER_ORIGINS;
  const { hostname: other } = new URL(first);
  const apart = host !== other && !host.endsWith(`.${other}`) && !other.endsWith(`.${host}`);
  return apart ? first : second;
}

/**
 * The origin of the page a request comes from, by where `site` says: the site's own, another origin
 * of the same site (`siblingOriginOf`), or another site's (`otherSiteOf`). None for a navigation
 * typed.
 */
function pageOriginOf(site: string, url: URL): string | undefined {
  switch (site) {
    case SAME_ORIGIN: {
      return url.origin;
    }
    case SAME_SITE: {
      return siblingOriginOf(url);
    }
    case CROSS_SITE: {
      return otherSiteOf(url);
    }
    default: {
      return undefined;
    }
  }
}

/**
 * A page's URL as a browser says it in `Referer`: without its fragment, or a user and password it
 * names (Referrer Policy, "strip url for use as a referrer").
 */
export function referrerOf(url: URL): string {
  const said = new URL(url);
  said.hash = '';
  said.username = '';
  said.password = '';
  return said.href;
}

/**
 * The page a request comes from, as a browser says it (`Referer`): a page of the site's own, whole
 * (`referrerOf`); one of another origin, of the same site or another, by its origin alone, as every
 * browser's default policy has it (`strict-origin-when-cross-origin`); none for a navigation typed.
 */
function refererOf(site: string, url: URL, from?: URL): Readonly<Record<string, string>> {
  const page = pageOriginOf(site, url);
  if (page === undefined) {
    return {};
  }
  return { referer: site === SAME_ORIGIN ? referrerOf(from ?? new URL('/', url)) : `${page}/` };
}

/**
 * `navigation` as made from where `site` says, saying the page it came from (`refererOf`): by the
 * visitor — typed, or a link clicked — as a browser says of one (`Sec-Fetch-User: ?1`), then by a
 * page's own script (`location.assign()`), which says nothing of a visitor. One from nowhere
 * (`none`) is the browser's own — typed, a bookmark — which no page's script makes.
 */
function navigationsFrom(
  navigation: Readonly<Record<string, string>>,
  from: { readonly site: string; readonly url: URL; readonly page?: URL | undefined },
): Record<string, string>[] {
  const referer = refererOf(from.site, from.url, from.page);
  const made = { ...navigation, 'sec-fetch-site': from.site, ...referer };
  const visited = { ...made, 'sec-fetch-user': '?1' };
  return from.site === NO_SITE ? [visited] : [visited, made];
}

/**
 * Where a navigation came from, in a verdict's words, by what it says of it (`Sec-Fetch-Site`):
 * nothing of one typed or bookmarked, the navigation as such.
 */
const CAME_FROM: Readonly<Record<string, string>> = {
  [NO_SITE]: '',
  [SAME_ORIGIN]: ', from a page of its own origin',
  [SAME_SITE]: ', from a page of the same site',
  [CROSS_SITE]: ", from another site's page",
};

/** What a navigation says of where it came from (`navigationsFrom`), which another says otherwise. */
export const CONTEXT_HEADERS: readonly string[] = ['referer', 'sec-fetch-site', 'sec-fetch-user'];

/** What a navigation a page's script made says, in a verdict's words, after where it came from. */
const BY_SCRIPT = ', by its script';

/**
 * `navigation` as a visitor makes it from each place a navigation comes from (`navigationsFrom`):
 * typed or bookmarked, a link of a page of the site's own — each of `pages` where any are given, the
 * site's root page else — of a page of the same site under another origin, and of another site's —
 * and, from each of those pages, as its script makes it, which says nothing of a visitor (no
 * `Sec-Fetch-User`) — each in a verdict's words.
 */
export function visitedNavigations(
  navigation: Readonly<Record<string, string>>,
  url: URL,
  pages: readonly URL[] = [],
): { readonly headers: Record<string, string>; readonly as: string }[] {
  const root = new URL('/', url).href;
  return NAVIGATION_SITES.flatMap((site) => {
    const froms = site === SAME_ORIGIN && pages.length > 0 ? pages : [undefined];
    return froms.flatMap((page) => {
      const [visited, made] = navigationsFrom(navigation, { site, url, page });
      const own = page !== undefined && page.href !== root;
      const from = own ? `, from ${page.pathname}${page.search}` : (CAME_FROM[site] ?? site);
      return [
        ...(visited === undefined ? [] : [{ headers: visited, as: from }]),
        ...(made === undefined ? [] : [{ headers: made, as: `${from}${BY_SCRIPT}` }]),
      ];
    });
  });
}

/** `navigation` as made from each place a navigation comes from (`navigationsFrom`). */
function contextualNavigations(
  navigation: Readonly<Record<string, string>>,
  url: URL,
): Record<string, string>[] {
  return NAVIGATION_SITES.flatMap((site) => navigationsFrom(navigation, { site, url }));
}

/**
 * The Fetch Metadata a browser sends with a request for a file, from a page of `site` — the origin
 * of that page, which a CORS request from another origin carries (`Origin`), and the page itself,
 * which every one carries (`refererOf`).
 */
function fetchMetadataOf(
  destination: string,
  mode: string,
  from: { readonly site: string; readonly url: URL },
): Readonly<Record<string, string>> {
  const { site } = from;
  const page = pageOriginOf(site, from.url);
  // A CORS request names the page's origin where it is another than the file's — and an element's
  // (a module script, one marked `crossorigin`) where it is the same, as every browser names it
  // there: only a fetch from the page's own origin (`empty`) leaves it unsaid, as the Fetch
  // Standard has a request of `basic` tainting that `GET`s.
  const named = mode === CORS && (site !== SAME_ORIGIN || destination !== FETCHED);
  return {
    'sec-fetch-dest': destination,
    'sec-fetch-mode': mode,
    'sec-fetch-site': site,
    ...(named && page !== undefined && { origin: page }),
    ...refererOf(site, from.url),
  };
}

/** A navigation as made with `sent` beside it. */
function navigationWith(sent: Readonly<Record<string, string>>): Record<string, string> {
  // Asked for whole, as a deployment's validation asks, with the header a rule may ask of.
  return {
    ...NAVIGATION_REQUEST_HEADERS,
    accept: 'text/html',
    'accept-encoding': 'identity',
    ...sent,
  };
}

/**
 * Each request `browser` makes for a file of a kind (`destinationOf`), as it makes it: each of the
 * requests it makes for one (`FILE_FETCHES`), with what it accepts for each, from a page of the
 * site's own and then of another site's — and an HTML file as the page a visitor goes to, as one a
 * page frames (`iframe`), then as what a fetch answers, and as one a page embeds (`embed`,
 * `object`), which the HTML Standard shows a page in as well.
 */
function requestsFor(browser: Browser, kind: string, url: URL): Record<string, string>[] {
  const own = { site: SAME_ORIGIN, url };
  // Pages of another origin: of the same site, then of another site.
  const afar = [
    { site: SAME_SITE, url },
    { site: CROSS_SITE, url },
  ];
  if (kind === 'document') {
    const navigation = navigationWith(browser.navigation);
    const fetched = fileRequestWith(browser, FETCHED);
    // As the page a visitor goes to — typed, then from a link of a page of the site's own, of the
    // same site's under another origin, of another site's — as one a page frames, as what a fetch
    // answers and as one a page embeds, from a page of the site's own, then of another origin's.
    return [
      navigation,
      ...contextualNavigations(navigation, url),
      ...[own, ...afar].flatMap((from) => {
        const fetchedFrom = { ...fetched, ...fetchMetadataOf(FETCHED, CORS, from) };
        return [framedFrom(navigation, from), fetchedFrom, ...embeddedFrom(browser, from)];
      }),
    ];
  }
  const fetches = fetchesOf(kind);
  const fromOwn = fetches.map(([destination, mode]) => {
    return {
      ...fileRequestWith(browser, destination),
      ...fetchMetadataOf(destination, mode, own),
      ...(destination === 'serviceworker' && SERVICE_WORKER),
    };
  });
  // And from a page of another origin — a public file anyone may embed — but for what a page
  // loads from its own origin alone (`same-origin`): a worker's own script, a track it frames as
  // its own. A module a worker of another origin imports is asked under CORS with that worker's
  // destination, as every module of its graph is (HTML's "fetch a module worker script graph") —
  // a service worker's with the header its update sends with each, whether or not it is the
  // worker's own script (the Service Workers update algorithm's fetch hook).
  const embeddable = fetches.filter(([, mode]) => mode !== SAME_ORIGIN);
  const fromAfar = afar.flatMap((from) => {
    return embeddable.map(([destination, mode]) => {
      return {
        ...fileRequestWith(browser, destination),
        ...fetchMetadataOf(destination, mode, from),
        ...(destination === 'serviceworker' && SERVICE_WORKER),
      };
    });
  });
  return [...fromOwn, ...fromAfar];
}

/** `navigation` as a page of `from.site` frames what it navigates to (`<iframe>`). */
function framedFrom(
  navigation: Readonly<Record<string, string>>,
  from: { readonly site: string; readonly url: URL },
): Record<string, string> {
  return { ...navigation, ...fetchMetadataOf('iframe', 'navigate', from) };
}

/**
 * What a browser asks for any file by, whatever its type: the page a visitor goes to (`document`) —
 * typed, or a link of a page of the site's own, of the same site under another origin, of another
 * site's — and what a page embeds (`<embed>`, `<object>`) or frames (`<iframe>`), each navigated to
 * as well (`navigate`): a PDF, say, as a page shows one.
 */
function openedAs(browser: Browser, url: URL): Record<string, string>[] {
  const navigation = navigationWith(browser.navigation);
  const navigated = contextualNavigations(navigation, url);
  const embedded = [SAME_ORIGIN, SAME_SITE, CROSS_SITE].flatMap((site) => {
    const from = { site, url };
    return [...embeddedFrom(browser, from), framedFrom(navigation, from)];
  });
  return [navigation, ...navigated, ...embedded];
}

/** `browser`'s requests for a file a page of `from.site` embeds, a document of its own. */
function embeddedFrom(
  browser: Browser,
  from: { readonly site: string; readonly url: URL },
): Record<string, string>[] {
  return EMBEDDING_DESTINATIONS.map((destination) => {
    return {
      ...fileRequestWith(browser, destination),
      ...fetchMetadataOf(destination, 'navigate', from),
    };
  });
}

/**
 * A navigation as the check's own agent makes one, as a deployment's validation makes its probe of
 * each Function as its prover (`probe.ts`): what a rule of `next.config` is judged by, and what an
 * application that answers browsers otherwise is asked as.
 */
export function proverNavigation(agent: string): Readonly<Record<string, string>> {
  return navigationWith({ [USER_AGENT]: agent });
}

/**
 * Whether the edge hands a navigation with these headers to the Function rather than serving the
 * shell: the application sends its agent blocking metadata (`htmlLimitedBots`), unless the build
 * finished the page, or the route's `bypassFor` holds for it.
 */
function passedOn(
  manifest: ProjectManifest,
  route: RouteEntry,
  url: URL,
  headers: Headers,
): boolean {
  return (
    sentBlockingMetadata(manifest, route, headers) || bypassForHolds(route, url, headers, manifest)
  );
}

/**
 * Whether the application sends the agent of a navigation with these headers blocking metadata
 * (`htmlLimitedBots`), which the edge leaves the Function to render — but where the build finished
 * the page: decided of the agent the request names, before any middleware runs.
 */
export function sentBlockingMetadata(
  manifest: ProjectManifest,
  route: RouteEntry,
  headers: Headers,
): boolean {
  return (
    route.cache?.delivery !== 'complete' && wantsBlockingMetadata(headers.get(USER_AGENT), manifest)
  );
}

/** Whether a rule asks of what a check makes up for a browser, but for `apartFrom`. */
function asksOfBrowser(rule: ReservedRoute, apartFrom?: string): boolean {
  return [...(rule.has ?? []), ...(rule.missing ?? [])].some((condition) => {
    const key = condition.key?.toLowerCase();
    return (
      condition.type === 'header' &&
      key !== undefined &&
      key !== apartFrom &&
      (SAMPLED_HEADERS.has(key) ||
        key.startsWith(CLIENT_HINT_PREFIX) ||
        key.startsWith(FETCH_METADATA_PREFIX))
    );
  });
}

/**
 * How a page or a file is asked: as a browser, or not at all — the application's, or proved by
 * none.
 */
export type Sampled =
  | {
      readonly kind: 'asked';
      readonly headers: Readonly<Record<string, string>>;
      /**
       * The query it is asked with, where it carries what a rule claims a request without
       * (`escaping`): `?` and all, or none.
       */
      readonly search?: string;
    }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'unproved'; readonly reason: string };

/**
 * How a page is asked: as a file is (`Sampled`) — or not at all where the edge hands every request
 * the check could make to the Function, for Next.js to render itself: the route's `bypassFor`
 * holds even for one that names no agent.
 */
export type Navigation = Sampled | { readonly kind: 'bypassed' };

/** A file of the build, which a browser asks for by each type it may be served as. */
interface FileTarget extends Target {
  readonly contentTypes: readonly string[];
}

/** A page, which the edge may pass on to its Function for an agent (`passedOn`). */
interface Page extends Target {
  readonly route: RouteEntry;
}

/**
 * A request's headers as it is sent to `target`: under the site's origin — the `Host` its URL
 * names, and the forwarding headers beside it, as a deployment's validation sends them
 * (`forwarded`: HTTPS, as a site is reached deployed, whatever scheme reaches the stack) — each of
 * which a rule of `next.config` may ask of (`missing: host`), so that a rule is judged on what the
 * edge is sent.
 */
function sentTo(target: Target, headers: Record<string, string>): Record<string, string> {
  return forwarded(target.url, headers);
}

/**
 * Of `asked`, every one claimed for any agent: the first carrying what a rule claims it without
 * (`escaping`) — a cookie, say, which a visitor's browser may carry, and be served what the check
 * would not otherwise have asked for — that is `served` as the target; else claimed, or proved by
 * no request where only a value the check finds none of would pass a rule over.
 */
function claimedOrEscaping(
  target: Target,
  asked: readonly Readonly<Record<string, string>>[],
  served: (headers: Readonly<Record<string, string>>, url: URL) => boolean,
): Sampled {
  let unproved: string | undefined;
  for (const sample of asked) {
    const escape = escaping(target, sample, served);
    if (escape.kind === 'escaped') {
      const { search } = escape.url;
      return { kind: 'asked', headers: escape.headers, ...(search !== '' && { search }) };
    }
    if (escape.kind === 'unproved') {
      unproved ??= escape.reason;
    }
  }
  return unproved === undefined ? { kind: 'claimed' } : { kind: 'unproved', reason: unproved };
}

/**
 * The first of `asked` no rule of `next.config` claims; or, every one claimed, whether the rules
 * claim the target as any agent (`claimedOrEscaping`) or ask of the agent (`undefined`): one the
 * check does not ask as may be answered from the build.
 */
function unclaimedOf(
  target: Target,
  asked: readonly Readonly<Record<string, string>>[],
  served: (headers: Readonly<Record<string, string>>, url: URL) => boolean = () => true,
): Sampled | undefined {
  // As the target: a request the edge passes on is answered by another than it.
  const unclaimed = asked.find((headers) => {
    return (
      !isReserved(target.manifest, target.url, routedReads(target.url, headers), target.exact) &&
      served(headers, target.url)
    );
  });
  if (unclaimed !== undefined) {
    return { kind: 'asked', headers: unclaimed };
  }
  const anyAgent = asked.every((headers) =>
    claimedBy(target, headers, (rule) => !asksOfBrowser(rule)),
  );
  return anyAgent ? claimedOrEscaping(target, asked, served) : undefined;
}

/**
 * How a file of the build is asked at `url`: as every sampled browser no rule of `next.config` claims.
 * Claimed as every one, it is the application's where the rules claim it as any agent, and proved
 * by none where they ask of the agent: one the check does not ask as may be served the file.
 */
export function fileRequestsFor(file: FileTarget): readonly Sampled[] {
  const target = { ...file, requestClass: 'file' as const };
  // The check's own agent asks as validation's prover does, with nothing of a browser's, accepting
  // any type; each browser with what it accepts for a file of this type, and the Fetch Metadata it
  // sends for one, in each mode it may ask in — and, but for a page, as any file is opened.
  const destinations = [...new Set(target.contentTypes.map((type) => destinationOf(type)))];
  const opened = destinations.some((destination) => destination !== 'document');
  const asked = [
    sentTo(target, {
      [USER_AGENT]: target.prover,
      accept: ANY_ACCEPT,
      'accept-encoding': 'identity',
    }),
    ...BROWSERS.flatMap((browser) => {
      return [
        ...destinations.flatMap((destination) => requestsFor(browser, destination, target.url)),
        ...(opened ? openedAs(browser, target.url) : []),
      ].map((headers) => sentTo(target, headers));
    }),
  ];
  const unclaimed = asked.filter(
    (headers) =>
      !isReserved(target.manifest, target.url, routedReads(target.url, headers), target.exact),
  );
  return unclaimed.length > 0
    ? unclaimed.map((headers) => ({ kind: 'asked', headers }))
    : [unclaimedOf(target, asked) ?? { kind: 'unproved', reason: UNPROVED_FILE }];
}

/**
 * How a page is asked at `url`, as a deployment's validation asks it: as the first browser the
 * edge serves the shell to that no rule of `next.config` claims — or, where the edge serves it to
 * none of them, as one that names no agent. Claimed as every one of those, it is the application's
 * (`claimed`) where the rules claim it as any agent, and proved by none (`unproved`) where they ask
 * of the agent: one the check does not ask as may be served the shell.
 */
export function navigationFor(page: Page): Navigation {
  const { manifest, route, url } = page;
  const navigations = [
    navigationWith({ [USER_AGENT]: page.prover }),
    ...BROWSERS.flatMap((browser) => {
      // Asked as validation asks first, then as a browser says where the navigation came from:
      // typed or bookmarked, a link of the site's own page, of a page of the same site under
      // another origin, of another site's — and which page that was (`refererOf`). A page in a frame
      // is no navigation the edge serves the shell to (`classifyRequest`), and is asked as none.
      const navigation = navigationWith(browser.navigation);
      return [navigation, ...contextualNavigations(navigation, url)];
    }),
  ];
  const served = navigations
    .map((headers) => sentTo(page, headers))
    .filter((headers) => !passedOn(manifest, route, url, edgeReads(headers)));
  const anonymous = served.length === 0;
  // One that names no agent sends no `User-Agent` at all, rather than one that says nothing.
  const asked = anonymous ? [sentTo(page, navigationWith({}))] : served;
  // A request carrying what a rule claims the samples without is one the edge serves the shell to.
  const shellServed = (headers: Readonly<Record<string, string>>, at: URL): boolean =>
    !passedOn(manifest, route, at, edgeReads(headers));
  // No request names no agent for a list of crawlers to name: one passed on is passed on for the
  // route's `bypassFor`, which holds then for every request the check could make.
  if (anonymous && asked.every((headers) => !shellServed(headers, url))) {
    return { kind: 'bypassed' };
  }
  const sampled = unclaimedOf(page, asked, shellServed);
  if (sampled !== undefined) {
    return sampled;
  }
  if (!anonymous) {
    return { kind: 'unproved', reason: UNPROVED_CLAIMED };
  }
  // Every agent that names one passed on, the shell goes only to a request that names none: a rule
  // that claims every such request (`missing: user-agent`) claims every request it would go to.
  if (!passesOnEveryAgent(route, manifest)) {
    return { kind: 'unproved', reason: UNPROVED_ANONYMOUS };
  }
  const everyAnonymous = asked.every((headers) =>
    claimedBy(page, headers, (rule) => !asksOfBrowser(rule, USER_AGENT)),
  );
  return everyAnonymous
    ? claimedOrEscaping(page, asked, shellServed)
    : { kind: 'unproved', reason: UNPROVED_ANONYMOUS_SAMPLE };
}
