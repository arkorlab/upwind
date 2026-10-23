import type { ScopeSignals } from '@stayingupwind/host/cache';

import type { EdgeBindings } from '../bindings.ts';

/**
 * What the edge reads of its environment where it serves one site on its own account
 * (`./standalone`): the stores every host binds (`EdgeBindings`), the hostnames it is routed, the
 * pointer that names what it serves, and the deployment's Functions by name. One edge serves one
 * site, so nothing here is shared between sites.
 */
export interface StandaloneEnv extends EdgeBindings {
  /**
   * Every hostname a route sends to this edge, comma-separated: the site's own, and every other
   * name it is reached on — its `workers.dev` one where that is enabled. The edge fetches no image
   * source on any of them, nor follows a redirect to one, whichever hostname the request came in on:
   * each is this edge. A name beneath one is not the edge's on that account, unless it is listed.
   * Absent, the edge knows only the hostname each request came in on as its own.
   */
  readonly HOSTNAMES?: string | undefined;
  /**
   * The pointer, as its JSON: fixed for this version of the edge. A deployment is published by
   * deploying the edge again with the next pointer and the Functions it names, and is rolled back
   * by rolling the edge back.
   */
  readonly POINTER?: string | undefined;
  /** Or the key the pointer is kept under in `EDGE_STATE`, read the way it is moved there. */
  readonly POINTER_KEY?: string | undefined;
  /** Cloudflare Images, for `next/image`; absent, a source goes out as it is. */
  readonly IMAGES?: ImagesBinding | undefined;
  /**
   * The bucket's reader (`./blob-worker`), deployed with Workers Cache enabled (`cache.enabled: true`).
   * Service-binding fetch calls consult the callee's cache. Absent, the edge reads `ARTIFACTS` itself.
   */
  readonly BLOBS?: Fetcher | undefined;
  /**
   * The standalone cache's `CacheSignals` entrypoint: where a scope stands, so an invalidation
   * reaches every isolate of this edge within a moment. Absent, it reaches them as KV does.
   */
  readonly CACHE_SIGNALS?:
    | {
        scopeSignals(scopeId: string, since: number | null): Promise<ScopeSignals>;
        readonly currentRecord?: (
          scopeId: string,
          entryId: string,
          afterRevision: number,
        ) => Promise<ArrayBuffer | undefined>;
      }
    | undefined;
  /** Each Function of the deployment, bound by the name the pointer gives it (`functionBinding`). */
  readonly [binding: `APP__${string}`]: Fetcher | undefined;
}
