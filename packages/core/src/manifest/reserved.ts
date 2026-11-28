import { type CompiledRule, compiledRules, patternOf } from '../request/compiled-patterns.ts';
import { conditionsHold } from '../request/conditions.ts';
import { testWithin } from '../request/pattern-budget.ts';
import type { ReservedRoute } from './schema.ts';

/**
 * Whether a redirect or a rewrite from `next.config` claims a pathname before the edge could:
 * before the dynamic routes, or — `beforeFilesOnly` — before the filesystem, which is what a
 * shipped file's path has to clear.
 *
 * Taken on the rules alone, so a host can ask the same question of a build it is
 * about to publish as the edge asks of the manifest it publishes: a document the edge will not
 * serve from storage must not be validated as though it would.
 */
export function pathIsReserved(
  reserved: readonly ReservedRoute[],
  url: URL,
  headers: Headers,
  beforeFilesOnly: boolean,
): boolean {
  return firstReservedRule(reserved, url, headers, beforeFilesOnly) !== undefined;
}

/** Keep the first match in routing order, including rules with no placement information. */
export function firstReservedRule(
  reserved: readonly ReservedRoute[],
  url: URL,
  headers: Headers,
  beforeFilesOnly: boolean,
): CompiledRule<ReservedRoute> | undefined {
  return compiledRules(reserved, 'i').find((compiled) => {
    const { rule } = compiled;
    return (
      (!beforeFilesOnly || rule.beforeFiles === true) &&
      testWithin(patternOf(compiled), url.pathname) &&
      conditionsHold(rule, url, headers)
    );
  });
}
