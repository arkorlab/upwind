import type { CacheBindings } from '../bindings.ts';
import type { CacheScope } from './cache-scope.ts';

/**
 * The authority of a scope, by name, asked for the region the host keeps its state in where it
 * names one (`AuthorityHost.locationHint`). The hint applies to an object's first creation and is
 * not a guarantee.
 */
export function scopeStub(
  env: CacheBindings,
  scopeId: string,
  locationHint?: DurableObjectLocationHint,
): DurableObjectStub<CacheScope> {
  const namespace = env.CACHE_SCOPE;
  const id = namespace.idFromName(scopeId);
  return locationHint === undefined ? namespace.get(id) : namespace.get(id, { locationHint });
}
