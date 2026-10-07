import type { RouteHas } from '../bundle/schema.ts';
import { ROUTER_REQUEST_HEADERS } from './constants.ts';
import { assertAffordable } from './pattern-cost.ts';

/**
 * The `has` / `missing` conditions Next.js attaches to a route or a middleware matcher, evaluated
 * the way its router evaluates them: a condition names a header, cookie, query key or host, and
 * optionally a pattern its value must match. Keep these semantics aligned with @next/routing:
 * empty headers and query values are absent, duplicate cookies use their last value, and a
 * pattern tries a whole-value match before falling back to a substring match.
 */

/**
 * The longest value the *substring* attempt is made against; past it only the whole-value one is.
 *
 * `unsafeRoutePatternReason` refuses the patterns that backtrack exponentially, but it is a shape
 * check and says so: a pattern of the `a+b` shape is admitted. Anchored, such a pattern is tried
 * from one position and costs a run linear in the value. Unanchored, it is tried from every
 * position and costs one quadratic in it — and the value is a header, a cookie or a query
 * parameter, whose length a visitor chooses, on a Function every project shares.
 *
 * So the expensive half is the half that is bounded, and the cheap half always runs. Measured on
 * `a+b`, which the shape check admits: anchored against 200,000 characters, 0.33 ms; unanchored
 * against the same, 17.8 seconds; unanchored at this bound, 7.5 ms. What the bound gives up is a
 * pattern that matches only *within* a value longer than it, which then reads as
 * the non-match it reads as in `@next/routing` when the whole-value attempt fails and nothing
 * else matches. Nothing a routing rule is written about — a locale, a flag, a bearer token — is
 * near this length, and a rule written `^admin$`, `Bearer .*` or `multipart/form-data;.*` is
 * answered exactly as Next.js answers it however long the value is.
 *
 * Bounding the whole condition instead was the first shape of this, and it was worse: an answer of
 * "cannot tell" has no reading that is safe for every caller at once — a middleware matcher has to
 * run the middleware, a redirect has to not fire — and a visitor could pick which by the length of
 * a header.
 */
const MAX_SUBSTRING_MATCH_LENGTH = 4096;

function cookieValue(header: string | null, key: string | undefined): string | undefined {
  if (header === null || header === '') {
    return undefined;
  }
  let found: string | undefined;
  const parts = header.split(';');
  for (const part of parts) {
    const [name, ...value] = part.trim().split('=');
    if (name !== '' && name === key) {
      found = value.join('=');
    }
  }
  return found;
}

function nonemptyValue(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function conditionValue(condition: RouteHas, url: URL, headers: Headers): string | undefined {
  switch (condition.type) {
    case 'header': {
      return nonemptyValue(headers.get(condition.key ?? ''));
    }
    case 'cookie': {
      return cookieValue(headers.get('cookie'), condition.key);
    }
    case 'query': {
      return nonemptyValue(url.searchParams.get(condition.key ?? ''));
    }
    case 'host': {
      return url.hostname;
    }
  }
}

/**
 * A condition's pattern, compiled both ways it is tried: against the whole value, and anywhere in
 * it. `undefined` for a form that does not compile — the whole-value one read as the literal
 * comparison it always was, the other as no match.
 */
interface ConditionPatterns {
  readonly whole: RegExp | undefined;
  readonly part: RegExp | undefined;
}

/**
 * Compiled once per condition rather than on every request that reads it, as a rule's own pattern
 * is (`compiledRules`): a partially prerendered page's `bypassFor` carries the application's whole
 * list of crawlers as one of these, and it is read for every document of the page.
 */
const conditionPatterns = new WeakMap<RouteHas, ConditionPatterns>();

function compiledOrUndefined(source: string): RegExp | undefined {
  try {
    // Compiled by Next.js for its own router, which runs them without the unicode flag.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

function patternsOf(condition: RouteHas, pattern: string): ConditionPatterns {
  let patterns = conditionPatterns.get(condition);
  if (patterns === undefined) {
    patterns = {
      whole: compiledOrUndefined(`^(?:${pattern})$`),
      part: compiledOrUndefined(pattern),
    };
    conditionPatterns.set(condition, patterns);
  }
  return patterns;
}

function conditionMatches(condition: RouteHas, url: URL, headers: Headers): boolean {
  const value = conditionValue(condition, url, headers);
  if (value === undefined) {
    return false;
  }
  if (condition.value === undefined) {
    return true;
  }
  const { whole, part } = patternsOf(condition, condition.value);
  // The value as written matches whatever the pattern makes of it, and asks no test to say so.
  if (whole === undefined || value === condition.value) {
    return value === condition.value;
  }
  // Each attempt within what a test is allowed (`assertAffordable`), asked before it is made and
  // outside the `try`: a test the edge does not run is no failure to compare as a literal.
  assertAffordable(whole, value);
  if (patternHolds(whole, value)) {
    return true;
  }
  if (part !== undefined && value.length <= MAX_SUBSTRING_MATCH_LENGTH) {
    assertAffordable(part, value);
    return patternHolds(part, value);
  }
  return false;
}

/** A test of a condition's pattern. One that throws is read as no match. */
function patternHolds(pattern: RegExp, value: string): boolean {
  try {
    return pattern.test(value);
  } catch {
    return false;
  }
}

export interface Conditioned {
  readonly has?: readonly RouteHas[] | undefined;
  readonly missing?: readonly RouteHas[] | undefined;
}

/**
 * Any one of the conditions holds. This is how Next.js reads a prerender's `bypassFor`: a list of
 * reasons to skip the cache (a Server Action header, a multipart body, a bot's user agent), any
 * one of which is enough — not a rule whose conditions must all hold.
 */
export function anyConditionHolds(
  conditions: readonly RouteHas[],
  url: URL,
  headers: Headers,
): boolean {
  return conditions.some((condition) => conditionMatches(condition, url, headers));
}

/** Every `has` condition holds and every `missing` condition fails, as Next.js requires of both. */
export function conditionsHold(rule: Conditioned, url: URL, headers: Headers): boolean {
  const has = (rule.has ?? []).every((condition) => conditionMatches(condition, url, headers));
  const missing = (rule.missing ?? []).every(
    (condition) => !conditionMatches(condition, url, headers),
  );
  return has && missing;
}

/** A condition only a request carrying one of the client router's own headers meets. */
function requiresRouterHeader(condition: RouteHas): boolean {
  return (
    condition.type === 'header' &&
    condition.key !== undefined &&
    // A header's name is compared as `Headers` compares it: whatever case the rule spells it in.
    ROUTER_REQUEST_HEADERS.includes(condition.key.toLowerCase())
  );
}

/**
 * Whether these conditions can hold for a request the edge answers with a document at all.
 *
 * Not where one of them requires a header only a client's router sends (`ROUTER_REQUEST_HEADERS`):
 * a request carrying one is never answered with a document (`classifyRequest`), so a rule it
 * guards never applies to one, and a page it covers is not a page the rule can change. Next.js
 * writes one such rule into every build that has a deployment id — the id on each RSC response,
 * over every path, for a request whose `rsc` is `1` — and read as a condition the build cannot
 * settle, it took every page of an application whose rules are settled at build time off the edge.
 *
 * Only `has` is read so. A `missing` of the same headers holds for every document, which is a
 * rule that does apply: it is left as the condition it is, for whoever judges conditions to judge.
 */
export function mayHoldForDocument(rule: Conditioned): boolean {
  return (rule.has ?? []).every((condition) => !requiresRouterHeader(condition));
}
