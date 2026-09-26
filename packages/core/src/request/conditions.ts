import type { RouteHas } from '../bundle/schema.ts';

/**
 * The `has` / `missing` conditions Next.js attaches to a route or a middleware matcher, evaluated
 * the way its router evaluates them: a condition names a header, cookie, query key or host, and
 * optionally a pattern its value must match. Keep these semantics aligned with @next/routing:
 * empty headers and query values are absent, duplicate cookies use their last value, and a
 * pattern tries a whole-value match before falling back to a substring match.
 */

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
      // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
      new RegExp(condition.value).test(value) ||
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
