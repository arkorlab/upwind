import type { Route as RoutingRoute } from '@next/routing';

/**
 * The path a rewritten payload was rendered for, as Next.js says it to a client router
 * (`x-nextjs-rewritten-path`): the rewrites routing applies carry a mark of where each went, and what
 * the marks say is settled once routing is done.
 */

/**
 * Where routing leaves the destination of each rewrite it applied, named for the table and the rule:
 * the platform's, never sent (`settleRewrittenPath`).
 */
const REWRITE_MARK = 'x-arkor-rewrite-';
const REWRITE_MARK_NAME = /^x-arkor-rewrite-(?<table>\d+)-(?<rule>\d+)$/u;
/** The tables that rewrite, in the order routing applies them; a middleware runs after the first. */
export const BEFORE_MIDDLEWARE = 0;
export const BEFORE_FILES = 1;
export const AFTER_FILES = 2;
export const FALLBACK = 3;
/** The path a payload was rendered for, when a rewrite changed it (`rewriteHeaders.pathHeader`). */
const REWRITTEN_PATH_HEADER = 'x-nextjs-rewritten-path';
const REDIRECTION = 300;
const CLIENT_ERROR = 400;
/** What makes `@next/routing` read a rule with a redirect's status as a redirect, not a rewrite. */
const REDIRECT_HEADERS: ReadonlySet<string> = new Set(['location', 'refresh']);

