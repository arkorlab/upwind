import { pageOfDataPathname, pagesDataPathnameUnder } from './pages-data.ts';

/**
 * Which route of a build a pathname is of, and where a rule of `next.config` may send a request:
 * what the gates a bundle declares are held to (`gateIssues`, in `schema.ts`), and what a manifest
 * carries for the edge to find a request's gate by (`gates.ts`), are both read off it.
 *
 * Written on the bundle's shape rather than its type, as the bundle's own schema reads it.
 */

/** What of a build names its routes: each entrypoint, each prerender, each file it ships. */
export interface BuildNames {
  readonly buildId: string;
  readonly config: { readonly basePath: string };
  readonly entrypoints: readonly { readonly pathname: string; readonly kind: string }[];
  readonly prerenders: readonly { readonly pathname: string; readonly route: string }[];
  readonly staticFiles: readonly { readonly pathname: string }[];
}

/** A rule of the build's routing, as far as where it sends a request. */
interface Rerouting {
  readonly source?: string | undefined;
  readonly sourceRegex: string;
  readonly destination?: string | undefined;
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A build's routing, as far as its rules send a request elsewhere. */
export interface BuildRerouting extends BuildNames {
  readonly routing: {
    readonly beforeMiddleware: readonly Rerouting[];
    readonly beforeFiles: readonly Rerouting[];
    readonly afterFiles: readonly Rerouting[];
    readonly fallback: readonly Rerouting[];
  };
}

/** What follows a page's name in the name of its data: its payload, its prefetch segments. */
const PAYLOAD_SUFFIX = '.rsc';
const SEGMENTS_DIRECTORY = '.segments';
/** A destination's reference to what its source captured, the whole of what follows the page. */
const TRAILING_REFERENCE = /^\$\w+$/u;

/** `path` with what follows a page's name for its data taken off: its payload's, its segments'. */
function withoutDataSuffix(path: string): string {
  const segments = path.indexOf(`${SEGMENTS_DIRECTORY}/`);
  if (segments !== -1) {
    return path.slice(0, segments);
  }
  return path.endsWith(PAYLOAD_SUFFIX) ? path.slice(0, -PAYLOAD_SUFFIX.length) : path;
}

/**
 * The page a dynamic route of a 16.3 build lands on for the page's data, by what its destination
 * writes after the page's name: its payload (`/items/[id].rsc`, `/items/[id]$rscSuffix`), or its
 * prefetch segments (`/items/[id].segments/items/$d$id$segment`).
 */
function pageOfLanding(landing: string): string {
  const reference = landing.lastIndexOf('$');
  const unsuffixed =
    reference > 0 && TRAILING_REFERENCE.test(landing.slice(reference))
      ? landing.slice(0, reference)
      : landing;
  return withoutDataSuffix(unsuffixed);
}

/**
 * The route each pathname of a build is of: an entrypoint's own, a prerender's route — a run of
 * fallback shells (`/en/[slug]`) is of one route (`/[locale]/[slug]`) — and the page a Pages
 * Router page's data names, whose props are that page's (`pageOfDataPathname`). A destination a
 * dynamic route of a 16.3 build lands on for a page's data is the page's (`pageOfLanding`).
 * `undefined` for a pathname of no route.
 */
export function routeOfPathname(build: BuildNames): (pathname: string) => string | undefined {
  const routes = new Set(build.entrypoints.map((entry) => entry.pathname));
  const prerendered = new Map(
    build.prerenders.map((prerender) => [prerender.pathname, prerender.route]),
  );
  const routeOf = (pathname: string): string | undefined =>
    prerendered.get(pathname) ?? (routes.has(pathname) ? pathname : undefined);
  return (pathname) => {
    const page = pageOfDataPathname(build.buildId, build.config.basePath, pathname);
    if (page !== undefined) {
      return routeOf(page) ?? routeOf(pathname);
    }
    return routeOf(pathname) ?? routeOf(pageOfLanding(pathname));
  };
}

/**
 * A segment of a route's name that takes one segment of a path, its value in brackets — and, in
 * the name of a page's data, what follows the value (`[slug].json`); one that takes the rest.
 */
const PARAMETER = /^\[[^\]]+\](?<after>.*)$/u;
const CATCH_ALL = /^\[{1,2}\.{3}/u;
const OPTIONAL_CATCH_ALL = /^\[{2}\.{3}.+\]{2}$/u;
/** Another origin's URL, which that origin answers. */
const EXTERNAL = /^[a-z][\d+.a-z-]*:/iu;
/** Where a rewrite's destination puts in what its source captured. */
const REFERENCE = /[$:]\w/u;
const REDIRECT_HEADERS: ReadonlySet<string> = new Set(['location', 'refresh']);
const LOWEST_REDIRECT = 300;
const HIGHEST_REDIRECT = 399;

/**
 * Where a rule sends the request it matches on the application's own origin: the destination of a
 * rule that does not answer with a redirect — which `@next/routing` reads as a 3xx said with a
 * `Location` or a `Refresh` — and does not send it to another origin, which answers it itself.
 */
function rewritesTo(rule: Rerouting): string | undefined {
  const { destination, status, headers } = rule;
  const redirects =
    status !== undefined &&
    status >= LOWEST_REDIRECT &&
    status <= HIGHEST_REDIRECT &&
    Object.keys(headers ?? {}).some((name) => REDIRECT_HEADERS.has(name.toLowerCase()));
  return destination === undefined || redirects || EXTERNAL.test(destination)
    ? undefined
    : destination;
}

/** `segment` decoded, as the router finds a page by its name decoded too; as it is, where not. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A route's segments, none for the root's. */
function templateOf(route: string): string[] {
  return route === '/' ? [] : route.split('/').slice(1);
}

/**
 * Whether a whole segment of a path may be `named`: a parameter as any value — in the name of a
 * page's data, one that ends as the name does (`[slug].json`) — and a static segment as itself,
 * decoded or not; or, ahead of what a rewrite captures (`open`), followed by its data's suffix
 * (`posts.segments`).
 */
function fitsWhole(segment: string, named: string, open: boolean): boolean {
  const after = PARAMETER.exec(named)?.groups?.['after'];
  if (after !== undefined) {
    return segment.endsWith(after);
  }
  return (
    segment === named || decoded(segment) === named || (open && segment.startsWith(`${named}.`))
  );
}

/** Whether the start of a segment, the rest of it a capture's, may begin `named`. */
function begins(segment: string, named: string): boolean {
  return PARAMETER.test(named) || named.startsWith(segment) || segment.startsWith(`${named}.`);
}

/**
 * Whether a path a rewrite writes whole may be one of `route`'s: segment by segment, a static one
 * as itself, a parameter as any value, a catch-all as the rest.
 */
function mayBeWhole(path: string, route: string): boolean {
  const segments = path.split('/').slice(1);
  const asked = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
  const named = templateOf(route);
  for (const [at, segment] of asked.entries()) {
    const template = named[at];
    if (template === undefined) {
      return false;
    }
    if (CATCH_ALL.test(template)) {
      return true;
    }
    if (!fitsWhole(segment, template, false)) {
      return false;
    }
  }
  const left = named.slice(asked.length);
  return left.length === 0 || (left.length === 1 && OPTIONAL_CATCH_ALL.test(left[0] ?? ''));
}

/**
 * Whether a path a rewrite writes as far as `written`, a capture of its source's after it, may be
 * one of `route`'s. Past the route's last segment, it may be only where it ends there, or in a
 * page's prefetch segments, after their directory. Ambiguous counts as may.
 */
function mayBegin(written: string, route: string): boolean {
  const asked = written.split('/').slice(1);
  const named = templateOf(route);
  for (const [at, segment] of asked.entries()) {
    const last = at === asked.length - 1;
    const template = named[at];
    if (template === undefined) {
      return (last && segment === '') || (asked[at - 1] ?? '').endsWith(SEGMENTS_DIRECTORY);
    }
    if (CATCH_ALL.test(template)) {
      return true;
    }
    if (!(last ? begins(segment, template) : fitsWhole(segment, template, true))) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a request a rewrite sends to `path` may be served as `route`, whose name a request asks
 * for it by is `named` — the page's own, or the name of its data. A path the rewrite writes whole is
 * the page or file the build named it by where it names one, as Next.js looks the filesystem up
 * first; and otherwise `route`'s where it may be one of `named`'s, its data's suffix taken off. One
 * the rewrite puts a capture in may be anything from there on: only a segment written ahead of the
 * capture that `named` cannot have rules it out.
 */
function mayReach(
  build: BuildNames,
  routeOf: (pathname: string) => string | undefined,
  path: string,
  route: { readonly route: string; readonly named: string },
): boolean {
  const reference = REFERENCE.exec(path);
  if (reference !== null) {
    return mayBegin(path.slice(0, reference.index), route.named);
  }
  const page = routeOf(path) ?? routeOf(path.replace(/(?<=.)\/$/u, ''));
  if (page !== undefined || build.staticFiles.some((file) => file.pathname === path)) {
    return page === route.route;
  }
  return mayBeWhole(withoutDataSuffix(path), route.named);
}

/**
 * The names a request asks for `route` by: its own, and for a Pages Router page, the name of its
 * data (`pagesDataPathnameUnder`), which a rewrite may send a request to as well.
 */
function namesOf(build: BuildNames, route: string): string[] {
  const pages = build.entrypoints.some(
    (entry) => entry.pathname === route && entry.kind === 'pages',
  );
  return pages
    ? [route, pagesDataPathnameUnder(build.buildId, build.config.basePath, route)]
    : [route];
}

/**
 * What of a build's gates a rewrite of `next.config` may take a request to. A request a rewrite
 * claims — in any phase of the routing, the fallback's among them — is served as its destination is,
 * by the deployment's Function, and is asked of no gate on its way there: so a host can hold a gated
 * route to its gate only where no rewrite reaches it, and each route a rewrite may reach is said,
 * naming the rewrite. A rewrite that puts in what its source captured may reach any route a path
 * written as far as the capture could be — what nothing rules out counts as reached. One that sends
 * the request to another origin reaches no route of this one; a redirect, none at all, as the
 * visitor then asks for what it names, of that route's gate.
 */
export function rewritesOnto(build: BuildRerouting, gated: readonly string[]): string[] {
  const { routing } = build;
  const rules = [
    ...routing.beforeMiddleware,
    ...routing.beforeFiles,
    ...routing.afterFiles,
    ...routing.fallback,
  ];
  const routeOf = routeOfPathname(build);
  const named = gated.flatMap((route) =>
    namesOf(build, route).map((name) => ({ route, named: name })),
  );
  const issues: string[] = [];
  for (const rule of rules) {
    const destination = rewritesTo(rule);
    const path = destination?.split(/[#?]/u, 1)[0];
    if (destination === undefined || path === undefined) {
      continue;
    }
    const reached = new Set(
      named.filter((name) => mayReach(build, routeOf, path, name)).map((name) => name.route),
    );
    for (const route of reached) {
      issues.push(
        `gates names ${route}, which the rewrite of ${rule.source ?? rule.sourceRegex} to ${destination} may send a request to, served there with no gate asked`,
      );
    }
  }
  return issues;
}
