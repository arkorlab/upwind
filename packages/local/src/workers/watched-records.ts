import { kvGenerationKey } from '@stayingupwind/core/cache';
import type { ScopeSignals } from '@stayingupwind/host/cache';

/** Only the portable RPC values observed here, without a Worker's environment or runtime types. */
interface CacheSignals {
  scopeSignals(scopeId: string, since: number | null): Promise<ScopeSignals>;
  readonly currentRecord?: (
    scopeId: string,
    entryId: string,
    afterRevision: number,
  ) => Promise<ArrayBuffer | undefined>;
}

/** Observe the other source of delivery records, beside the stack's watched KV. */
export function watchedCacheSignals(
  source: CacheSignals | undefined,
  observed: (key: string, bytes: unknown) => void,
): CacheSignals | undefined {
  if (source?.currentRecord === undefined) return source;
  return {
    scopeSignals: (scopeId, since) => source.scopeSignals(scopeId, since),
    async currentRecord(scopeId, entryId, afterRevision) {
      // Call as a member: an RPC stub's method must keep its original receiver.
      const bytes = await source.currentRecord?.(scopeId, entryId, afterRevision);
      if (bytes !== undefined) observed(kvGenerationKey(scopeId, entryId), bytes);
      return bytes;
    },
  };
}
