import type { RouteHas } from '@stayingupwind/core/bundle';
import type { HeaderRule } from '@stayingupwind/core/manifest';
import { compareCodeUnits } from '@stayingupwind/core/util';

import { protocolCondition } from './escaping.ts';

interface Selector {
  readonly has: readonly string[];
  readonly missing: readonly string[];
}

/** The same condition names the same boolean test, whatever order or header casing it uses. */
function conditionKey(condition: RouteHas): string {
  const key = condition.type === 'header' ? condition.key?.toLowerCase() : condition.key;
  return JSON.stringify([condition.type, key, condition.value]);
}

function testsOf(conditions: readonly RouteHas[] = []): readonly string[] {
  return [
    ...new Set(
      conditions
        .filter((condition) => !protocolCondition(condition))
        .map((condition) => conditionKey(condition)),
    ),
  ].toSorted(compareCodeUnits);
}

/** These requests cannot carry a condition and lack that very condition at once. */
function disjoint(left: Selector, right: Selector): boolean {
  return (
    left.has.some((test) => right.missing.includes(test)) ||
    right.has.some((test) => left.missing.includes(test))
  );
}

/**
 * One request per selector proves no partition of overlapping selectors. Treat only identical
 * tests or a direct has/missing contradiction as established here. In particular, different
 * regex spellings or literals are no proof of disjoint languages under the shared matcher.
 */
export function ruleOverlapFailure(rules: readonly HeaderRule[]): string | undefined {
  const selectors = rules
    .map((rule) => ({ has: testsOf(rule.has), missing: testsOf(rule.missing) }))
    .filter((selector) => selector.has.length > 0 || selector.missing.length > 0);
  for (const [index, left] of selectors.entries()) {
    const later = selectors.slice(index + 1);
    for (const right of later) {
      if (JSON.stringify(left) !== JSON.stringify(right) && !disjoint(left, right)) {
        return 'distinct conditioned header rules are not proved disjoint, and the check does not cover every overlapping branch: no request proves them';
      }
    }
  }
  return undefined;
}
