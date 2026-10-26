import type { DynamicRoute } from '../manifest/schema.ts';
import { BuildPatternBudget, BuildPatternBudgetExceededError } from './pattern-budget.ts';
import type { BuildPatternMatcher } from './pattern-matcher.ts';
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
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): string[] {
  const matched = (pathname: string): boolean => {
    return dynamicRoutes.some((route) => {
      try {
        return patterns.test(route.sourceRegex, '', pathname);
      } catch (error) {
        if (error instanceof BuildPatternBudgetExceededError) throw error;
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
