import { isSignableScopeId } from '@stayingupwind/host/cache';

/** The longest id a scope is named by: what a deploy issues, and nothing longer. */
const MAX_SCOPE_ID_LENGTH = 256;

/**
 * Whether an id can name a scope: one that no key of another scope's could hold, that a token can
 * be signed for, and no longer than every entrypoint takes one (`MAX_SCOPE_ID_LENGTH`).
 *
 * What the cache keeps of a scope is keyed by its id joined to what follows it, with `:` in KV
 * (`gen:<scope>:<entry>`) and `/` in the bucket (`cache/<scope>/`). An id that carries either
 * reads as another scope's id with more after it: beside a scope `a`, a scope `a:b` would have
 * its records read with `a`'s token, as entries of `a`'s named `b:…`, and retiring `a` would erase
 * the artifacts of a scope `a/b`, which are kept under `a`'s prefix. Whatever deploys a site names
 * a scope by its deployment's id, which carries neither.
 *
 * Its token carries it, as a bearer in an `Authorization` header, so it is made of what a token can
 * be signed for (`isSignableScopeId`): a bearer token's characters but `.` and `=`. `:` is none of
 * them, and `/` is one, so the two rules leave a scope id ASCII letters, digits, `-`, `_`, `~` and
 * `+`. Each separator is refused here all the same, as the keys' own rule.
 */
export function isScopeId(scopeId: string): boolean {
  return (
    scopeId.length <= MAX_SCOPE_ID_LENGTH &&
    isSignableScopeId(scopeId) &&
    !scopeId.includes(':') &&
    !scopeId.includes('/')
  );
}
