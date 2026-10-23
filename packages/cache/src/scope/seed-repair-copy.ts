import { copyRepairBlob } from './repair-upload.ts';
import type { SeedLocationCheck } from './seed-repair.ts';

/** Instantiated only for an existing repair verification; no nonce is made for ordinary reads. */
export function seedRepairCopier(
  bucket: Pick<R2Bucket, 'get' | 'put' | 'head'>,
  owner: { readonly namespace: string | undefined; readonly scopeOwner: string },
): (location: SeedLocationCheck, signal: AbortSignal) => Promise<string | undefined> {
  let attemptId: string | undefined;
  return (location, signal) => {
    if (owner.namespace === undefined) return Promise.resolve(undefined);
    attemptId ??= crypto.randomUUID();
    return copyRepairBlob(
      bucket,
      location,
      {
        namespace: owner.namespace,
        scopeOwner: owner.scopeOwner,
        attemptId,
      },
      signal,
    );
  };
}
