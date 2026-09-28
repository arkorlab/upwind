/**
 * Wire-level constants of Next.js 16.3 that the edge must recognise.
 * Values verified against `next/dist/client/components/app-router-headers.js` and
 * `next/dist/lib/constants.js`.
 */

export const RSC_HEADER = 'rsc';
export const NEXT_ACTION_HEADER = 'next-action';
export const NEXT_ROUTER_STATE_TREE_HEADER = 'next-router-state-tree';
export const NEXT_ROUTER_PREFETCH_HEADER = 'next-router-prefetch';
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch';
/**
 * What an answer to a client router's request varies on, as Next.js says it (`setVaryHeader`,
 * `server/base-server.ts`): the request for React Server Components and what the router sends
 * beside it.
 */
export const RSC_VARY = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
].join(', ');
export const NEXT_URL_HEADER = 'next-url';
export const NEXT_RESUME_HEADER = 'next-resume';
export const NEXT_RESUME_STATE_LENGTH_HEADER = 'x-next-resume-state-length';
export const NEXT_DID_POSTPONE_HEADER = 'x-nextjs-postponed';
export const NEXT_IS_PRERENDER_HEADER = 'x-nextjs-prerender';
/**
 * Marks a Pages Router data request for the middleware and the page. A client cannot send it, since
 * it is one of the headers stripped below, so whoever routes the request sets it from the path.
 */
export const NEXT_DATA_HEADER = 'x-nextjs-data';
export const NEXT_STALE_TIME_HEADER = 'x-nextjs-stale-time';
export const NEXT_DEPLOYMENT_ID_RESPONSE_HEADER = 'x-nextjs-deployment-id';
export const DEPLOYMENT_ID_REQUEST_HEADER = 'x-deployment-id';
export const RSC_CONTENT_TYPE = 'text/x-component';
export const RSC_CACHE_BUSTING_QUERY = '_rsc';
export const SEGMENT_TREE_PATH = '/_tree';

/**
 * Cookies that change what Next.js serves; requests carrying them are never served from the edge.
 *
 * Draft mode's pair (`__prerender_bypass`, `__next_preview_data`) asks for a render the build's
 * prerender is not, and the last is the edge's own recovery cookie.
 */
export const BYPASS_COOKIE_NAMES: readonly string[] = [
  '__prerender_bypass',
  '__next_preview_data',
  'next-instant-navigation-testing',
  '__arkor_edge_bypass',
];
/**
 * The deployment a client is pinned to, as Next.js's own skew protection writes it
 * (`experimental.useSkewCookie`). Read here, never set: the edge answers the deployment the
 * pointer names and proxies a request that asks for another.
 */
export const SKEW_PROTECTION_COOKIE = '__vdpl';
export const EDGE_BYPASS_COOKIE = '__arkor_edge_bypass';
export const EDGE_BYPASS_COOKIE_MAX_AGE_SECONDS = 30;
/**
 * The recovery script refuses to reload again within this window. It exists for the case where the
 * bypass cookie does not stick (cookies disabled or dropped): reload → edge again → fail → reload.
 * It must therefore be *shorter* than the cookie: once the cookie has expired a repeat failure must
 * recover again (set the cookie, reload), and a guard still in force would instead leave the
 * visitor on the truncated page with nothing done. One extra load per cookie lifetime is the price
 * of a route that keeps failing, and the only way that visitor ever gets a complete page.
 */
export const RECOVERY_LOOP_GUARD_SECONDS = 10;

/** Query parameters that opt a request out of edge delivery. */
export const BYPASS_QUERY_KEYS: readonly string[] = ['__nextDataReq', '__prerender_bypass'];
/**
 * Query keys Next.js reads its own route parameters from (`nxtPslug`), and interception markers
 * (`nxtI…`). A request carrying one asks the application for a parameter its path does not name.
 */
export const BYPASS_QUERY_PREFIXES: readonly string[] = ['nxtP', 'nxtI'];
export const DEPLOYMENT_ID_QUERY = 'dpl';

/**
 * Fetch metadata of a top-level browser navigation. The edge serves a shell to nothing else, and
 * every request made on the edge's behalf — validation, the bench — carries the same two headers,
 * so an application that branches on them is exercised as live traffic will ask it.
 */
export const NAVIGATION_REQUEST_HEADERS = {
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
} as const;

