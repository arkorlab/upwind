import { builtNameOf } from '../manifest/built-names.ts';
import { decodedPath, requestSpelling } from '../manifest/pages-data-prefix.ts';
import { compiledRules, type CompiledRule, patternOf } from '../request/compiled-patterns.ts';
import { pageOfDataPathname, pagesDataPathnameUnder } from './pages-data.ts';
import { type CaptureKind, referencesOf } from './rewrite-captures.ts';
import { namesSpelledBy, type RouterNamed, routerPathnames } from './router-names.ts';

/**
 * Which route of a build a pathname is of, and where a rule of `next.config` may send a request:
 * what the gates a bundle declares are held to (`gateIssues`, in `schema.ts`), and what a manifest
 * carries for the edge to find a request's gate by (`gates.ts`), are both read off it.
 *
 * Written on the bundle's shape rather than its type, as the bundle's own schema reads it.
 */

/**
 * What of a build names its routes: each entrypoint, each prerender, each file it ships — and what
 * its router resolves exactly (`routerPathnames`).
 */
export interface BuildNames extends RouterNamed {
  readonly buildId: string;
  readonly entrypoints: readonly { readonly pathname: string; readonly kind: string }[];
}

/** A prerender, as far as which route it is of and whether the router resolves it by name. */
type NamedPrerender = BuildNames['prerenders'][number];

