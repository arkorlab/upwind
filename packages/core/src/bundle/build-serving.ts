import { BuildPatternBudget } from './pattern-budget.ts';
import type { BuildPatternMatcher } from './pattern-matcher.ts';
import * as serving from './serving.ts';

/** Public build APIs always allocate an operation budget unless their caller supplies one. */
export function cacheablePrerenders(
  bundle: Parameters<typeof serving.cacheablePrerenders>[0],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.cacheablePrerenders> {
  return serving.cacheablePrerenders(bundle, patterns);
}

export function completePrerenders(
  bundle: Parameters<typeof serving.completePrerenders>[0],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.completePrerenders> {
  return serving.completePrerenders(bundle, patterns);
}

export function dynamicRouting(
  bundle: Parameters<typeof serving.dynamicRouting>[0],
  routeKeys: Parameters<typeof serving.dynamicRouting>[1],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.dynamicRouting> {
  return serving.dynamicRouting(bundle, routeKeys, patterns);
}

export function edgeServablePrerenders(
  bundle: Parameters<typeof serving.edgeServablePrerenders>[0],
  options: serving.ServableOptions = {},
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.edgeServablePrerenders> {
  return serving.edgeServablePrerenders(bundle, options, patterns);
}

export function edgeServedRewrites(
  bundle: Parameters<typeof serving.edgeServedRewrites>[0],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.edgeServedRewrites> {
  return serving.edgeServedRewrites(bundle, patterns);
}

export function prerenderResponseHeaders(
  bundle: Parameters<typeof serving.prerenderResponseHeaders>[0],
  prerender: Parameters<typeof serving.prerenderResponseHeaders>[1],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.prerenderResponseHeaders> {
  return serving.prerenderResponseHeaders(bundle, prerender, patterns);
}

export function resumablePrerenders(
  bundle: Parameters<typeof serving.resumablePrerenders>[0],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.resumablePrerenders> {
  return serving.resumablePrerenders(bundle, patterns);
}

export function shellHeaders(
  bundle: Parameters<typeof serving.shellHeaders>[0],
  prerender: Parameters<typeof serving.shellHeaders>[1],
  patterns: BuildPatternMatcher = new BuildPatternBudget(),
): ReturnType<typeof serving.shellHeaders> {
  return serving.shellHeaders(bundle, prerender, patterns);
}
