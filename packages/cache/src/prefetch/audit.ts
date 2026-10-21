import {
  prefetchAuditIdentity,
  prefetchAuditKey,
  type PrefetchAuditWitness,
  PREFETCH_DEPLOYMENT_ENTRYPOINT,
} from '@stayingupwind/host/prefetch-audit';

interface PendingAudit {
  readonly nonce: string;
  readonly expiresAt: number;
}

const PENDING_MS = 10_000;
// Retain only bounded data; another request must never await this request's I/O Promise.
const written: { nonce: string; pending: PendingAudit | undefined } = {
  nonce: '',
  pending: undefined,
};

/** Missing evidence blocks the operator audit; a failed write never blocks a blob response. */
export async function recordPrefetchAudit(
  bucket: R2Bucket,
  service: string,
  props: unknown,
): Promise<void> {
  let pending: PendingAudit | undefined;
  try {
    if (typeof props !== 'object' || props === null) return;
    const identity = prefetchAuditIdentity(Reflect.get(props, 'migrationAudit'));
    if (identity === undefined || identity.nonce === written.nonce) return;
    const now = Date.now();
    if (written.pending?.nonce === identity.nonce && written.pending.expiresAt > now) return;
    pending = { nonce: identity.nonce, expiresAt: now + PENDING_MS };
    written.pending = pending;
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
  } finally {
    // Expired work must not clear the marker belonging to a newer attempt.
    if (pending !== undefined && written.pending === pending) written.pending = undefined;
  }
}
