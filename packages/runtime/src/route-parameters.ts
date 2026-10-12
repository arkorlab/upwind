import type { ResolveRoutesResult } from '@next/routing';
import { standsForClass } from '@stayingupwind/core/bundle';
import { builtNameOf } from '@stayingupwind/core/manifest';

import { resumeUrl } from './incoming.ts';
import { entrypointKindOf, type Store, unlocalizedRouteOf } from './store.ts';

/** A parameter of a route, by the segment that declares it: `[id]`, `[...rest]` or `[[...rest]]`. */
interface RouteParameter {
  readonly name: string;
  /** A catch-all, which holds the rest of the path. */
  readonly rest: boolean;
  /** An optional catch-all, which may hold none of it. */
  readonly optional: boolean;
}

/** A name a parameter may have: anything but a bracket — `[user.id]` is a name, with its period. */
function isParameterName(name: string): boolean {
  return name !== '' && !name.includes('[') && !name.includes(']');
}

function parameterOf(segment: string): RouteParameter | undefined {
  if (segment.startsWith('[[...') && segment.endsWith(']]')) {
    const name = segment.slice('[[...'.length, -']]'.length);
    return isParameterName(name) ? { name, rest: true, optional: true } : undefined;
  }
  if (!segment.startsWith('[') || !segment.endsWith(']')) {
    return undefined;
  }
  const inner = segment.slice(1, -1);
  const rest = inner.startsWith('...');
  const name = rest ? inner.slice('...'.length) : inner;
  return isParameterName(name) ? { name, rest, optional: false } : undefined;
}

function decodedSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** What a template declares at one of its segments, and how the route compared with it holds it. */
interface Declared {
  readonly parameter: RouteParameter;
  readonly placeholder: string;
  /** The route is a class, which a segment spelled as the placeholder leaves open (`standsForClass`). */
  readonly ofClass: boolean;
}

/**
 * The value a route holds where its template declares a parameter, as the query names one (the
 * routed path's segments decoded, a catch-all's joined by `/`): `undefined` where a class holds the
 * template's own placeholder there — it leaves the parameter open — or where the routed path does
 * not hold the same value in the same place. A member spelled like its placeholder (`/blog/[post]`)
 * is a value all the same. The routed path is compared as the build names what it builds
 * (`builtNameOf`): the build keeps a value's `/` escaped (`a%2Fb`) and its `%` as it is (`100%`),
 * where a request escapes both (`a%2Fb`, `100%25`).
 *
 * A class leaves open every parameter it holds the placeholder of, as `keyedParameters` reads one:
 * the query its entries vary on (`allowQuery`) names some of them and not all, since Next.js 16.4
 * leaves out one it resumes for each request (`[id]` of `/[lang]/[region]/posts/[id]`, which varies
 * on `nxtPlang` and `nxtPregion`). A class that fixes a parameter to a value spelled as its
 * placeholder (`lang: '[lang]'`) is recorded just as one that leaves it open, and naming that value
 * would resolve nothing: Next.js reads a placeholder's spelling in the query as the parameter
 * unresolved (`isDefaultValueMatch`, in `normalizeDynamicRouteParams`).
 *
 * The routed path is spelled as the request spelled it — `@next/routing` hands it over undecoded —
 * so each segment is decoded once, as the values routing writes into the query are: `%2520` holds
 * `%20`. Next.js reads a catch-all's value as its segments joined by `/` and splits it there
 * (`normalizeDynamicRouteParams`), so one whose segment holds a `/` of its own (`a%2Fb`) is not
 * named: it would be read as two.
 */
function heldValue(
  declared: Declared,
  held: readonly string[],
  routed: readonly string[],
): string | undefined {
  const { parameter, placeholder, ofClass } = declared;
  if (
    (ofClass && held.length === 1 && held[0] === placeholder) ||
    (held.length === 0 && !parameter.optional) ||
    held.length !== routed.length
  ) {
    return undefined;
  }
  const values: string[] = [];
  for (const [index, segment] of routed.entries()) {
    const value = decodedSegment(segment);
    if (value === undefined || builtNameOf(segment) !== held[index]) {
      return undefined;
    }
    values.push(value);
  }
  return parameter.rest && values.some((value) => value.includes('/'))
    ? undefined
    : values.join('/');
}

/** The segments a parameter declared at `index` holds: one, or for a catch-all — the last — the rest. */
function segmentsAt(
  parameter: RouteParameter,
  segments: readonly string[],
  index: number,
): readonly string[] {
  return parameter.rest ? segments.slice(index) : segments.slice(index, index + 1);
}

/**
 * The parameters `route`, a prerender of `template`, holds values of, by the names the query gives
 * them (`nxtP…`), where `routed` — the path routing ended on — holds the same values; none where
 * `route` does not line up with the template segment for segment.
 *
 * Of `routed` only the values are compared. Routing matched it by the route's own pattern, so its
 * other segments are the route's, though not always as the route spells them: a pattern matches
 * them in any case unless the application asks otherwise, and `/en/DOCS` lands on
 * `/en/docs/[[...slug]]`. What tells which of a route's pages or classes a path is, is its values.
 */
