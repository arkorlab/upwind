import type { ResolveRoutesResult } from '@next/routing';
import { type Prerender, standsForClass } from '@stayingupwind/core/bundle';
import { builtNameOf } from '@stayingupwind/core/manifest';

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

/** What a template declares at one of its segments, and whether the route leaves it open there. */
interface Declared {
  readonly parameter: RouteParameter;
  readonly placeholder: string;
  /** Where the route holds the placeholder, the parameter is open (`leavesOpen`). */
  readonly open: boolean;
}

/**
 * Whether a prerender leaves a parameter open where it holds the parameter's placeholder. A member
 * leaves nothing open; a class (`standsForClass`) leaves open what its entries vary on, which the
 * build names as the query they vary on (`allowQuery`): a class may fix one parameter to a value
 * spelled as its placeholder and leave another open — `/[lang]/docs/[[...slug]]` of
 * `lang: '[lang]'`, which varies on `nxtPslug` alone. Where the build names no such query, every
 * placeholder of a class is open, as `keyedParameters` reads a class that names none.
 */
function leavesOpen(prerender: Prerender, name: string): boolean {
  if (!standsForClass(prerender)) {
    return false;
  }
  const { allowQuery } = prerender;
  return allowQuery === undefined || allowQuery.length === 0 || allowQuery.includes(`nxtP${name}`);
}

/**
 * The value a route holds where its template declares a parameter, as the query names one (the
 * routed path's segments decoded, a catch-all's joined by `/`): `undefined` where the route holds
 * the template's own placeholder there and leaves the parameter open (`leavesOpen`), or where the
 * routed path does not hold the same value in the same place. A value spelled like its placeholder
 * (`/blog/[post]`, of a member) is a value all the same. The routed path is compared as the build
 * names what it builds (`builtNameOf`): the build keeps a value's `/` escaped (`a%2Fb`) and its `%`
 * as it is (`100%`), where a request escapes both (`a%2Fb`, `100%25`).
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
  const { parameter, placeholder, open } = declared;
  if (
    (open && held.length === 1 && held[0] === placeholder) ||
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
 * The parameters `route` — `prerender`'s pathname, a path of `template` — holds values of, by the
 * names the query gives them (`nxtP…`), where `routed` — the path routing ended on — holds the same
 * values; none where `route` does not line up with the template segment for segment.
 *
 * Of `routed` only the values are compared. Routing matched it by the route's own pattern, so its
 * other segments are the route's, though not always as the route spells them: a pattern matches
 * them in any case unless the application asks otherwise, and `/en/DOCS` lands on
 * `/en/docs/[[...slug]]`. What tells which of a route's pages or classes a path is, is its values.
 */
function heldParameters(
  prerender: Prerender,
  route: string,
  template: string,
  routed: string,
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
      { parameter, placeholder, open: leavesOpen(prerender, parameter.name) },
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
 * route's own (`placeholderSegments`) in a route that leaves it open (`leavesOpen`) — and `routed`,
 * the path routing ended on without a trailing slash, holds that value in the same place.
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
      ? heldParameters(prerender, route, template, routed)
      : heldParameters(
          prerender,
          unlocalized,
          template,
          unlocalizedRouteOf(config, routed) ?? routed,
        );
  const named = Object.entries(held).filter(([key]) => !Object.hasOwn(target.query, key));
  return named.length === 0 ? target.query : { ...target.query, ...Object.fromEntries(named) };
}
