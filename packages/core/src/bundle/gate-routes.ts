import { builtNameOf } from '../manifest/built-names.ts';
import { decodedPath, requestSpelling } from '../manifest/pages-data-prefix.ts';
import { pageOfDataPathname, pagesDataPathnameUnder } from './pages-data.ts';
import { type CaptureKind, referencesOf } from './rewrite-captures.ts';

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
const SEGMENTS_MARK = `${SEGMENTS_DIRECTORY}/`;
/** A destination's reference to what its source captured, the whole of what follows the page. */
const TRAILING_REFERENCE = /^\$\w+$/u;

/**
 * Each page `path` may be the data of, longest first: the path with its payload's suffix taken off
 * (`.rsc`), and the path as far as each `.segments/` in it — a page's prefetch segments follow its
 * name so, and a route may name a segment of its own `….segments` as well
 * (`/reports.segments/[slug]`), which only the routes the build has tell apart.
 */
function dataPagesOf(path: string): string[] {
  const pages = path.endsWith(PAYLOAD_SUFFIX) ? [path.slice(0, -PAYLOAD_SUFFIX.length)] : [];
  for (let at = path.indexOf(SEGMENTS_MARK); at !== -1; at = path.indexOf(SEGMENTS_MARK, at + 1)) {
    pages.push(path.slice(0, at));
  }
  return pages.toSorted((one, other) => other.length - one.length);
}

/**
 * The pages a dynamic route of a 16.3 build may land on for a page's data, longest first, by what
 * its destination writes after the page's name: its payload (`/items/[id].rsc`,
 * `/items/[id]$rscSuffix`), or its prefetch segments (`/items/[id].segments/items/$d$id$segment`).
 */
function pagesOfLanding(landing: string): string[] {
  const reference = landing.lastIndexOf('$');
  if (reference > 0 && TRAILING_REFERENCE.test(landing.slice(reference))) {
    const unsuffixed = landing.slice(0, reference);
    return [unsuffixed, ...dataPagesOf(unsuffixed)];
  }
  return dataPagesOf(landing);
}

/**
 * The route each pathname of a build is of: an entrypoint's own, a prerender's route — a run of
 * fallback shells (`/en/[slug]`) is of one route (`/[locale]/[slug]`) — and the page a Pages
 * Router page's data names, whose props are that page's (`pageOfDataPathname`). A destination a
 * dynamic route of a 16.3 build lands on for a page's data is the page's: the longest the build has
 * of the pages it may be (`pagesOfLanding`). `undefined` for a pathname of no route.
 */
export function routeOfPathname(build: BuildNames): (pathname: string) => string | undefined {
  const routes = new Set(build.entrypoints.map((entry) => entry.pathname));
  const prerendered = new Map(
    build.prerenders.map((prerender) => [prerender.pathname, prerender.route]),
  );
  const routeOf = (pathname: string): string | undefined =>
    prerendered.get(pathname) ?? (routes.has(pathname) ? pathname : undefined);
  return (pathname) => {
    const propsOf = pageOfDataPathname(build.buildId, build.config.basePath, pathname);
    if (propsOf !== undefined) {
      return routeOf(propsOf) ?? routeOf(pathname);
    }
    return (
      routeOf(pathname) ??
      pagesOfLanding(pathname)
        .map((page) => routeOf(page))
        .find((route) => route !== undefined)
    );
  };
}

/**
 * A segment of a route's name that takes one segment of a path, its value in brackets — and, in
 * the name of a page's data, what follows the value (`[slug].json`); one that takes the rest.
 */
