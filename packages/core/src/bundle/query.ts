import type { Prerender } from './schema.ts';

/** Whether a prerender varies on query keys not already identified by its concrete pathname. */
export function queryDependent(
  prerender: Prerender | undefined,
  route: string,
  pathname: string,
): boolean {
  const allowed = prerender?.allowQuery ?? [];
  if (allowed.length === 0) {
    return false;
  }
  if (pathname.includes('[')) {
    return true;
  }
  const routeParams = new Set(
    route.split('/').flatMap((segment) => {
      const parameter = /^\[\[?(?:\.\.\.)?(.+?)\]\]?$/u.exec(segment)?.[1];
      return parameter === undefined ? [] : [parameter, `nxtP${parameter}`];
    }),
  );
  return allowed.some((key) => !routeParams.has(key));
}