/** A rule of the build's routing, as far as where it sends a request. */
interface Rerouting {
  readonly source?: string | undefined;
  readonly sourceRegex: string;
  readonly destination?: string | undefined;
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A dynamic route of the build, as far as where it lands a request and what it asks of one. */
interface Landing {
  readonly sourceRegex: string;
  readonly destination?: string | undefined;
  readonly has?: readonly unknown[] | undefined;
  readonly missing?: readonly unknown[] | undefined;
}

/** A build's names, and its dynamic routes in their order. */
export interface BuildLandings extends BuildNames {
  readonly routing: { readonly dynamicRoutes: readonly Landing[] };
}

/** A build's routing, as far as its rules send a request elsewhere. */
export interface BuildRerouting extends BuildLandings {
  readonly routing: {
    readonly beforeMiddleware: readonly Rerouting[];
    readonly beforeFiles: readonly Rerouting[];
    readonly afterFiles: readonly Rerouting[];
    readonly fallback: readonly Rerouting[];
    readonly dynamicRoutes: readonly Landing[];
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

/** What a build's router resolves by name, and the route it serves each name as. */
interface RouterReading {
  /** The names it is handed as they are (`routerPathnames`), as the runtime hands them. */
  readonly names: ReadonlySet<string>;
  /** The route a name is of, a spelling behind a trailing slash read as the page without it. */
  readonly routeOfName: (name: string) => string;
}

function routerReadingOf(build: BuildNames): RouterReading {
  const routeOf = routeOfPathname(build);
  const { pathnames, slashSpellings } = routerPathnames(build);
  return {
    names: new Set(pathnames),
    routeOfName: (name) => {
      const page = slashSpellings.get(name) ?? name;
      return routeOf(page) ?? page;
    },
  };
}

/**
 * The names the router may resolve `path` as and serve it under: `path` itself where it is one, and
 * each name it may be a spelling of (`namesSpelledBy`) — which the runtime hands the router as well,
 * by what the request spells, and serves the path as where it reads it back so.
 */
function namesReadOf(reading: RouterReading, path: string): string[] {
  const spelled = namesSpelledBy(path, reading.names);
  return reading.names.has(path) ? [path, ...spelled] : spelled;
}

/** A destination's reference to what a pattern captured, by its place or its name. */
const CAPTURE_REFERENCE = /\$(?<reference>\d+|[A-Za-z_]\w*)/gu;
const CAPTURE_PLACE = /^\d+$/u;

/** What `match` captured under a reference's place or name: none for one it captured nothing at. */
function capturedOf(match: RegExpExecArray, reference: string): string | undefined {
  if (CAPTURE_PLACE.test(reference)) {
    const place = Number(reference);
    return place < match.length ? (match[place] ?? '') : undefined;
  }
  const { groups } = match;
  return groups !== undefined && Object.hasOwn(groups, reference)
    ? (groups[reference] ?? '')
    : undefined;
}

/**
 * The path a dynamic route's destination names for `match`, with what the pattern captured put in
 * (`replaceDestination`, in `@next/routing`): a reference to nothing the pattern captured is left
 * as it is written. The request's own path where the route names no destination.
 */
function destinationOf(rule: Landing, match: RegExpExecArray): string {
  const destination = rule.destination?.split('?', 1)[0];
  if (destination === undefined) {
    return match.input;
  }
  return destination.replaceAll(
    CAPTURE_REFERENCE,
    (written: string, reference: string) => capturedOf(match, reference) ?? written,
  );
}

/** What a dynamic route's pattern makes of a path: none where it does not hold, nor compile. */
function matchOf(compiled: CompiledRule<Landing>, pathname: string): RegExpExecArray | null {
  try {
    return patternOf(compiled).exec(pathname);
  } catch {
    return null;
  }
}

/**
 * The routes a build's router may land a path on through its dynamic routes, in their order, as
 * `@next/routing` lands one: each whose pattern holds of the path without regard to case, as the
 * runtime matches them, and whose destination, the path's values put in, is a name the router
 * resolves — one that is not, it passes over — up to the first that asks nothing more of a request
 * (`has`, `missing`) and lands on a name it is always handed (`routerPathnames`): a request one of
 * the others passes over goes on to the next. A destination that may be a spelling of a name
 * (`namesSpelledBy`) may land the path, as each name it may be read as, and may be passed over,
 * as the request has it. None where no route lands it.
 *
 * Which of these the router takes is what serves a member the build prerendered: the runtime finds
 * a page of its own, a file, and a few prerenders by their names (`resolvedByName`), and every other
 * member through the dynamic routes, the first that lands it winning — a class ahead of the
 * member's own among them.
 */
export function dynamicLandings(build: BuildLandings): (pathname: string) => string[] {
  const reading = routerReadingOf(build);
  const routes = compiledRules(build.routing.dynamicRoutes, 'i');
  return (pathname) => {
    const landed: string[] = [];
    for (const compiled of routes) {
      const match = matchOf(compiled, pathname);
      const destination = match === null ? undefined : destinationOf(compiled.rule, match);
      if (destination === undefined) {
        continue;
      }
      landed.push(...namesReadOf(reading, destination).map((name) => reading.routeOfName(name)));
      const { has, missing } = compiled.rule;
      if (has === undefined && missing === undefined && reading.names.has(destination)) {
        break;
      }
    }
    return landed;
  };
}

/**
 * The routes a prerendered pathname may be served as: its own, which the edge serves what the build
 * kept of; the route of each name the router may read the pathname as instead (`namesSpelledBy`) —
 * a page of its own it also spells, which the runtime serves ahead of a member (`escapedNameOf`);
 * and, where the router does not find the pathname by name — a page of its own, a file, a
 * prerender it resolves by name, any of which it serves in place of a class that also holds of it,
 * as the runtime's `landedRoute` does — each route it may land it on through its dynamic routes
 * (`dynamicLandings`), which what a request carries chooses among.
 */
export function servedRoutesOf(build: BuildLandings): (prerender: NamedPrerender) => string[] {
  const reading = routerReadingOf(build);
  const landingsOf = dynamicLandings(build);
  return (prerender) => {
    const { pathname } = prerender;
    const read = namesSpelledBy(pathname, reading.names).map((name) => reading.routeOfName(name));
    const landed = reading.names.has(pathname) ? [] : landingsOf(pathname);
    return [...new Set([prerender.route, ...read, ...landed])];
  };
}

/**
 * Each prerendered pathname that may be served as more than one route, one of them gated
 * (`servedRoutesOf`): its own, which the edge serves what it kept of, and one a dynamic route
 * lands it on or a page of its own its name also spells — or two the router chooses between by
 * what a request carries (`has`, `missing`). The edge asks a pathname of one route's gate before
 * it serves anything, and the route that serves the request is not its to choose: the gate asked
 * would answer for another route — one it is no gate of, or one that has none — and a request it
 * passed could be served as a gated route whose gate was never asked. Two routes behind gates of
 * one name are two all the same: a gate is told which route a request is of (`RouteGate.route`).
 * Such a build is refused (`gateIssues`, in `schema.ts`).
 */
export function gatedEitherWay(
  build: BuildLandings,
  gates: Readonly<Record<string, string>>,
): string[] {
  const servedRoutes = servedRoutesOf(build);
  return build.prerenders.flatMap((prerender) => {
    const routes = servedRoutes(prerender);
    const gated = routes.filter((route) => Object.hasOwn(gates, route));
    return routes.length < 2 || gated.length === 0
      ? []
      : [
          `gates names ${gated.join(' and ')}, and ${prerender.pathname} may be served as ${routes.join(' or ')}: the edge asks one route's gate of it before it is served, which would answer for a route it is not the gate of`,
        ];
  });
}

/**
 * Whether `route` is the image optimizer's own path, by either spelling of one trailing slash: the
 * edge answers that path as the optimizer's ahead of every route (`namesOptimizer`, in the
 * manifest's `gates.ts`), and so does the router (`routerPathnames`) — a gate declared for the
 * route of that name is never asked.
 */
export function isOptimizerPath(build: BuildNames, route: string): boolean {
  const optimizer = build.config.images?.path;
  return optimizer !== undefined && withoutTrailingSlash(route) === withoutTrailingSlash(optimizer);
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
  /** The routes the router may land a path on through its dynamic routes (`dynamicLandings`). */
  readonly landingsOf: (pathname: string) => string[];
  /**
   * The image optimizer's own path, which the router resolves as the optimizer's by that spelling
   * alone (`routerPathnames`): with a trailing slash it is a path like any other.
   */
  readonly optimizer: string | undefined;
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

/** A gated route, and a name a request asks for it by: the page's own, or the name of its data. */
interface GatedName {
  readonly route: string;
  readonly named: string;
}

/**
 * Whether a request a rewrite sends to `destination` may be served as a gated route, whose name a
 * request asks for it by is `named` — the page's own, or the name of its data: read once for the
 * destination, and asked of each gated route. A path the rewrite writes whole is read as the router
 * reads it (`readingsOf`): it reaches the route where any reading is a page of the route; and
 * otherwise none where a reading is a page of its own or a file, which the router serves in place
 * of any dynamic route; and otherwise where a dynamic route the router may land the path on, the
 * first that holds of it, lands on the route (`dynamicLandings`) — a member of another route the
 * build prerendered is no name the router serves by — or, where none holds of it, where it may be
 * one of `named`'s, as it is or as the data of any page it may be (`dataPagesOf`), and compared
 * without regard to case where a dynamic route finds `named`'s requests. One the rewrite puts a
 * capture in is read by what each capture may hold (`mayReachCaptured`).
 *
 * The image optimizer's own path is the optimizer's where the router resolves the names it is
 * handed before its dynamic routes (`namesFirst`): a request as it comes, and one a rule ahead of
 * the filesystem rewrites. After the filesystem, `@next/routing` asks its dynamic routes of what a
 * rewrite sends first (`checkDynamicRoutes`), and a class that holds of the optimizer's path — a
 * catch-all — serves it as one of its own.
 */
function reachOf(
  reader: Reader,
  destination: Destination,
  namesFirst: boolean,
): (route: GatedName) => boolean {
  const { path } = destination;
  if (destination.references.length > 0) {
    return (route) => mayReachCaptured(destination, route.named, foldFor(route.named));
  }
  const readings = readingsOf(path);
  const routes = new Set(readings.map((reading) => reader.routeOf(reading)));
  const asSet = requestSpelling(path);
  const optimized = namesFirst && reader.optimizer === asSet;
  if (optimized || readings.some((reading) => reader.servesItself(reading))) {
    return (route) => routes.has(route.route);
  }
  const landed = reader.landingsOf(asSet);
  return (route) => {
    if (routes.has(route.route)) {
      return true;
    }
    if (landed.length > 0) {
      return landed.includes(route.route);
    }
    const fold = foldFor(route.named);
    const spelled = fold(asSet);
    return [spelled, ...dataPagesOf(spelled)].some((page) => mayBeWhole(page, route.named, fold));
  };
}

/** How a path is compared with `named`: in any case where a dynamic route finds its requests. */
function foldFor(named: string): Fold {
  return named.includes('[') ? ANY_CASE : AS_WRITTEN;
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
function readerOf(build: BuildLandings): Reader {
  const own = new Set(build.staticFiles.map((file) => file.pathname));
  for (const { pathname } of build.entrypoints) {
    // A route's own name in brackets is a class, which a dynamic route finds the members of.
    if (!pathname.includes('[')) {
      own.add(pathname);
    }
  }
  return {
    routeOf: routeOfPathname(build),
    servesItself: (name) => own.has(name),
    landingsOf: dynamicLandings(build),
    optimizer: build.config.images?.path,
  };
}

/** The query parameter an image optimizer request names its source by. */
const SOURCE_PARAMETER = 'url';

/**
 * The source an optimizer request a rewrite sends names, as the rewrite writes it: the last `url`
 * of the query it writes, which the router sets on the URL in place of the visitor's own
 * (`applyDestination`, which reads the query as far as a second `?`). `undefined` where the source
 * is the request's to say: a rewrite that writes no `url` leaves the visitor's, and one that puts
 * in what its rule captured (`$1`, `$path`) writes what the request holds.
 */
function sourceWrittenBy(destination: string): string | undefined {
  const query = destination.split('?', 2)[1];
  const source =
    query === undefined ? undefined : new URLSearchParams(query).getAll(SOURCE_PARAMETER).at(-1);
  return source === undefined || source.includes('$') ? undefined : source;
}

/**
 * Whether an optimizer request for `source` may fetch a gated route's answer: a path of the
 * application's own (`/…`, and not `//…`, which the optimizer refuses), which the deployment's
 * Function routes in full and fetches with no gate asked, read as a rewrite's path written whole is
 * (`reachOf`). A URL of another origin is fetched there, through its gates; a source a request may
 * name (`undefined`) may be any.
 */
function sourceReachOf(reader: Reader, source: string | undefined): (route: GatedName) => boolean {
  if (source === undefined) {
    return () => true;
  }
  if (!source.startsWith('/') || source.startsWith('//')) {
    return () => false;
  }
  const [path = ''] = source.split(/[?#]/u, 1);
  // A request of the optimizer's own, routed as it comes: the names the router is handed first.
  return reachOf(reader, { path, references: [] }, true);
}

/**
 * Whether a path a rewrite writes may be the image optimizer's own (`isOptimizerPath`): as the
 * router reads one written whole (`readingsOf`), or as far as what the rewrite's rule captured.
 */
function mayBeOptimizer(build: BuildNames, destination: Destination): boolean {
  const optimizer = build.config.images?.path;
  if (optimizer === undefined) {
    return false;
  }
  return destination.references.length > 0
    ? mayReachCaptured(destination, optimizer, AS_WRITTEN)
    : readingsOf(destination.path).some((reading) => isOptimizerPath(build, reading));
}

/**
 * What of the gated routes `named` a rewrite to the image optimizer may have it fetch as a source,
 * by the path the rewrite writes and its destination whole: the request the edge hands on is the
 * rewrite's, which a rule claims and no gate is asked of, and the Function's optimizer routes its
 * source within (`serveImageSource`, in the runtime), where no gate is known — a gated route's
 * answer optimized there is kept for every visitor.
 */
function optimizerSources(
  build: BuildNames,
  reader: Reader,
  named: readonly GatedName[],
): (written: Destination, destination: string) => string[] {
  return (written, destination) => {
    if (!mayBeOptimizer(build, written)) {
      return [];
    }
    const fetches = sourceReachOf(reader, sourceWrittenBy(destination));
    return [...new Set(named.filter((name) => fetches(name)).map((name) => name.route))];
  };
}

/**
 * What of a build's gates a rewrite of `next.config` may take a request to. A request a rewrite
 * claims — in any phase of the routing, the fallback's among them — is served as its destination is,
 * by the deployment's Function, and is asked of no gate on its way there: so a host can hold a gated
 * route to its gate only where no rewrite reaches it, and each route a rewrite may reach is said,
 * naming the rewrite. A rewrite that puts in what its source captured may reach any route a path
 * written as far as the capture could be — what nothing rules out counts as reached. One that sends
 * the request to another origin reaches no route of this one; a redirect, none at all, as the
 * visitor then asks for what it names, of that route's gate. One that sends the request to the
 * image optimizer reaches what the optimizer may fetch as its source (`optimizerSources`).
 */
export function rewritesOnto(build: BuildRerouting, gated: readonly string[]): string[] {
  const { routing } = build;
  // Ahead of the filesystem, the router resolves the names it is handed before its dynamic routes;
  // after it, the dynamic routes first (`reachOf`).
  const ahead = [...routing.beforeMiddleware, ...routing.beforeFiles];
  const after = [...routing.afterFiles, ...routing.fallback];
  const rules = [
    ...ahead.map((rule) => ({ rule, namesFirst: true })),
    ...after.map((rule) => ({ rule, namesFirst: false })),
  ];
  const reader = readerOf(build);
  const named = gated.flatMap((route) =>
    namesOf(build, route).map((name) => ({ route, named: name })),
  );
  const sourcesOf = optimizerSources(build, reader, named);
  const issues: string[] = [];
  for (const { rule, namesFirst } of rules) {
    const destination = rewritesTo(rule);
    if (destination === undefined) {
      continue;
    }
    // All the router sets on the URL's path: what comes before a `?`, a `#` among it.
    const [path = ''] = destination.split('?', 1);
    const written = { path, references: referencesOf(path, rule.sourceRegex) };
    const reaches = reachOf(reader, written, namesFirst);
    const reached = new Set(named.filter((name) => reaches(name)).map((name) => name.route));
    const rewrite = `the rewrite of ${rule.source ?? rule.sourceRegex} to ${destination}`;
    for (const route of reached) {
      issues.push(
        `gates names ${route}, which ${rewrite} may send a request to, served there with no gate asked`,
      );
    }
    for (const route of sourcesOf(written, destination)) {
      issues.push(
        `gates names ${route}, which ${rewrite} may have the image optimizer fetch as its source, with no gate asked`,
      );
    }
  }
  return issues;
}
