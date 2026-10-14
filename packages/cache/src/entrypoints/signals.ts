import {
  MAX_RECENT_INVALIDATIONS,
  RECENT_INVALIDATIONS_MS,
  type ScopeSignals,
} from '@stayingupwind/host/cache';
import { WorkerEntrypoint } from 'cloudflare:workers';

import type { AuthorityHost } from '../authority-host.ts';
import type { CacheBindings } from '../bindings.ts';
import { scopeRetired } from '../gateway/retirement.ts';
import { scopeStub } from '../scope/stub.ts';

/** A scope id as the authority's objects are named by: what a deploy issued, and nothing longer. */
const MAX_SCOPE_ID_LENGTH = 256;

/**
 * The authority as an edge in front of a host's Functions asks it over a service binding: where a
 * scope stands, and the invalidations a data center's reads may still be behind on (`ScopeSignals`),
 * past the revision the edge last heard of (`since`; `null` where it heard nothing). Read-only, and
 * answered from the scope's object as its tag delta is; a scope never seeded, or retired, stands
 * nowhere. A retired scope's object keeps its tables until retention erases them, so its marker is
 * read beside the delta, as the gateway reads it beside each of a scope's answers
 * (`gateway/retirement.ts`).
 *
 * Where a scope stands is its tags' rows, as the delta a Function catches up with reads them. A tag
 * the host's control entrypoint invalidates that no entry of the scope carries has no row, and is
 * not among them: no record the scope holds carries it to be condemned, a render that read before
 * it and commits after is refused by its fence, and its mark reaches readers through KV
 * (`scope/invalidations.ts`). A revision that counted it would leave every Function behind one the
 * delta never reaches, catching up on each request for as long as the invalidation is recent.
 */
export function cacheSignals(authority: AuthorityHost): CacheSignalsClass {
  return class extends WorkerEntrypoint<CacheBindings> implements CacheSignals {
    async scopeSignals(scopeId: string, since: number | null): Promise<ScopeSignals> {
      if (scopeId === '' || scopeId.length > MAX_SCOPE_ID_LENGTH) {
        throw new Error('no such scope');
      }
      const after = since !== null && Number.isSafeInteger(since) && since > 0 ? since : 0;
      const [delta, retired] = await Promise.all([
        scopeStub(this.env, scopeId, authority.locationHint).tagsDelta(
          after,
          MAX_RECENT_INVALIDATIONS,
          Date.now() - RECENT_INVALIDATIONS_MS,
        ),
        scopeRetired(this.env.CACHE_STATE, scopeId),
      ]);
      const announced = authority.announces?.(this.env) === true;
      if (retired) {
        return { revision: 0, invalidatedAt: null, tags: [], truncated: false, announced };
      }
      return {
        revision: delta.latest?.revision ?? 0,
        invalidatedAt: delta.latest?.invalidatedAt ?? null,
        tags: delta.tags,
        truncated: delta.truncated,
        announced,
      };
    }
  };
}

/** The entrypoint class `cacheSignals` makes: one the runtime constructs, as it does any. */
export type CacheSignalsClass = new (
  ctx: ExecutionContext,
  env: CacheBindings,
) => CacheSignals & WorkerEntrypoint<CacheBindings>;

/** What an edge may ask of the authority (`cacheSignals`). */
export interface CacheSignals {
  scopeSignals(scopeId: string, since: number | null): Promise<ScopeSignals>;
}
