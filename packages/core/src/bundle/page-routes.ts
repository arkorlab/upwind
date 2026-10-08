import type { Route } from './schema.ts';

/**
 * The dynamic routes of a build as the pages they land a request on.
 *
 * Before 16.4, `next build` handed an adapter one entry for each page and one beside it for the
 * page's data — its RSC payload and its prefetch segments — and an entry's destination named the
 * page it served (`/blog/[slug]`). 16.4 collapses that table by default
 * (`experimental.collapseAdapterRoutes`, `build/adapter/build-complete.ts`):
 *
 * - a page and its data become one entry, whose pattern ends in a group for the suffix that takes
 *   an empty one as well (`DOCUMENT_OR_DATA`), and whose destination ends in that group's
 *   reference: `/blog/[slug]$2`;
 * - the fallback shells of one source page that sit side by side in the table become one entry,
 *   whose pattern lists the prefixes the shells resolved — `^/(en|ja)/…` — and whose destination
 *   begins with the one that matched: `/$1/[slug]`.
 *
 * Each such entry resolves a request to the output the entries it replaced did, and the Functions
 * route with the table as the build wrote it. What the edge needs of the table is the page each
 * request lands on, which a collapsed entry's destination no longer spells: so each is read back
 * into the entries it replaced, where it stands — each prefix of a run in the order the run lists
 * them, which is the order of the shells it replaced, and for each page its data first and then the
 * page, as before 16.4.
 *
 * An entry of neither shape is read as it is, the path of its destination the page: every entry of
 * a build before 16.4, and of a build that turned the option off — save the one such a build writes
 * from 16.4 for a page's data alone, whose destination names the page with the reference to its
 * suffix on the end (`/blog/[slug]$2`), and which lands on no page. So a table the build collapsed
 * reads as the one it writes with the option off, less the entries it wrote there for each prefetch
 * segment, which only a data pathname matches.
 */
export interface PageRoute {
  /** The build's entry, whose conditions (`has`, `missing`) hold of the request either way. */
  readonly route: Route;
  /** The pathnames that reach the page: the entry's own pattern, or the part of it that does. */
  readonly sourceRegex: string;
  /**
   * The page a request it matches lands on, as the destination's path names it — the route's own
   * name for a dynamic page (`/blog/[slug]`); `undefined` where it lands on the page's data, or on
   * nothing in the build.
   */
  readonly template: string | undefined;
}

/** How a collapsed entry ends its pattern: the page, or its RSC payload, or one of its segments. */
const DOCUMENT_OR_DATA = String.raw`(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`;
/** The same end for the page's data alone, as a table that is not collapsed spells it from 16.4. */
const DATA_ONLY = String.raw`(\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`;
/** And for the page alone, which is how every page's own pattern ends (`getNamedRouteRegex`). */
const DOCUMENT_ONLY = '(?:/)?$';
/** The reference a run's destination begins with: the prefix that matched, its first capture. */
const PREFIX_REFERENCE = '$1';
/** What `escapeStringRegexp` escapes, as Next.js escapes a static segment and the `basePath`. */
const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}-]/gu;
const ESCAPED = /\\(.)/gu;
/** A destination's reference to a group by its place. */
const POSITIONAL_REFERENCE = /\$(\d+)/gu;

/** The number of groups a pattern captures: one longer than what a match of it holds. */
function captureCount(sourceRegex: string): number | undefined {
  try {
    // An empty alternative beside it, so the match always succeeds and reports every group. Compiled
    // as Next.js compiles it for its own router, without the unicode flag, under which an escaped
    // `-` it writes would not compile.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    const match = new RegExp(`${sourceRegex}|`).exec('');
    return match === null ? undefined : match.length - 1;
  } catch {
    return undefined;
  }
}

/**
 * A page and its data apart, where one entry serves both — its pattern ends in `DOCUMENT_OR_DATA`,
 * the last group it captures, and the path of its destination in that group's reference — and the
 * entry for the data alone, where the build wrote one (`DATA_ONLY`), read as one: it lands on no
 * page. Any other entry is read as it is.
 */
