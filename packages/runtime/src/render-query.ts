import { isRouteParameterKey } from './incoming.ts';

/**
 * The query asked for, with the route's parameters as routing ended on (`nxtP…`, `nxtI…`) after
 * it, the query itself left as it was spelled. Next.js consumes these keys for params and leaves
 * their unprefixed names out of searchParams (`RouteModule.prepare`). An escaped catch-all uses
 * separate params/query metadata instead (`renderQuery`), because URL query cannot carry its
 * single-element array. A client's prefixed keys have already been removed before routing.
 */
export function withRouteParameters(
  search: string,
  query: Record<string, string | string[]>,
): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const items = Array.isArray(value) ? value : [value];
    if (isRouteParameterKey(key)) {
      for (const item of items) {
        parameters.append(key, item);
      }
    }
  }
  const added = parameters.toString();
  if (added === '') {
    return search;
  }
  return search === '' ? `?${added}` : `${search}&${added}`;
}

/**
 * The final search query for an escaped catch-all render. Next.js applies configured rewrites
 * again, but its prefixed query protocol cannot preserve a one-element catch-all array. Give it
 * the already-resolved query beside params instead: drop generated route fields, retain rewrite
 * extras, and preserve ordinary route-name collisions exactly as the handler URL carried them.
 */
export function renderQuery(
  target: Readonly<Record<string, unknown>>,
  url: string,
  params: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [key, field] of Object.entries(target)) {
    let value: string | string[] | undefined;
    if (typeof field === 'string') {
      value = field;
    } else if (Array.isArray(field)) {
      // A router parser can seed repeated prototype-like keys with an inherited function.
      const strings = field.filter((part: unknown): part is string => typeof part === 'string');
      value = strings.length === field.length || strings.length > 1 ? strings : strings[0];
    }
    if (value !== undefined && !isRouteParameterKey(key) && !Object.hasOwn(params, key)) {
      query.set(key, value);
    }
  }
  restoreCollisions(query, url, params);
  return Object.fromEntries(query);
}

/** An ordinary search value with the same name as a route parameter belongs to the caller. */
function restoreCollisions(
  query: Map<string, string | string[]>,
  url: string,
  params: Record<string, string | string[]>,
): void {
  const original = new URL(url, 'https://route.invalid').searchParams;
  for (const key of Object.keys(params)) {
    const values = original.getAll(key);
    if (values.length > 0) {
      query.set(key, values.length === 1 ? (values[0] ?? '') : values);
    }
  }
}
