import type { CacheNaming } from '@stayingupwind/host/cache';

import type { IsrWrite } from './scope/metering.ts';

/**
 * What a host is told of the cache's metered reads and writes: said as an answer goes out and never
 * before it is certain to, synchronously, so that it costs the answer a call and nothing more.
 */
interface CacheMeter {
  /**
   * A read the cache's storage answered: a record, a value, an artifact. Told as the read's answer
   * goes out: a call that throws loses the read's line, which the gateway logs instead, and the
   * read is answered all the same.
   */
  read(scopeId: string, bytes: number): void;
  /**
   * A write the authority made: a generation it published, or a value it took. Told once the write
   * has committed: a call that throws loses the write's line, which the gateway logs instead, and
   * the write is answered as made all the same.
   */
  write(scopeId: string, write: IsrWrite): void;
}

/**
 * What a host decides for its cache authority: the label its tokens are signed over, the region a
 * scope's object is first created in, and what it is told of each metered read and write. Made once
 * and handed to the gateways' factories at module scope, so no request pays for it.
 */
export interface AuthorityHost {
  readonly naming: CacheNaming;
  /** Applies to an object's first creation, and is not a guarantee; none lets the runtime choose. */
  readonly locationHint?: DurableObjectLocationHint | undefined;
  readonly meter: CacheMeter;
  /**
   * Tell whatever keeps where a scope stands elsewhere — an edge's copies in each data center —
   * that it has moved: called once an invalidation of the scope has been recorded, whoever asked
   * for it — a Function through the gateway, the host through its control entrypoint, a resource's
   * change that moved its tag — with the Worker's environment as the entrypoint was handed it. A
   * Function's invalidation is answered once it has resolved, or once `ANNOUNCE_WAIT_MS` has gone
   * by; the host's own are answered at once, and told behind (`announce.ts`). Optional: without
   * it, those copies hear of the scope when they ask again (`CacheSignals`). Never to reject.
   */
  readonly announce?: ((scopeId: string, env: unknown) => Promise<void>) | undefined;
  /**
   * Whether `announce` tells anything under this environment — a purge configured, say: what an
   * edge is told when it asks (`ScopeSignals.announced`), so that it keeps its copies for long only
   * where something tells them when the scope moves. Absent, nothing does.
   */
  readonly announces?: ((env: unknown) => boolean) | undefined;
}
