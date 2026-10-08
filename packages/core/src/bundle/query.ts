import type { Prerender } from './schema.ts';
import { placeholderSegments } from './spelling.ts';

/** The parameter a route's segment stands for: `[id]`, `[...slug]` and `[[...slug]]` alike. */
const PARAMETER = /^\[\[?(?:\.\.\.)?(.+?)\]\]?$/u;

/**
 * Whether a prerender varies on query keys not already identified by its pathname: a key that
 * names none of the route's parameters, or one whose segment the pathname leaves a placeholder.
 *
 * A shell completed with the parameters its route's entries vary on — `/de/fr/posts/[id]` of
 * `/[lang]/[region]/posts/[id]`, which Next.js 16.4 keys on `lang` and `region` alone — is
 * identified by the values it was completed with, as a page is by all of its. A pathname that
 * holds a bracket anywhere else — a template's payload (`/posts/[id].rsc`), a value spelled with
 * one — is taken to vary, as it always was: nothing here reads which of its parameters it names.
 */
export function queryDependent(
  prerender: Prerender | undefined,
  route: string,
  pathname: string,
): boolean {
  const allowed = prerender?.allowQuery ?? [];
  if (allowed.length === 0) {
    return false;
  }
  const placeholders = placeholderSegments(pathname, route);
  const unresolved = new Set<string>();
  for (const [index, segment] of pathname.split('/').entries()) {
    const parameter = placeholders[index] === true ? PARAMETER.exec(segment)?.[1] : undefined;
    if (parameter !== undefined) {
      unresolved.add(parameter);
    } else if (segment.includes('[')) {
      return true;
    }
  }
  const identified = new Set(
    route.split('/').flatMap((segment) => {
      const parameter = PARAMETER.exec(segment)?.[1];
      return parameter === undefined || unresolved.has(parameter)
        ? []
        : [parameter, `nxtP${parameter}`];
    }),
  );
  return allowed.some((key) => !identified.has(key));
}