function heldParameters(
  route: string,
  template: string,
  routed: string,
  ofClass: boolean,
): Record<string, string> {
  const routeSegments = route.split('/');
  const routedSegments = routed.split('/');
  const held: Record<string, string> = {};
  for (const [index, placeholder] of template.split('/').entries()) {
    const parameter = parameterOf(placeholder);
    if (parameter === undefined) {
      if (routeSegments[index] !== placeholder) {
        return {};
      }
      continue;
    }
    const value = heldValue(
      { parameter, placeholder, ofClass },
      segmentsAt(parameter, routeSegments, index),
      segmentsAt(parameter, routedSegments, index),
    );
    if (value !== undefined) {
      held[`nxtP${parameter.name}`] = value;
    }
  }
  return held;
}

/**
 * The query routing ended on, with each parameter named (`nxtP…`) that the route it landed on holds
 * a value of in its path and the query does not name.
 *
 * Next.js 16.4 routes a member of a dynamic route whose leading parameters `generateStaticParams`
 * lists — root parameters among them — to the class the build keeps for those values, by a pattern
 * that captures them without naming them: `/en/docs` lands on `/en/docs/[[...slug]]`, a class of
 * `/[locale]/docs/[[...slug]]`, through `/$1/docs/[[...slug]]$3?nxtPslug=$nxtPslug`. The query names
 * `slug` and not `locale`, which only the path routing ended on holds. Handed the path the client
 * asked for (`/docs`, which a middleware rewrote to `/en/docs`) with that query, the page found
 * `locale` in neither, and threw "Could not resolve param value for segment: locale"
 * (`interpolateParallelRouteParams`). Under 16.3 the same request's query named `locale` as well.
 * A member the build prerendered by name (`/docs/a/b` of `/docs/[...slug]`) lands by that name, with
 * no parameter in the query at all, and is named the same way.
 *
 * A parameter is named only where the route holds a value of it rather than its placeholder — a
 * value may itself be spelled in brackets, so a segment is a placeholder only when it is the
 * route's own (`placeholderSegments`) in a route that stands for a class (`standsForClass`) — and
 * `routed`, the path routing ended on without a trailing slash, holds that value in the same place.
 */
export function routeQuery(
  store: Store,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
  routed: string,
): Record<string, string | string[]> {
  const prerender = store.prerendersByPathname.get(route);
  if (prerender === undefined) {
    return target.query;
  }
  const template = prerender.route;
  const ofClass = standsForClass(prerender);
  // A locale's prerender in an application with `i18n` leads with a segment its template does not
  // have (`/fr/blog/post` of `/blog/[slug]`), and so does the path routing ended on: both are read
  // without it, or the locale is read as the template's first value. `i18n` puts no locale in front
  // of an App Router route, whose first segment may be a `[locale]` of its own — an application
  // part way from one router to the other has both.
  const { config } = store.manifest;
  const kind = entrypointKindOf(store, template);
  const unlocalized =
    kind === 'app-page' || kind === 'app-route' ? undefined : unlocalizedRouteOf(config, route);
  const held =
    unlocalized === undefined
      ? heldParameters(route, template, routed, ofClass)
      : heldParameters(
          unlocalized,
          template,
          unlocalizedRouteOf(config, routed) ?? routed,
          ofClass,
        );
  const named = Object.entries(held).filter(([key]) => !Object.hasOwn(target.query, key));
  return named.length === 0 ? target.query : { ...target.query, ...Object.fromEntries(named) };
}

/** What `builtSegment` escapes in a value: a path delimiter, or one already escaped. */
const BUILT_ESCAPE = /%25(?:2f|23|3f|5c)|%(?:2f|23|3f|5c)/giu;

/** One escape `builtSegment` wrote, read back. */
function unescaped(found: string): string {
  return found.startsWith('%25') ? `%${found.slice('%25'.length)}` : decodeURIComponent(found);
}

/**
 * The values `segments` of a page's name hold. A page the build named is named as `builtSegment`
 * spells a value — its path delimiters escaped and nothing else, so a value's own `100%20` is
 * written as it is — and is read back so. A page a request names is spelled as the request spelled
 * it, and each segment is decoded once, as routing decodes what it captures. `undefined` where one
 * does not decode.
 */