const PARAMETER = /^\[[^\]]+\](?<after>.*)$/u;
const CATCH_ALL = /^\[{1,2}\.{3}/u;
const OPTIONAL_CATCH_ALL = /^\[{2}\.{3}.+\]{2}$/u;
/** Another origin's URL, which the router hands to that origin (`isExternalDestination`). */
const EXTERNAL = /^https?:\/\//u;
/** A segment that climbs a level once the router resolves it: `..`, either dot escaped or not. */
const CLIMB = /^(?:\.|%2e){2}$/iu;
const REDIRECT_HEADERS: ReadonlySet<string> = new Set(['location', 'refresh']);
const LOWEST_REDIRECT = 300;
const HIGHEST_REDIRECT = 399;

/**
 * How a path is compared with a route's name: as written, as the router finds a name; or in any
 * case, as it matches a dynamic route's pattern — the runtime leaves `@next/routing`'s
 * `caseSensitive` unset, so `/POSTS/a` is a member of `/posts/[slug]`.
 */
type Fold = (text: string) => string;
const AS_WRITTEN: Fold = (text) => text;
const ANY_CASE: Fold = (text) => text.toLowerCase();

/** What a build tells the router's own names by: the route of each, and what it serves itself. */
interface Reader {
  readonly routeOf: (pathname: string) => string | undefined;
  /**
   * Whether the router serves a name itself — a page of its own, a file — in place of any dynamic
   * route that also matches it (`landedRoute`, in the runtime).
   */
  readonly servesItself: (name: string) => boolean;
}

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
  return decodedPath(segment) ?? segment;
}

/** A path without the slash it may end in, the root's aside. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The names the router may find a path a rewrite writes whole by (`escapedNameOf`, in the runtime):
 * the path as it sets it on the URL (`applyDestination` — its dot segments resolved, what a URL
 * escapes escaped), the same decoded whole, as it finds a page of its own or a file, and by the name
 * Next.js builds a member under (`builtNameOf`); each with and without a trailing slash, which it
 * finds a page of its own or a file without as well.
 */
function readingsOf(path: string): string[] {
  const spelled = requestSpelling(path);
  const readings = [spelled, decodedPath(spelled), builtNameOf(spelled)];
  return [
    ...new Set(
      readings.flatMap((reading) =>
        reading === undefined ? [] : [reading, withoutTrailingSlash(reading)],
      ),
    ),
  ];
}

/**
 * What a path a rewrite writes as far as a capture may be read as: as written, as the URL has it,
 * and that decoded — as far as its first escape, where what follows does not decode until a capture
 * completes it (`/private%2` and a `F`).
 */
function writtenReadingsOf(written: string): string[] {
  const spelled = requestSpelling(written);
  const escape = spelled.indexOf('%');
  const whole = escape === -1 ? spelled : (decodedPath(spelled) ?? spelled.slice(0, escape));
  return [...new Set([spelled, whole, written])];
}

/** A route's segments, none for the root's. */
function templateOf(route: string): string[] {
  return route === '/' ? [] : route.split('/').slice(1);
}

/**
 * Whether a whole segment of a path may be `named`: a parameter as any value — in the name of a
 * page's data, one that ends as the name does (`[slug].json`) — and a static segment as itself,
 * decoded or not; or, ahead of what a rewrite captures (`open`), followed by its data's suffix
 * (`posts.segments`). Compared as `fold` has them.
 */
function fitsWhole(segment: string, named: string, open: boolean, fold: Fold): boolean {
  const after = PARAMETER.exec(named)?.groups?.['after'];
  if (after !== undefined) {
    return fold(segment).endsWith(fold(after));
  }
  const name = fold(named);
  const spelled = fold(segment);
  return (
    spelled === name || fold(decoded(segment)) === name || (open && spelled.startsWith(`${name}.`))
  );
}

/** Whether the start of a segment, the rest of it a capture's, may begin `named`. */
function begins(segment: string, named: string, fold: Fold): boolean {
  const name = fold(named);
  const spelled = fold(segment);
  return PARAMETER.test(named) || name.startsWith(spelled) || spelled.startsWith(`${name}.`);
}

/**
 * Whether a path a rewrite writes whole may be one of `route`'s: segment by segment, a static one
 * as itself, a parameter as any value, a catch-all as the rest.
 */
