import type { DynamicRoute } from '../manifest/schema.ts';
import { compiledRules, patternOf } from '../request/compiled-patterns.ts';
import type { DeploymentBundle } from './schema.ts';
import { isTemplate, routerSpellings } from './spelling.ts';

/**
 * The pages of their own — the entrypoints that are no template — that a dynamic route's pattern
 * also matches, under each spelling the router finds one by (`filesystemPagesSchema`): Next.js
 * finds each decoded whole ahead of that route, which the edge cannot tell from the pattern alone.
 * A pattern that does not compile is taken to match, as the edge takes it (`pageKeyOf`).
 */
export function filesystemPagesOf(
  bundle: DeploymentBundle,
  dynamicRoutes: readonly DynamicRoute[],
): string[] {
  const patterns = compiledRules(dynamicRoutes);
  const matched = (pathname: string): boolean => {
    return patterns.some((compiled) => {
      try {
        return patternOf(compiled).test(pathname);
      } catch {
        return true;
      }
    });
  };
  const pages = bundle.entrypoints
    .map((entry) => entry.pathname)
    .filter((pathname) => !isTemplate(pathname))
    .flatMap((pathname) => routerSpellings(bundle, pathname));
  return [...new Set(pages)].filter((pathname) => matched(pathname));
}
