import type { ResolveRoutesResult } from '@next/routing';

import type { Store } from './store.ts';

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

/**
 * The value a route holds where its template declares `parameter`, as the query names one (decoded,
 * a catch-all's segments joined by `/`): `undefined` where the route holds the template's own
 * placeholder there — the class leaves the parameter open — or where the routed path does not hold
 * the same value in the same place. A built name keeps a value's `/` escaped (`a%2Fb`), and the
 * routed path every character it escapes, so the two are compared decoded.
 */
function heldValue(
  parameter: RouteParameter,
  placeholder: string,
  held: readonly string[],
  routed: readonly string[],
): string | undefined {
  if (
    (held.length === 1 && held[0] === placeholder) ||
    (held.length === 0 && !parameter.optional)
  ) {
    return undefined;
  }
  if (held.length !== routed.length) {
    return undefined;
  }
  const values: string[] = [];
  for (const [index, segment] of held.entries()) {
    const value = decodedSegment(segment);
    if (value === undefined || value !== decodedSegment(routed[index] ?? '')) {
      return undefined;
    }
    values.push(value);
  }
  return values.join('/');
}

/**
 * The parameters `route`, a prerender of `template`, holds values of, by the names the query gives
 * them (`nxtP…`), where `routed` — the path routing ended on — holds the same values; none where the
 * two do not line up with the template segment for segment.
 */
function heldParameters(route: string, template: string, routed: string): Record<string, string> {
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
    // A catch-all is the template's last segment: it holds whatever of the path is left.
    const value = parameter.rest
      ? heldValue(parameter, placeholder, routeSegments.slice(index), routedSegments.slice(index))
      : heldValue(
          parameter,
          placeholder,
          routeSegments.slice(index, index + 1),
          routedSegments.slice(index, index + 1),
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
 * route's own (`placeholderSegments`) — and `routed`, the path routing ended on without a trailing
 * slash, holds that value in the same place.
 */
export function routeQuery(
  store: Pick<Store, 'prerendersByPathname'>,
  route: string,
  target: NonNullable<ResolveRoutesResult['invocationTarget']>,
  routed: string,
): Record<string, string | string[]> {
  const template = store.prerendersByPathname.get(route)?.route;
  if (template === undefined) {
    return target.query;
  }
  const named = Object.entries(heldParameters(route, template, routed)).filter(
    ([key]) => !Object.hasOwn(target.query, key),
  );
  return named.length === 0 ? target.query : { ...target.query, ...Object.fromEntries(named) };
}