/** What of a rule tells a redirect from a rewrite. */
interface Redirecting {
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A rule `@next/routing` follows as a redirect: a redirect's status, and where to send the client. */
export function redirects(route: Redirecting): boolean {
  return (
    route.status !== undefined &&
    route.status >= REDIRECTION &&
    route.status < CLIENT_ERROR &&
    Object.keys(route.headers ?? {}).some((name) => REDIRECT_HEADERS.has(name.toLowerCase()))
  );
}

/** Characters past ASCII, which a header's value cannot carry as they are. */
const PAST_ASCII = /[\u{80}-\u{10FFFF}]+/gu;

/** A named group of a condition's pattern, which `@next/routing` fills a destination in from. */
const NAMED_GROUP = /\(\?<(?<name>[A-Za-z_$][\w$]*)>/gu;
const NOT_A_LETTER = /[^A-Za-z]/gu;

/**
 * The names a rule's query conditions fill its destination in by (`checkHasConditions` in
 * `@next/routing`): each one's key with all but its letters taken out, and the named groups of its
 * pattern.
 */
function queryNames(route: RoutingRoute): string[] {
  return (route.has ?? []).flatMap((condition) => {
    if (condition.type !== 'query') {
      return [];
    }
    const groups = [...(condition.value ?? '').matchAll(NAMED_GROUP)].map(
      (match) => match.groups?.['name'] ?? '',
    );
    return [condition.key.replaceAll(NOT_A_LETTER, ''), ...groups].filter((name) => name !== '');
  });
}

/**
 * Where a rule rewrites to, as a header's value can carry it — its own characters past ASCII escaped,
 * as a URL's path escapes them — or `undefined` for a rule whose destination takes in a query's
 * value, which can hold any character and is filled in as it is. A name is read as taken in wherever
 * the destination holds it after a `$`, as the start of a longer one too: `@next/routing` fills the
 * longest name it has in first, and a name it does not have leaves the shorter one to be filled.
 */
function markOf(route: RoutingRoute & { readonly destination: string }): string | undefined {
  if (queryNames(route).some((name) => route.destination.includes(`$${name}`))) {
    return undefined;
  }
  try {
    return route.destination.replaceAll(PAST_ASCII, (run) => encodeURIComponent(run));
  } catch {
    // A lone surrogate, which no URL spells.
    return undefined;
  }
}

/**
 * The rules of one table, each that rewrites carrying the platform's mark of where it rewrote to
 * (`settleRewrittenPath`), named for the table and the rule: `@next/routing` fills a rule's headers in
 * from its match as it fills its destination in, and applies the rules of a table in order. A rule
 * whose destination no header can carry (`markOf`) is not marked, and says nothing of the path.
 */
export function markedRewrites(routes: readonly RoutingRoute[], table: number): RoutingRoute[] {
  return routes.map((route, rule) => {
    const { destination } = route;
    const mark =
      destination === undefined || redirects(route) ? undefined : markOf({ ...route, destination });
    return mark === undefined
      ? route
      : { ...route, headers: { ...route.headers, [`${REWRITE_MARK}${table}-${rule}`]: mark } };
  });
}

/** A rewrite routing applied: its table, its rule, and the destination its mark was filled in with. */
interface Applied {
  readonly table: number;
  readonly rule: number;
  readonly to: string;
}

/**
 * Where a run of rewrites ends from `from`, and the path the last of them to change it changed it to
 * (`said`, where none did); `undefined` where one of them sends the request to another origin.
 */
function followed(
  rewrites: readonly Applied[],
  from: URL,
  said: string | undefined,
): { readonly at: URL; readonly said: string | undefined } | undefined {
  let at = from;
  let last = said;
  for (const rewrite of rewrites) {
    const target = new URL(rewrite.to, at);
    if (target.origin !== at.origin) {
      return undefined;
    }
    if (target.pathname !== at.pathname) {
      last = target.pathname;
    }
    at = target;
  }
  return { at, said: last };
}

/**
 * The path a payload was rendered for, where a rewrite changed it, said as Next.js says it: as
 * `x-nextjs-rewritten-path` on the response to a client router's request (`RSC: 1`), the destination
 * of the last rewrite to change the path it was handed (`resolve-routes.ts`; the routes manifest's
 * `rewriteHeaders` asks a platform to). The client reads its route's parameters off that path. A
 * middleware's rewrite that moves the path says its own (`server/web/adapter.ts`), over what any
 * rule before the middleware said; a rule after it says its own over the middleware's — the case
 * Next.js 16.4 fixed: an intercepting route reached through a middleware's rewrite was told of the
 * middleware's path, not its own (`interception-dynamic-segment-middleware`).
 *
 * Read off the marks the rewrites carry (`markedRewrites`), which are taken out whatever the request,
 * each rewrite compared with the path routing had handed it: the one it began with, or where the
 * rewrite before it, or the middleware's, left it. As in Next.js, a rewrite of the query alone says
 * nothing of the path, and nothing is said of a request rewritten to another origin — Next.js says
 * it for one its `clientParamParsingOrigins` admits, which this does not read. The locale `i18n` puts
 * in front of a path before any rule, which no client router's request of the App Router has, is not
 * taken off the path routing began with.
 */
export function settleRewrittenPath(
  headers: Headers | undefined,
  request: Headers,
  routedFrom: URL,
  middlewareRewrite: URL | undefined,
): void {
  if (headers === undefined) {
    return;
  }
  const applied: Applied[] = [];
  for (const [name, to] of headers) {
    const mark = REWRITE_MARK_NAME.exec(name)?.groups;
    if (mark !== undefined) {
      applied.push({ table: Number(mark['table']), rule: Number(mark['rule']), to });
    }
  }
  for (const { table, rule } of applied) {
    headers.delete(`${REWRITE_MARK}${String(table)}-${String(rule)}`);
  }
  // A middleware's rewrite to another origin is answered from there: nothing is said of it.
  if (
    request.get('rsc') !== '1' ||
    (middlewareRewrite !== undefined && middlewareRewrite.origin !== routedFrom.origin)
  ) {
    return;
  }
  const inOrder = applied.toSorted((a, b) => a.table - b.table || a.rule - b.rule);
  const before = followed(
    inOrder.filter((rewrite) => rewrite.table === BEFORE_MIDDLEWARE),
    routedFrom,
    undefined,
  );
  if (before === undefined) {
    return;
  }
  // A middleware's rewrite that moves the path says its own, which stands over what came before it;
  // one of the query alone says nothing of the path, and leaves what came before it standing.
  const moved =
    middlewareRewrite !== undefined && middlewareRewrite.pathname !== before.at.pathname;
  const heldOver = moved ? undefined : before.said;
  const after = followed(
    inOrder.filter((rewrite) => rewrite.table !== BEFORE_MIDDLEWARE),
    middlewareRewrite ?? before.at,
    heldOver,
  );
  if (after?.said !== undefined) {
    headers.set(REWRITTEN_PATH_HEADER, after.said);
  }
}
