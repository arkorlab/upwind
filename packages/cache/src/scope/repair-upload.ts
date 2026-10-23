import { createRepairStorageRef } from '@stayingupwind/core/cache';
import { releaseStream } from '@stayingupwind/core/util';

/** The provider, rather than a key's spelling or caller metadata, proves the stored bytes. */
export interface RepairUploadProof {
  readonly namespace: string;
  /** Cloudflare's existing fixed-width Durable Object ID, never a caller's scope name. */
  readonly scopeOwner?: string | undefined;
  readonly attemptId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Fixed-size server-owned provenance; no user-supplied scope name enters R2 metadata. */
export function repairUploadMetadata(proof: RepairUploadProof): Record<string, string> {
  if (proof.scopeOwner === undefined || !/^[0-9a-f]{64}$/u.test(proof.scopeOwner))
    throw new Error('a repair needs its scope owner');
  return {
    upwindRepair: '1',
    upwindRepairOwner: proof.scopeOwner,
    upwindRepairNamespace: proof.namespace,
    upwindRepairAttempt: proof.attemptId,
  };
}

const HEX_RADIX = 16;

/** A positive receipt for this reservation; a missing object never proves a prior PUT settled. */
export function repairUploadMatches(
  object: Pick<R2Object, 'size' | 'checksums' | 'customMetadata'> | null,
  proof: RepairUploadProof,
): boolean {
  const digest = object?.checksums.sha256;
  if (object === null || digest === undefined || object.size !== proof.byteLength) return false;
  const metadata = object.customMetadata;
  if (
    proof.scopeOwner === undefined ||
    metadata?.['upwindRepair'] !== '1' ||
    metadata['upwindRepairOwner'] !== proof.scopeOwner ||
    metadata['upwindRepairNamespace'] !== proof.namespace ||
    metadata['upwindRepairAttempt'] !== proof.attemptId
  )
    return false;
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, '0'))
    .join('');
  return hex === proof.sha256;
}

export interface RepairBlobLocation {
  readonly storageRef: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType?: string | undefined;
}

export type RepairCopyOwner = Pick<RepairUploadProof, 'namespace' | 'attemptId' | 'scopeOwner'>;

interface RepairCopyWrite {
  readonly proof: RepairUploadProof;
  readonly metadata: Record<string, string>;
  readonly location: RepairBlobLocation;
  readonly signal: AbortSignal | undefined;
}

/** The same conditional write and positive-receipt checks for one fresh copy candidate. */
async function writeRepairCopy(
  bucket: Pick<R2Bucket, 'put' | 'head'>,
  storageRef: string,
  body: ReadableStream,
  write: RepairCopyWrite,
): Promise<boolean> {
  const { proof, metadata, location, signal } = write;
  const written = await bucket.put(storageRef, body, {
    sha256: proof.sha256,
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    customMetadata: metadata,
    httpMetadata: { contentType: location.contentType ?? 'application/octet-stream' },
  });
  signal?.throwIfAborted();
  if (written !== null) {
    if (!repairUploadMatches(written, proof)) throw new Error('unverified repair copy receipt');
    return true;
  }
  return repairUploadMatches(await bucket.head(storageRef), proof);
}

/**
 * Only a failed location's repair pays for this streamed copy. R2 validates the expected checksum
 * while writing, so an untrusted or concurrently replaced source cannot become a healthy repair.
 * The source is never overwritten. An unknown PUT outcome throws; its unused key remains under
 * the scope's ownership-aware orphan sweep, and is never reused as proof by a negative HEAD.
 */
export async function copyRepairBlob(
  bucket: Pick<R2Bucket, 'get' | 'put' | 'head'>,
  location: RepairBlobLocation,
  owner: RepairCopyOwner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const proof = { ...owner, sha256: location.sha256, byteLength: location.byteLength };
  const metadata = repairUploadMetadata(proof);
  const write: RepairCopyWrite = { proof, metadata, location, signal };
  for (;;) {
    signal?.throwIfAborted();
    const storageRef = createRepairStorageRef(owner.namespace);
    const object = await bucket.get(location.storageRef);
    if (object === null) return undefined;
    if (object.size !== location.byteLength || signal?.aborted === true) {
      releaseStream(object.body);
      signal?.throwIfAborted();
      return undefined;
    }
    const abort = (): void => {
      releaseStream(object.body);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const copied = await writeRepairCopy(bucket, storageRef, object.body, write);
      if (copied) return storageRef;
      // A definitive failed precondition found someone else's object. Keep it and choose a nonce.
    } catch (error) {
      // Workers exposes the provider code at the end of the message. Only a definitive content
      // mismatch is a bad candidate; outages and unknown write outcomes remain failures to retry.
      // https://developers.cloudflare.com/r2/api/error-codes/
      if (error instanceof Error && error.message.endsWith('(10037)')) return undefined;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      releaseStream(object.body);
    }
  }
}