function mayBeWhole(path: string, route: string, fold: Fold): boolean {
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
    if (!fitsWhole(segment, template, false, fold)) {
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
function mayBegin(written: string, route: string, fold: Fold): boolean {
  const asked = written.split('/').slice(1);
  const named = templateOf(route);
  for (const [at, segment] of asked.entries()) {
    const last = at === asked.length - 1;
    const template = named[at];
    if (template === undefined) {
      return (last && segment === '') || fold(asked[at - 1] ?? '').endsWith(SEGMENTS_DIRECTORY);
    }
    if (CATCH_ALL.test(template)) {
      return true;
    }
    if (!(last ? begins(segment, template, fold) : fitsWhole(segment, template, true, fold))) {
      return false;
    }
  }
  return true;
}

/** The path a rewrite writes, and each reference it makes to what its rule captured. */
interface Destination {
  readonly path: string;
  readonly references: readonly { readonly at: number; readonly kind: CaptureKind }[];
}

/** `written` with its last `levels` whole segments climbed out of, the one it ends in among them. */
function climbedOutOf(written: string, levels: number): string {
  if (levels === 0) {
    return written;
  }
  const whole = written.split('/').slice(1, -1);
  const kept = whole.slice(0, Math.max(0, whole.length - levels));
  return ['', ...kept, ''].join('/');
}

/**
 * Whether a path a rewrite puts what its rule captured in may be one of `named`'s. A value of any
 * kind (`any`) may be any path at all. Otherwise each part of a segment it puts in may climb a
 * level, and so may each `..` it writes after the first, which the router resolves once the values
 * are in: the path written ahead of the first, less as many segments, is all that rules a route
 * out, however it is read (`writtenReadingsOf`) — anything may follow it.
 */
function mayReachCaptured(destination: Destination, named: string, fold: Fold): boolean {
  const { path, references } = destination;
  if (references.some((reference) => reference.kind === 'any')) {
    return true;
  }
  const first = references[0]?.at ?? path.length;
  const climbs =
    references.filter((reference) => reference.kind === 'part').length +
    path
      .slice(first)
      .split('/')
      .filter((segment) => CLIMB.test(segment)).length;
  const readings = writtenReadingsOf(path.slice(0, first));
  return readings.some((written) => mayBegin(climbedOutOf(written, climbs), named, fold));
}

/**
 * Whether a request a rewrite sends to `destination` may be served as `route`, whose name a request
 * asks for it by is `named` — the page's own, or the name of its data. A path the rewrite writes
 * whole is read as the router reads it (`readingsOf`): it reaches the route where any reading is a
 * page of the route; and otherwise none where a reading is a page of its own or a file, which the
 * router serves in place of any dynamic route; and otherwise where it may be one of `named`'s, as it
 * is or as the data of any page it may be (`dataPagesOf`), and compared without regard to case
 * where a dynamic route finds `named`'s requests. One the rewrite puts a capture in is read by what
 * each capture may hold (`mayReachCaptured`).
 */
function mayReach(
  reader: Reader,
  destination: Destination,
  route: { readonly route: string; readonly named: string },
): boolean {
  const fold = route.named.includes('[') ? ANY_CASE : AS_WRITTEN;
  const { path } = destination;
  if (destination.references.length > 0) {
    return mayReachCaptured(destination, route.named, fold);
  }
  const readings = readingsOf(path);
  if (readings.some((reading) => reader.routeOf(reading) === route.route)) {
    return true;
  }
  if (readings.some((reading) => reader.servesItself(reading))) {
    return false;
  }
  const spelled = fold(requestSpelling(path));
  return [spelled, ...dataPagesOf(spelled)].some((page) => mayBeWhole(page, route.named, fold));
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

/** What the router serves by its own name ahead of any dynamic route: a page of its own, a file. */
function readerOf(build: BuildNames): Reader {
  const own = new Set(build.staticFiles.map((file) => file.pathname));
  for (const { pathname } of build.entrypoints) {
    // A route's own name in brackets is a class, which a dynamic route finds the members of.
    if (!pathname.includes('[')) {
      own.add(pathname);
    }
  }
  return { routeOf: routeOfPathname(build), servesItself: (name) => own.has(name) };
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
  const reader = readerOf(build);
  const named = gated.flatMap((route) =>
    namesOf(build, route).map((name) => ({ route, named: name })),
  );
  const issues: string[] = [];
  for (const rule of rules) {
    const destination = rewritesTo(rule);
    if (destination === undefined) {
      continue;
    }
    // All the router sets on the URL's path: what comes before a `?`, a `#` among it.
    const [path = ''] = destination.split('?', 1);
    const written = { path, references: referencesOf(path, rule.sourceRegex) };
    const reached = new Set(
      named.filter((name) => mayReach(reader, written, name)).map((name) => name.route),
    );
    for (const route of reached) {
      issues.push(
        `gates names ${route}, which the rewrite of ${rule.source ?? rule.sourceRegex} to ${destination} may send a request to, served there with no gate asked`,
      );
    }
  }
  return issues;
}
