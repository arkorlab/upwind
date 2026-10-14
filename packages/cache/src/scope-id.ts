/** The longest id a scope is named by: what a deploy issues, and nothing longer. */
const MAX_SCOPE_ID_LENGTH = 256;
/** What a header carries as it is, and a bearer token is made of (RFC 6750): visible ASCII. */
const VISIBLE_ASCII = /^[\u{21}-\u{7E}]+$/u;

/**
 * Whether an id can name a scope: one that no key of another scope's could hold, and no longer
 * than every entrypoint takes one (`MAX_SCOPE_ID_LENGTH`).
 *
 * What the cache keeps of a scope is keyed by its id joined to what follows it, with `:` in KV
 * (`gen:<scope>:<entry>`) and `/` in the bucket (`cache/<scope>/`). An id that carries either
 * reads as another scope's id with more after it: beside a scope `a`, a scope `a:b` would have
 * its records read with `a`'s token, as entries of `a`'s named `b:…`, and retiring `a` would erase
 * the artifacts of a scope `a/b`, which are kept under `a`'s prefix. Whatever deploys a site names
 * a scope by its deployment's id, which carries neither.
 *
 * Nor one that is not visible ASCII. Its token, which carries it, is presented as a bearer in an
 * `Authorization` header, which holds no control character and nothing a byte cannot, and no space
 * in a bearer token: a scope named with any of them could be seeded and never be opened.
 */
export function isScopeId(scopeId: string): boolean {
  return (
    scopeId.length <= MAX_SCOPE_ID_LENGTH &&
    VISIBLE_ASCII.test(scopeId) &&
    !scopeId.includes(':') &&
    !scopeId.includes('/')
  );
}
