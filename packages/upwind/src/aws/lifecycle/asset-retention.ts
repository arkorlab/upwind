import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

import { errorCode, mutation, type AwsContext } from './sdk.ts';
import { readJson, recordKey, type DeploymentRecord, type ProjectLock } from './state.ts';

const MANIFEST_PREFIX = 'static-manifests/';
const ORPHAN_GRACE_MS = 3_600_000;
const DEPLOYMENT_ID = /^[\w+~-]{1,256}$/u;

function manifestKey(deploymentId: string): string {
  if (!DEPLOYMENT_ID.test(deploymentId)) throw new Error('invalid AWS deployment identity');
  return `${MANIFEST_PREFIX}${deploymentId}.json`;
}

async function removeManifest(
  context: AwsContext,
  bucket: string,
  key: string,
  lock: ProjectLock,
  etag?: string,
): Promise<void> {
  await lock.assertHeld();
  try {
    await mutation(`delete retained static manifest ${key}`, () =>
      context.services.objects.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(etag === undefined ? {} : { IfMatch: etag }),
        }),
      ),
    );
  } catch (error) {
    if (errorCode(error) !== 'NoSuchKey' && errorCode(error) !== 'NotFound') throw error;
  }
}

/** Call only after the deployment is drained, retired and recorded as deleted under this lock. */
export function deleteStaticManifest(
  context: AwsContext,
  bucket: string,
  deploymentId: string,
  lock: ProjectLock,
): Promise<void> {
  // Immutable bytes remain addressable in S3; only future task hydration stops importing them.
  return removeManifest(context, bucket, manifestKey(deploymentId), lock);
}

/** Recover interrupted uploads before any new or resumed application task starts hydrating. */
export async function pruneOrphanStaticManifests(
  context: AwsContext,
  bucket: string,
  lock: ProjectLock,
): Promise<void> {
  let cursor: string | undefined;
  do {
    await lock.assertHeld();
    const page = await context.services.objects.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: MANIFEST_PREFIX,
        ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
      }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (key === undefined || !key.startsWith(MANIFEST_PREFIX) || !key.endsWith('.json')) continue;
      const deploymentId = key.slice(MANIFEST_PREFIX.length, -'.json'.length);
      if (!DEPLOYMENT_ID.test(deploymentId)) continue;
      const modified = object.LastModified?.getTime();
      // No age proof means no deletion; a recent upload can still be awaiting its staging record.
      if (
        modified === undefined ||
        !Number.isFinite(modified) ||
        context.now() - modified <= ORPHAN_GRACE_MS
      )
        continue;
      const stored = await readJson<DeploymentRecord>(context, bucket, recordKey(deploymentId));
      if (stored !== undefined) {
        if (
          stored.value.v !== 1 ||
          stored.value.deploymentId !== deploymentId ||
          stored.value.compute !== 'fargate'
        )
          throw new Error('retained static manifest has an invalid deployment record');
        // Keep live, rollback and staging candidates, including an interrupted deploy's record.
        if (stored.value.status !== 'deleted') continue;
      }
      if (object.ETag === undefined)
        throw new Error('orphan static manifest has no version for conditional deletion');
      await removeManifest(context, bucket, key, lock, object.ETag);
    }
    cursor = page.NextContinuationToken;
    if (page.IsTruncated === true && cursor === undefined)
      throw new Error('static manifest listing omitted its continuation');
  } while (cursor !== undefined);
}
