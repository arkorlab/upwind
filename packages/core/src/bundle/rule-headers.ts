import { interpolateHeader } from '../manifest/dynamic.ts';
import type { HeaderRule } from '../manifest/schema.ts';
import type { BuildPatternMatcher } from './pattern-matcher.ts';
import type { Route, RouterReferences } from './schema.ts';
import type { ServingBundle } from './serving.ts';

/**
 * The header rules of `next.config` as the router applies them to a path, from the pathname alone:
 * what a page's document is answered with when the manifest folds them into its route
 * (`applicableHeaders`, in `serving.ts`), and what a shipped file is when they are stored on its
 * entry (`shippedFileHeadersOf`) — one matcher for both, so the two cannot disagree on what a rule
 * sets on a path.
 */

/** The phases `headerPhases` reads, each named as the manifest records a rule's (`HeaderRule.phase`). */
const HEADER_PHASES = ['beforeMiddleware', 'afterFiles', 'onMatch'] as const;

/** `headerPhases`, each rule with the phase it came from. */
export function phasedHeaderRoutes(
  bundle: Pick<ServingBundle, 'routing'>,
): { readonly route: Route; readonly phase: NonNullable<HeaderRule['phase']> }[] {
  return HEADER_PHASES.flatMap((phase) => bundle.routing[phase].map((route) => ({ route, phase })));
}

/** The routing phases whose header rules apply to a document, in the order Next.js applies them. */
export function headerPhases(bundle: Pick<ServingBundle, 'routing'>): Route[] {
  return phasedHeaderRoutes(bundle).map(({ route }) => route);
}

/** Whether a rule holds for some requests and not others: one with `has` or `missing`. */
export function isConditional(rule: Route): boolean {
  return rule.has !== undefined || rule.missing !== undefined;
}

/** What a rule is matched with: the router's references, and the allowance a build matches within. */
export interface RuleMatching {
  readonly references: RouterReferences | undefined;
  readonly patterns: BuildPatternMatcher;
}

/**
 * The headers `rule` sets on `pathname`, each name lowercased, in the rule's order; `undefined`
 * where its pattern does not match. Compiled by Next.js for its own router, which runs them without
 * the unicode flag, and without regard to case: a rule for `/Shop/:slug` sets its headers on
 * `/shop/x` too. With the `:name` and `$n` references filled in from what the path matched, as the
 * router fills them: a rule written `value: ':slug'` means the value, not the six characters.
 */
export function headersSetAt(
  rule: Route,
  pathname: string,
  matching: RuleMatching,
): (readonly [string, string])[] | undefined {
  if (rule.headers === undefined) {
    return undefined;
  }
  const match = matching.patterns.exec(rule.sourceRegex, 'i', pathname);
  if (match === null) {
    return undefined;
  }
  return Object.entries(rule.headers).map(([name, value]): readonly [string, string] => {
    return [
      interpolateHeader(name, match, matching.references).toLowerCase(),
      interpolateHeader(value, match, matching.references),
    ];
  });
}
