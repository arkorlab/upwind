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
const MAX_TRACKED_AUDITS = 128;
// Retain only bounded data; another request must never await this request's I/O Promise.
const audits = new Map<string, PendingAudit | true>();

function track(pending: PendingAudit): void {
  audits.delete(pending.nonce);
  audits.set(pending.nonce, pending);
  if (audits.size > MAX_TRACKED_AUDITS) {
    const oldest = audits.keys().next().value;
    if (oldest !== undefined) audits.delete(oldest);
  }
}

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
    if (identity === undefined) return;
    const previous = audits.get(identity.nonce);
    if (previous === true) return;
    const now = Date.now();
    if (previous !== undefined && previous.expiresAt > now) return;
    pending = { nonce: identity.nonce, expiresAt: now + PENDING_MS };
    track(pending);
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
    if (audits.get(identity.nonce) === pending) audits.set(identity.nonce, true);
  } catch {
    // waitUntil can fail or expire. Leave this nonce retryable; no evidence means unverified.
  } finally {
    // Expired work must not clear the marker belonging to a newer attempt.
    if (pending !== undefined && audits.get(pending.nonce) === pending) {
      audits.delete(pending.nonce);
    }
  }
}
