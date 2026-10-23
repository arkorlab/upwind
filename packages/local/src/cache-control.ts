import {
  EDGE_VALIDATED_HEADER,
  hasRouteBodyControlHeader,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';

import type { Reading } from './reading.ts';

/** How an answer says caches may hold it (`files.ts`, `documents.ts`). */

/**
 * A `Cache-Control` value's directives, parted at the commas outside quoted strings (RFC 9110
 * §5.6.1, §5.6.4) — `private="Set-Cookie, X-Id"` is one directive, not two — each as written.
 */
function directivesOf(text = ''): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (quoted && char === '\\') {
      // A quoted pair: the character after it is the string's, a quote or a comma included.
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Whether an answer is kept from every shared cache: `private` naming no field — one naming fields
 * keeps only those from a shared cache, which may store the rest (RFC 9111 §5.2.2.7) — or
 * `no-store`, which keeps it from every cache. Each bare, as the grammar has them: a value beside
 * either is no directive a cache has to heed.
 */
function unshared(directives: readonly string[]): boolean {
  return directives.some(
    (directive) => directive.toLowerCase() === 'private' || directive.toLowerCase() === 'no-store',
  );
}

/**
 * Why an answer that is one visitor's could be kept by a shared cache, if it could: its
 * `Cache-Control` keeps it from none of them, or it carries what a shared cache reads ahead of that
 * (`CDN-Cache-Control` and its kin) — but for one the application set itself (`setByApplication`),
 * which goes out as it set it.
 */
export function sharedCacheFailure(
  answer: Reading,
  setByApplication: (header: string) => boolean,
): string | undefined {
  if (!unshared(directivesOf(answer.headers['cache-control']))) {
    return "answered for shared caches to keep, though the answer is one visitor's";
  }
  return overridingFailure(answer, setByApplication);
}

/**
 * Why an answer the edge hands on as the application gave it could be kept by a shared cache it is
 * not for, if it could (`unsharedUnlessPublic`, `oss/edge/src/handlers/responses.ts`): as
 * `sharedCacheFailure`, but for an answer that says of itself a shared cache may keep all of it
 * (`saidPublic`), to a request `sent` with nothing of a visitor's (`anonymous`) — the application
 * said shared caches may keep it, and the edge hands it on so (decided 2026-10-22). What a CDN
 * reads ahead of `Cache-Control` goes either way.
 */
export function handedOnFailure(
  answer: Reading,
  sent: Readonly<Record<string, string>>,
): string | undefined {
  return anonymous(answer, sent) && saidPublic(answer)
    ? overridingFailure(answer, () => false)
    : sharedCacheFailure(answer, () => false);
}

/**
 * Whether an answer says of itself that a shared cache may keep all of it, as the edge reads it: a
 * bare `public` — one given a value is none the grammar has — with no `private` naming fields,
 * which says a shared cache is to keep none of those, and no cookie, which makes an answer one
 * visitor's.
 */
function saidPublic(answer: Reading): boolean {
  const directives = directivesOf(answer.headers['cache-control']);
  return (
    answer.headers['set-cookie'] === undefined &&
    directives.some((directive) => directive.toLowerCase() === 'public') &&
    directives.every((directive) => !namesFields(directive))
  );
}

/** Whether a directive is a `private` that names fields: one with a value, as the edge reads it. */
function namesFields(directive: string): boolean {
  const name = directive.split('=', 1)[0]?.trim().toLowerCase();
  return name === 'private' && directive.toLowerCase() !== 'private';
}

/**
 * Whether a request carried nothing the application could have told one visitor by, as the edge
 * judges one (`anonymousRequest`): no cookie or `Authorization` — the stack's edge takes no
 * credentials of its own off a request — none of the Next.js control or router-protocol headers
 * (`hasRouteBodyControlHeader`), and no validation the edge took (`EDGE_VALIDATED_HEADER`). As it
 * was sent: the edge judges what the middleware handed on as well, and an answer it kept from
 * shared caches for that says no `public` here, which passes either way.
 */
function anonymous(answer: Reading, sent: Readonly<Record<string, string>>): boolean {
  const headers = new Headers(sent);
  return (
    !headers.has('cookie') &&
    !headers.has('authorization') &&
    !hasRouteBodyControlHeader(headers) &&
    answer.headers[EDGE_VALIDATED_HEADER] !== '1'
  );
}

/** What a shared cache reads ahead of `Cache-Control`, where the application did not set it. */
function overridingFailure(
  answer: Reading,
  setByApplication: (header: string) => boolean,
): string | undefined {
  const overriding = SHARED_CACHE_CONTROL_HEADERS.find(
    (name) => answer.headers[name] !== undefined && !setByApplication(name),
  );
  return overriding === undefined
    ? undefined
    : `answered with ${overriding}, by which a shared cache keeps it, though the answer is one visitor's`;
}