function valuesOf(segments: readonly string[], built: boolean): string[] | undefined {
  const values: string[] = [];
  for (const segment of segments) {
    const value = built
      ? segment.replaceAll(BUILT_ESCAPE, (found) => unescaped(found))
      : decodedSegment(segment);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return values;
}

/** `pathname` without the slash a `trailingSlash` application keeps at its end. */
function withoutEndSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * `pathname` without the locale it leads with, in an application with `i18n`: matched in any case,
 * as routing matches one (`normalizeLocalePath`) — `/FR/docs` is the `fr` page's — where the
 * store's own lookups take the build's spelling alone (`unlocalizedRouteOf`).
 */
function withoutLocale(store: Store, pathname: string): string {
  const { i18n, basePath } = store.manifest.config;
  if (i18n === null || i18n === undefined || !pathname.startsWith(`${basePath}/`)) {
    return pathname;
  }
  const bare = pathname.slice(basePath.length);
  const end = bare.indexOf('/', 1);
  const segment = (end === -1 ? bare.slice(1) : bare.slice(1, end)).toLowerCase();
  if (i18n.locales.every((locale) => locale.toLowerCase() !== segment)) {
    return pathname;
  }
  return end === -1 ? basePath || '/' : `${basePath}${bare.slice(end)}`;
}

/**
 * Whether `segment` of a page's path stands for the template's fixed one: as it is spelled, or as
 * its value reads (`valuesOf`) — a request's `%E8%A8%98%E4%BA%8B` is `記事`, where a folder the
 * build names `%2F` is spelled so — in any case, as routing's patterns match it. The page and the
 * route came paired from routing or from the build; this only keeps a path that does not line up
 * with its route from naming anything.
 */
function isFixed(segment: string | undefined, placeholder: string, built: boolean): boolean {
  if (segment === undefined) {
    return false;
  }
  const wanted = placeholder.toLowerCase();
  const [value] = valuesOf([segment], built) ?? [];
  return segment.toLowerCase() === wanted || value?.toLowerCase() === wanted;
}

/**
 * The parameters routing hands a render of `pathname` in its query (`nxtP…`), for a render the
 * platform makes of a page by its path alone — a regeneration rendering a member by its name, a
 * resume of a shell for the path the visitor asked by; `undefined` where Next.js, matching the path
 * itself, reads them the same — every path but one whose catch-all holds an escaped `/` in one of
 * its segments.
 *
 * Routing writes a catch-all's value into the query decoded, its segments joined by `/`, and
 * Next.js splits it there (`normalizeDynamicRouteParams`): `/docs/a%2Fb` of `/docs/[...slug]` is
 * `['a', 'b']`, which is how Next.js says the deployments of its own adapter read such a value
 * (`prerender-encoding`). Matching the path, it splits it first and decodes each segment after,
 * which keeps the `/` in the value: `['a/b']`. So a page rendered by its path said one thing where a
 * render of the visitor's request said the other: a regeneration published the one, and every
 * answer from it said so (`incremental-cache-path-traversal`); and the document a shell was resumed
 * for said the one while the router's payloads for the same page said the other, so the client took
 * them for two pages (`use-router-bfcache-id`).
 *
 * The path is read as routing reads the request for it: its values as `valuesOf` reads them, its
 * fixed segments matched as `isFixed` matches them, a trailing slash left off, and, for a Pages
 * Router route of an application with `i18n`, its locale left out in any case (`withoutLocale`);
 * an App Router route has none in front of it. Every parameter of the route is named once one is,
 * as routing names them all: Next.js takes the query's only where it holds every one.
 */
export function routingParameters(
  store: Store,
  route: string,
  pathname: string,
): Record<string, string> | undefined {
  const template = store.prerendersByPathname.get(route)?.route ?? route;
  const bare = withoutEndSlash(pathname);
  const built = store.prerendersByPathname.has(bare);
  const kind = entrypointKindOf(store, template);
  const member = (
    kind === 'app-page' || kind === 'app-route' ? bare : withoutLocale(store, bare)
  ).split('/');
  const named: Record<string, string> = {};
  let separated = false;
  for (const [index, placeholder] of template.split('/').entries()) {
    const parameter = parameterOf(placeholder);
    if (parameter === undefined) {
      if (!isFixed(member[index], placeholder, built)) {
        return undefined;
      }
      continue;
    }
    const values = valuesOf(segmentsAt(parameter, member, index), built);
    if (values === undefined || (values.length === 0 && !parameter.optional)) {
      return undefined;
    }
    if (values.length > 0) {
      separated ||= parameter.rest && values.some((value) => value.includes('/'));
      named[`nxtP${parameter.name}`] = values.join('/');
    }
  }
  return separated ? named : undefined;
}

/** `url`, a path and its query, with `parameters` added to the query where there are any. */
export function withParameters(
  url: string,
  parameters: Readonly<Record<string, string>> | undefined,
): string {
  if (parameters === undefined) {
    return url;
  }
  const added = new URLSearchParams(parameters).toString();
  return url.includes('?') ? `${url}&${added}` : `${url}?${added}`;
}

/**
 * The URL a shell of `route` is resumed for: the path and query the visitor asked by, without the
 * route's parameters a client may have put in it (`resumeUrl`), and with them as routing reads the
 * path, where Next.js would read them otherwise (`routingParameters`).
 */
export function resumeUrlOf(store: Store, route: string, request: Request): string {
  return withParameters(
    resumeUrl(request),
    routingParameters(store, route, new URL(request.url).pathname),
  );
}
