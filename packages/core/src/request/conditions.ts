import type { RouteHas } from '../bundle/schema.ts';

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

function conditionMatches(condition: RouteHas, url: URL, headers: Headers): boolean {
  const value = conditionValue(condition, url, headers);
  if (value === undefined) {
    return false;
  }
  if (condition.value === undefined) {
    return true;
  }
  try {
    // Compiled by Next.js for its own router, which runs them without the unicode flag.
    return (
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
      new RegExp(`^(?:${condition.value})$`).test(value) ||
      (value.length <= MAX_SUBSTRING_MATCH_LENGTH &&
        // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
        new RegExp(condition.value).test(value)) ||
      value === condition.value
    );
  } catch {
    return value === condition.value;
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