function documentAndData(route: Route, sourceRegex: string, path: string): PageRoute[] {
  const ending = [DOCUMENT_OR_DATA, DATA_ONLY].find((end) => sourceRegex.endsWith(end));
  const count = ending === undefined ? undefined : captureCount(sourceRegex);
  const reference = count === undefined ? undefined : `$${String(count)}`;
  if (ending === undefined || reference === undefined || !path.endsWith(reference)) {
    return [{ route, sourceRegex, template: path }];
  }
  const body = sourceRegex.slice(0, -ending.length);
  const data = { route, sourceRegex: `${body}${DATA_ONLY}`, template: undefined };
  return ending === DATA_ONLY
    ? [data]
    : [
        data,
        {
          route,
          sourceRegex: `${body}${DOCUMENT_ONLY}`,
          template: path.slice(0, -reference.length),
        },
      ];
}

/**
 * The end of the group a run's prefixes are listed in, which begins at `from`: each prefix escaped
 * as a static segment is (`REGEXP_SPECIAL`), so nothing in the list opens a group or a class of its
 * own. `undefined` where something does, which no run's list has.
 */
function listEnd(sourceRegex: string, from: number): number | undefined {
  for (let at = from; at < sourceRegex.length; at += 1) {
    const character = sourceRegex.charAt(at);
    if (character === '\\') {
      at += 1;
      continue;
    }
    if (character === ')') {
      return at;
    }
    if (character === '(' || character === '[') {
      return undefined;
    }
  }
  return undefined;
}

/** A run's prefixes as its pattern lists them, each still escaped: split where `|` is not. */
function listed(list: string): string[] {
  const prefixes: string[] = [];
  let start = 0;
  for (let at = 0; at < list.length; at += 1) {
    if (list[at] === '\\') {
      at += 1;
    } else if (list[at] === '|') {
      prefixes.push(list.slice(start, at));
      start = at + 1;
    }
  }
  prefixes.push(list.slice(start));
  return prefixes;
}

/**
 * The shells one entry serves for a run, each with the pattern the build gives it with the option
 * off and the path its destination names: `^/(en|ja)/(?<nxtPslug>[^/]+?)…` with `/$1/[slug]$3` is
 * `^/en/(?<nxtPslug>[^/]+?)…` with `/en/[slug]$2`, and the same for `ja`. The prefix is no group of
 * a shell's own pattern, so every later reference of the destination counts one group fewer.
 * `undefined` for an entry that is no such run.
 *
 * A run is matched under no locale: its pattern begins with the prefix, right after the `basePath`.
 * An application with `i18n` puts the locale there, and its dynamic routes are not the edge's to
 * pick (`reproducesDynamicRouting`).
 */
function shellsOf(
  route: Route,
  path: string,
  basePath: string,
): { readonly sourceRegex: string; readonly path: string }[] | undefined {
  const escapedBasePath = basePath.replaceAll(REGEXP_SPECIAL, (special) => `\\${special}`);
  const start = `^${escapedBasePath}[/]?/`;
  const prefixed = `${basePath}/${PREFIX_REFERENCE}/`;
  if (
    route.source?.startsWith(`/${PREFIX_REFERENCE}/`) !== true ||
    !route.sourceRegex.startsWith(`${start}(`) ||
    !path.startsWith(prefixed)
  ) {
    return undefined;
  }
  const end = listEnd(route.sourceRegex, start.length + 1);
  if (end === undefined || route.sourceRegex[end + 1] !== '/') {
    return undefined;
  }
  const rest = route.sourceRegex.slice(end + 1);
  const tail = path
    .slice(prefixed.length)
    .replaceAll(POSITIONAL_REFERENCE, (_, place: string) => `$${String(Number(place) - 1)}`);
  return listed(route.sourceRegex.slice(start.length + 1, end)).map((prefix) => {
    return {
      sourceRegex: `${start}${prefix}${rest}`,
      path: `${basePath}/${prefix.replaceAll(ESCAPED, (_, character: string) => character)}/${tail}`,
    };
  });
}

/** The table read back into one entry for each page and one for each page's data, in its order. */
export function pageRoutes(routes: readonly Route[], basePath: string): PageRoute[] {
  return routes.flatMap((route) => {
    const path = route.destination?.split('?', 1)[0];
    if (path === undefined) {
      return [{ route, sourceRegex: route.sourceRegex, template: undefined }];
    }
    const shells = shellsOf(route, path, basePath) ?? [{ sourceRegex: route.sourceRegex, path }];
    return shells.flatMap((shell) => documentAndData(route, shell.sourceRegex, shell.path));
  });
}
