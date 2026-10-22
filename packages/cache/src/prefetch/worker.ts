import { PREFETCH_BLOB_PATH } from '@stayingupwind/host/bindings';
// The key the upload writes, from the module of the storage keys alone: imported once from behind a
// barrel of build schemas, it brought zod and every schema with it, 819 KiB of this Worker's 820.
import { blobObjectKey } from '@stayingupwind/host/storage';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { recordPrefetchAudit } from './audit.ts';

/**
 * One blob of a deployment's own bundle, by the sha256 the bundle names it with.
 *
 * Why this Worker exists: the adapter can leave a build's prefetch segments out of the Function
 * (`AdapterOptions.unshippedOutputs`), which for a large application is a large share of it,
 * because the edge serves those prefetches from the artifacts the deployment was published with.
 * The Function then has no bytes for a prefetch the edge *could not* serve: a middleware that
 * failed, an edge with no manifest to read, a request that reached the Worker without the edge
 * serving the prefetch at all.
 * Rendering one is not possible (upwind#63 measured both ways it looked possible), so the Function
 * asks for the bytes, and this answers.
 *
 * Why a Worker of its own rather than a door on one that exists:
 *
 * - The read gateway is on the ISR hot path and holds `CACHE_STATE` alone. Giving it the artifacts
 *   bucket would widen what every application reaches through the binding it already has.
 * - Nor any Worker that does more than this: whatever else it answers, every application's Function
 *   bound to it could ask it for — the wrong trade to save a file.
 *
 * Ordinary delivery remains one read, one bucket and one blob key shape. The explicitly enabled
 * migration audit writes a separate private witness; no request can choose its contents or key.
 *
 * Hosted Functions use `PrefetchForDeployment`: the host configures their accepted bundle's
 * digests as immutable binding props. Knowing another deployment's digest grants no access.
 * The default entrypoint is retained only while existing bindings are migrated; it remains an
 * unscoped capability during that transition and must be disabled after the binding audit.
 */

/** What a sha256 looks like written down; anything else is not a key this Worker will build. */
const SHA256 = /^[0-9a-f]{64}$/u;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
/** A deployment is immutable and a blob is its content, so a hit is good for as long as anyone has. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * What a blob is answered with. The type is the asking Function's to decide: it knows what the blob
 * is from its own manifest, and a blob is bytes here. Saying `application/octet-stream` keeps this
 * Worker out of that.
 */
const FOUND_HEADERS = { 'content-type': 'application/octet-stream', 'cache-control': IMMUTABLE };

export interface PrefetchEnv {
  /** The bundle blobs of every deployment, as the upload put them (`blobObjectKey`). */
  readonly ARTIFACTS: R2Bucket;
  /** Set to deny only after all retained Function bindings have been migrated and audited. */
  readonly PREFETCH_LEGACY_ACCESS?: string;
  /** Explicit audit window only: this Worker's actual service name. Unset disables all writes. */
  readonly PREFETCH_MIGRATION_AUDIT_SERVICE?: string;
}

function empty(status: number, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

/** Props are installed by the host, rather than supplied in the caller's Request. */
function permitted(props: unknown, sha256: string): boolean {
  if (typeof props !== 'object' || props === null) return false;
  const allowed: unknown = Reflect.get(props, 'allowedSha256');
  return (
    typeof allowed === 'object' &&
    allowed !== null &&
    Object.hasOwn(allowed, sha256) &&
    Reflect.get(allowed, sha256) === true
  );
}

/** Existing storage reads, after the strict entrypoint has checked its binding capability. */
async function answerBlob(
  request: Request,
  env: PrefetchEnv,
  props: unknown,
  legacy: boolean,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Named with the methods this Worker does answer, as a 405 is (RFC 9110, section 15.5.6).
    return empty(HTTP_METHOD_NOT_ALLOWED, { allow: 'GET, HEAD' });
  }
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(PREFETCH_BLOB_PATH)) {
    return empty(HTTP_NOT_FOUND);
  }
  const sha256 = pathname.slice(PREFETCH_BLOB_PATH.length);
  // Checked rather than passed through: `blobObjectKey` of anything else is a key into the same
  // bucket, and this Worker builds one key shape only.
  if (!SHA256.test(sha256)) {
    return empty(HTTP_NOT_FOUND);
  }
  if (!legacy && !permitted(props, sha256)) {
    return empty(HTTP_NOT_FOUND);
  }
  if (request.method === 'HEAD') {
    // Whether the blob is there, and no more: its object is looked at, and no body opened.
    const found = await env.ARTIFACTS.head(blobObjectKey(sha256));
    return found === null ? empty(HTTP_NOT_FOUND) : new Response(null, { headers: FOUND_HEADERS });
  }
  const stored = await env.ARTIFACTS.get(blobObjectKey(sha256));
  if (stored === null) {
    return empty(HTTP_NOT_FOUND);
  }
  return new Response(stored.body, { headers: FOUND_HEADERS });
}

/** A deployment's own accepted bundle, with no per-read authorization I/O or hashing. */
export class PrefetchForDeployment extends WorkerEntrypoint<PrefetchEnv, unknown> {
  override fetch(request: Request): Promise<Response> {
    const service = this.env.PREFETCH_MIGRATION_AUDIT_SERVICE;
    if (
      typeof service === 'string' &&
      service !== '' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      this.ctx.waitUntil(recordPrefetchAudit(this.env.ARTIFACTS, service, this.ctx.props));
    }
    return answerBlob(request, this.env, this.ctx.props, false);
  }
}

export default {
  fetch(request: Request, env: PrefetchEnv): Promise<Response> {
    // Temporary migration compatibility. This remains exposed to old unscoped bindings.
    const legacy =
      env.PREFETCH_LEGACY_ACCESS === undefined || env.PREFETCH_LEGACY_ACCESS === 'allow';
    return answerBlob(request, env, undefined, legacy);
  },
} satisfies ExportedHandler<PrefetchEnv>;
