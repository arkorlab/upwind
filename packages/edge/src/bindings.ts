/**
 * What the edge reads of its environment on its own, whatever host it serves for: the store its
 * pointers, manifests, policies and shells are in, the store its runtime cache's delivery records
 * are in, the bucket a deployment's blobs are in, and two switches. Whatever else a host binds is
 * the host's to read, and to hand the edge as `EdgeHost` and `EdgeRuntime`.
 *
 * A host passes its own environment as it stands — nothing is copied out of it per request — and
 * any environment that binds these under these names is one.
 */
export interface EdgeBindings {
  readonly EDGE_STATE: KVNamespace;
  readonly CACHE_STATE: KVNamespace;
  readonly ARTIFACTS: R2Bucket;
  /**
   * Workers Static Assets holding shells, for the `static-assets` shell backend. Absent wherever
   * that backend is not used: a Worker with Static Assets is entered through Cloudflare's router
   * Worker ahead of every request, so it is present only where a harness passes one in.
   */
  readonly ASSETS?: Fetcher | undefined;
  /**
   * `off` — in any case, with whitespace around it ignored — sends a brotli rendering's document
   * as one layer, its suffix framed uncompressed behind the head (`content-encoding: br`), rather
   * than inside a second layer that compresses the suffix (`br, br`). Unset, or anything else,
   * layers for the clients whose user agent says they undo two codings (`layered-clients.ts`).
   */
  readonly LAYERED_BROTLI?: string | undefined;
}