/**
 * Headers a browser adds to a speculative document fetch (prefetch, prerender), current and
 * legacy spellings. The request is still a navigation, and a shell is served to it as to any
 * other: a browser adopts one still in flight as the navigation the visitor then makes. What they
 * tell apart is a guess, for whatever must not act on one — the response may be thrown away unread.
 */
export const PREFETCH_HINT_HEADERS: readonly string[] = ['sec-purpose', 'purpose', 'x-moz'];

/** Request headers that must never be forwarded from clients to the origin. */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'expect',
];
export const INTERNAL_REQUEST_HEADERS: readonly string[] = [
  NEXT_RESUME_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  NEXT_DATA_HEADER,
  'x-real-ip',
  'host',
];
const NEXTJS_HEADER_PREFIX = 'x-nextjs-';
const CLOUDFLARE_HEADER_PREFIX = 'cf-';
/**
 * The platform's own headers: a client must not be able to speak to a runtime as the edge, and
 * what a runtime says to the edge on a response must not reach a client.
 */
export const PLATFORM_HEADER_PREFIX = 'x-arkor-';
/**
 * What a client's router sends under a prefix that is otherwise the platform's to strip: Next.js's
 * Pages Router marks a prefetch it makes through a middleware so, and Next.js leaves the header on
 * the request (`INTERNAL_HEADERS`, `server/lib/server-ipc/utils.ts`, does not name it), for the
 * server to answer it without rendering and for a middleware to tell a prefetch apart.
 */
export const MIDDLEWARE_PREFETCH_HEADER = 'x-middleware-prefetch';
export const INTERNAL_REQUEST_HEADER_PREFIXES: readonly string[] = [
  'x-middleware-',
  'x-prerender-',
  NEXTJS_HEADER_PREFIX,
  'x-invoke-',
  CLOUDFLARE_HEADER_PREFIX,
  'x-forwarded-',
  PLATFORM_HEADER_PREFIX,
];

/** Client-side router protocol headers: passed through untouched, never used for edge decisions. */
export const ROUTER_PROTOCOL_HEADERS: readonly string[] = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_URL_HEADER,
  NEXT_ACTION_HEADER,
];

/**
 * Browser actions that cannot be preserved after the shell response headers have been sent.
 *
 * Presence alone is the answer for these. `content-disposition` is not one of them — its default
 * value asks for exactly the rendering a document response already gets — so it is named separately
 * and read with `rendersInline`.
 */
export const BEHAVIORAL_RESPONSE_HEADERS: readonly string[] = ['clear-site-data', 'refresh'];
export const CONTENT_DISPOSITION_HEADER = 'content-disposition';

/** Response headers the build recorded that may be replayed with an edge-served shell. */
export const SHELL_RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  'content-type',
  'content-language',
  'vary',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'referrer-policy',
  'permissions-policy',
  'x-content-type-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'link',
  'x-robots-tag',
  'x-dns-prefetch-control',
  'accept-ch',
  'critical-ch',
  'origin-agent-cluster',
];

/**
 * Response headers a response kept whole is never replayed with — a route handler's, which the
 * deployment's Function answers from its generation as the handler answered it.
 *
 * What belonged to the one transmission it was captured from: its framing, its encoding (the
 * record keeps the bytes as they are), its date and age, and the lifetime it went out with, which
 * the record's policy states and the Function answers for itself. What belonged to the one visitor
 * it answered: a cookie. And what Next.js tells the platform on a response rather than the client
 * — the tags it was rendered with, which the record carries as tags of its own.
 */
export const STORED_RESPONSE_HEADER_DENYLIST: readonly string[] = [
  'set-cookie',
  'cache-control',
  'age',
  'date',
  'expires',
  'pragma',
  'content-length',
  'content-encoding',
  ...HOP_BY_HOP_HEADERS,
  'x-next-cache-tags',
];
/** Next.js's, Cloudflare's, the router's and the platform's own: none of them the application's. */
export const STORED_RESPONSE_HEADER_DENY_PREFIXES: readonly string[] = [
  NEXTJS_HEADER_PREFIX,
  CLOUDFLARE_HEADER_PREFIX,
  'x-middleware-',
  PLATFORM_HEADER_PREFIX,
];

/**
 * Response headers that are never replayed with a shell: none that a stored response is not, and
 * besides them the validators of a document a resume has yet to complete and what speaks for the
 * origin's own connection.
 */
