import {
  prefetchAuditIdentity,
  prefetchAuditKey,
  type PrefetchAuditWitness,
  PREFETCH_DEPLOYMENT_ENTRYPOINT,
} from '@stayingupwind/host/prefetch-audit';

// One settled nonce only: never retain another request's I/O Promise or an unbounded map.
const written = { nonce: '' };

/** Missing evidence blocks the operator audit; a failed write never blocks a blob response. */
export async function recordPrefetchAudit(
  bucket: R2Bucket,
  service: string,
  props: unknown,
): Promise<void> {
  try {
    if (typeof props !== 'object' || props === null) return;
    const identity = prefetchAuditIdentity(Reflect.get(props, 'migrationAudit'));
    if (identity === undefined || identity.nonce === written.nonce) return;
    const witness: PrefetchAuditWitness = {
      version: 1,
      ...identity,
      service,
      entrypoint: PREFETCH_DEPLOYMENT_ENTRYPOINT,
      allowedSha256: Reflect.get(props, 'allowedSha256'),
    };
    await bucket.put(prefetchAuditKey(identity.nonce), JSON.stringify(witness), {
      httpMetadata: { contentType: 'application/json' },
    });
    written.nonce = identity.nonce;
  } catch {
    // waitUntil can fail or expire. Leave this nonce retryable; no evidence means unverified.
  }
}
