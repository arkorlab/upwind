import { Buffer } from 'node:buffer';

import type { Resolved } from './outputs.ts';

/**
 * What routing a request came to, handed from the app Function that routed it to the one that holds
 * its route (`ROUTED_HEADER`): a deployment whose routes are split across Functions routes each
 * request once, where it first arrives, and the Function that answers it starts where routing left
 * off rather than routing it again.
 *
 * Again would not be the same. The middleware ran in the first Function, against the request as
 * the client sent it; in the second it would be skipped, and what it decided would have to be
 * reconstructed — the status it rewrote with, the request headers it set, the response headers
 * routing collected, the `next.config` rules matched against the URL as asked rather than as
 * rewritten. Handed over, the answer is the one the first Function would have given had it held
 * the route.
 *
 * Opaque to the edge, which copies the value from the `421` it was answered with onto the request
 * it sends on, and never takes one from a client (`PLATFORM_REQUEST_HEADERS`).
 */
export interface HandOff {
  readonly route: Resolved['route'];
  readonly pathname: Resolved['pathname'];
  readonly url: Resolved['url'];
  /** The response headers routing collected (`resolvedHeaders`), in order, a cookie per entry. */
  readonly headers: readonly (readonly [string, string])[];
  /** The status a middleware gave its rewrite, where it gave one other than 200. */
  readonly status?: number | undefined;
  /** Routing landed on `/_next/image`, whose source the Function handed the request fetches. */
  readonly image?: true | undefined;
  /** The request headers the middleware set or replaced, by name, as it left them. */
  readonly set?: readonly (readonly [string, string])[] | undefined;
  /** The request headers the middleware removed. */
  readonly removed?: readonly string[] | undefined;
}

function isPair(pair: unknown): pair is readonly [string, string] {
  return (
    Array.isArray(pair) &&
    pair.length === 2 &&
    typeof pair[0] === 'string' &&
    typeof pair[1] === 'string'
  );
}

function isPairs(value: unknown): value is (readonly [string, string])[] {
  return Array.isArray(value) && value.every((pair) => isPair(pair));
}

function isHandOff(value: unknown): value is HandOff {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const handOff = value as Record<string, unknown>;
  return (
    typeof handOff['route'] === 'string' &&
    typeof handOff['pathname'] === 'string' &&
    typeof handOff['url'] === 'string' &&
    isPairs(handOff['headers']) &&
    (handOff['status'] === undefined || typeof handOff['status'] === 'number') &&
    (handOff['image'] === undefined || handOff['image'] === true) &&
    (handOff['set'] === undefined || isPairs(handOff['set'])) &&
    (handOff['removed'] === undefined ||
      (Array.isArray(handOff['removed']) &&
        handOff['removed'].every((name) => typeof name === 'string')))
  );
}

/** The header value: the hand-off as JSON, in base64url, which a header holds as it is. */
export function encodeHandOff(handOff: HandOff): string {
  return Buffer.from(JSON.stringify(handOff), 'utf8').toString('base64url');
}

/** The hand-off a header carries, or `undefined` for a value that is not one. */
export function decodeHandOff(value: string): HandOff | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return isHandOff(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every value a header holds under a name. `Headers` joins the values of one name into one, except
 * `set-cookie`'s, whose commas are the cookies' own; those are each a value of their own.
 */
function valuesOf(headers: Headers, name: string): string[] {
  if (name === 'set-cookie') {
    return headers.getSetCookie();
  }
  const value = headers.get(name);
  return value === null ? [] : [value];
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, at) => value === b[at]);
}

/**
 * What a middleware changed of the request headers it was handed, for `applyRequestChanges`: each
 * name whose values changed, with every value it holds now.
 */
export function requestChanges(
  before: Headers,
  after: Headers | undefined,
): Pick<HandOff, 'removed' | 'set'> {
  if (after === undefined) {
    return {};
  }
  const set: [string, string][] = [];
  const names = new Set(after.keys());
  for (const name of names) {
    const now = valuesOf(after, name);
    if (!sameValues(now, valuesOf(before, name))) {
      for (const value of now) {
        set.push([name, value]);
      }
    }
  }
  const removed = [...new Set(before.keys())].filter((name) => !after.has(name));
  return {
    ...(set.length > 0 && { set }),
    ...(removed.length > 0 && { removed }),
  };
}

/** The request headers as the middleware left them, rebuilt from those it was handed. */
export function applyRequestChanges(headers: Headers, handOff: HandOff): Headers {
  const out = new Headers(headers);
  const { removed, set } = handOff;
  if (removed !== undefined) {
    for (const name of removed) {
      out.delete(name);
    }
  }
  if (set !== undefined) {
    // Each name changed is replaced whole, by every value it holds now.
    const changed = new Set(set.map(([name]) => name));
    for (const name of changed) {
      out.delete(name);
    }
    for (const [name, value] of set) {
      out.append(name, value);
    }
  }
  return out;
}