export const RESPONSE_HEADER_DENYLIST: readonly string[] = [
  ...STORED_RESPONSE_HEADER_DENYLIST,
  'etag',
  'last-modified',
  'server',
  'alt-svc',
  'report-to',
  'nel',
];
export const RESPONSE_HEADER_DENY_PREFIXES: readonly string[] = [
  NEXTJS_HEADER_PREFIX,
  CLOUDFLARE_HEADER_PREFIX,
];

/**
 * Cache directives addressed to shared caches rather than to the client.
 *
 * A cache that reads them takes `Cloudflare-CDN-Cache-Control`, then `CDN-Cache-Control`, before
 * it looks at `Cache-Control` — so an origin that sends one of them decides the storage no matter
 * what the edge says. A credentialed document or an RSC response would then be held and replayed
 * to the next visitor. The edge answers for its own caching, so these never survive a response it
 * did not originate.
 */
export const SHARED_CACHE_CONTROL_HEADERS: readonly string[] = [
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'surrogate-control',
];

/** Headers hidden from proxied (passthrough) responses. */
export const PASSTHROUGH_RESPONSE_HEADER_DENYLIST: readonly string[] = [
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  ...SHARED_CACHE_CONTROL_HEADERS,
];

/** Header value the edge sends for documents and everything that must not be cached. */
export const NO_STORE_CACHE_CONTROL = 'private, no-store';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const CONTINUATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/**
 * The 3xx statuses Fetch and a browser follow to the `Location` given: what a committed 200 shell
 * can never carry.
 */
export const REDIRECT_STATUS = {
  found: 302,
  movedPermanently: 301,
  permanentRedirect: 308,
  seeOther: 303,
  temporaryRedirect: 307,
} as const;
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set<number>(
  Object.values(REDIRECT_STATUS),
);
/**
 * The statuses a response carries no body under: Fetch's null body statuses. `Response` refuses
 * a body under any of them — an empty one included, which is what a captured `204` becomes.
 */
export const NULL_BODY_STATUS = {
  switchingProtocols: 101,
  earlyHints: 103,
  noContent: 204,
  resetContent: 205,
  notModified: 304,
} as const;
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set<number>(
  Object.values(NULL_BODY_STATUS),
);

/**
 * Next.js bot lists (`shared/lib/router/utils/html-bots.js`, `is-bot.js`), expressed without
 * backtracking: the two Google patterns need one adjacent word character, the rest are substrings.
 */
const HTML_LIMITED_BOT_TOKENS: readonly string[] = [
  'chrome-lighthouse',
  'slurp',
  'duckduckbot',
  'baiduspider',
  'yandex',
  'sogou',
  'bitlybot',
  'tumblr',
  'vkshare',
  'quora link preview',
  'redditbot',
  'ia_archiver',
  'bingbot',
  'bingpreview',
  'applebot',
  'facebookexternalhit',
  'facebookcatalog',
  'twitterbot',
  'linkedinbot',
  'slackbot',
  'discordbot',
  'whatsapp',
  'skypeuripreview',
  'yeti',
  'googleweblight',
];
const GOOGLE_CRAWLER_RE = /[\w-]-google|google-[\w-]/iu;
const DOM_BOT_UA_RE = /googlebot(?!-)/iu;

/** True for user agents Next.js serves with a blocking (non-streaming) render. */
export function isHtmlLimitedBotUserAgent(userAgent: string): boolean {
  const lower = userAgent.toLowerCase();
  return (
    GOOGLE_CRAWLER_RE.test(lower) || HTML_LIMITED_BOT_TOKENS.some((token) => lower.includes(token))
  );
}

/** True for the DOM-executing Googlebot as well as HTML-limited bots. */
export function isBotUserAgent(userAgent: string): boolean {
  return DOM_BOT_UA_RE.test(userAgent) || isHtmlLimitedBotUserAgent(userAgent);
}

/**
 * Longest pathname a route may have.
 *
 * A runtime mismatch is reported to the host with the pathname, and that channel bounds
 * what it will accept. A route longer than this could be served but never demoted: the signal
 * would be dropped as malformed and only the reporting isolate's own fuse would protect anyone.
 * A deployment is refused one up front.
 */
export const MAX_ROUTE_PATHNAME_LENGTH = 2048;

export const EDGE_DEBUG_HEADER = 'x-arkor-edge';
export const EDGE_VALIDATED_HEADER = 'x-arkor-edge-validated';
export const VALIDATION_HEADER = 'x-arkor-validation';
export const RECOVERY_MARKER = '<!--arkor-edge:recovery-->';
