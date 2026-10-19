import { SHARED_CACHE_CONTROL_HEADERS } from '@stayingupwind/core/request';

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
  const overriding = SHARED_CACHE_CONTROL_HEADERS.find(
    (name) => answer.headers[name] !== undefined && !setByApplication(name),
  );
  return overriding === undefined
    ? undefined
    : `answered with ${overriding}, by which a shared cache keeps it, though the answer is one visitor's`;
}
