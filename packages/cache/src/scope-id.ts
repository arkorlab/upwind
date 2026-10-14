/**
 * Whether an id can name a scope: one that no key of another scope's could hold.
 *
 * What the cache keeps of a scope is keyed by its id joined to what follows it, with `:` in KV
 * (`gen:<scope>:<entry>`) and `/` in the bucket (`cache/<scope>/`). An id that carries either
 * reads as another scope's id with more after it: beside a scope `a`, a scope `a:b` would have
 * its records read with `a`'s token, as entries of `a`'s named `b:…`, and retiring `a` would erase
 * the artifacts of a scope `a/b`, which are kept under `a`'s prefix. Whatever deploys a site names
 * a scope by its deployment's id, which carries neither.
 */
export function isScopeId(scopeId: string): boolean {
  return scopeId !== '' && !scopeId.includes(':') && !scopeId.includes('/');
}
