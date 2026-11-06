import { BatchDeleteImageCommand, ListImagesCommand } from '@aws-sdk/client-ecr';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';

import type { DestroyOptions } from '../../deploy/args.ts';
import type { DeploySettings } from '../../deploy/config.ts';
import type { AwsCredentials } from '../credentials.ts';
import { existingBootstrap } from './bootstrap.ts';
import { say, settingsOf, stateOf } from './operations.ts';
import { removeProduction } from './routes.ts';
import { awsContext, errorCode, mutation, type AwsContext, type AwsLifecycleIo } from './sdk.ts';
import { deleteProjectSecrets, deleteSecret } from './secrets.ts';
import { bootstrapName, deleteStack, deploymentStackName, stack } from './stacks.ts';
import {
  LOCK_KEY,
  readJson,
  records,
  STATE_KEY,
  withProjectLock,
  writeJson,
  type ProjectState,
} from './state.ts';

async function verifyBucket(context: AwsContext, bucket: string, project: string): Promise<void> {
  const tags = await context.services.objects.send(new GetBucketTaggingCommand({ Bucket: bucket }));
  if (!tags.TagSet?.some((tag) => tag.Key === 'upwind:project' && tag.Value === project))
    throw new Error(`refusing to empty bucket ${bucket}: project ownership does not match`);
}

async function emptyBucket(
  context: AwsContext,
  bucket: string,
  preserveLock: boolean,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await context.services.objects.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
      }),
    );
    const keys = (page.Contents ?? []).flatMap((object) =>
      object.Key === undefined || (preserveLock && object.Key === LOCK_KEY)
        ? []
        : [{ Key: object.Key }],
    );
    if (keys.length > 0) {
      const removed = await mutation('empty project artifacts bucket', () =>
        context.services.objects.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
        ),
      );
      if ((removed.Errors?.length ?? 0) > 0)
        throw new Error(`some objects in AWS bucket ${bucket} could not be deleted`);
    }
    cursor = page.NextContinuationToken;
  } while (cursor !== undefined);
}

async function emptyImages(context: AwsContext, repository: string): Promise<void> {
  let cursor: string | undefined;
  try {
    do {
      const page = await context.services.ecr.send(
        new ListImagesCommand({
          repositoryName: repository,
          ...(cursor === undefined ? {} : { nextToken: cursor }),
        }),
      );
      const imageIds = page.imageIds ?? [];
      if (imageIds.length > 0) {
        const removed = await mutation('empty project image repository', () =>
          context.services.ecr.send(
            new BatchDeleteImageCommand({ repositoryName: repository, imageIds }),
          ),
        );
        if ((removed.failures?.length ?? 0) > 0)
          throw new Error('some project images could not be deleted');
      }
      cursor = page.nextToken;
    } while (cursor !== undefined);
  } catch (error) {
    if (errorCode(error) !== 'RepositoryNotFoundException') throw error;
  }
}

/** A previous destroy may have deleted its stack before the final retained bucket deletion. */
async function deleteRetainedBuckets(
  context: AwsContext,
  project: string,
  region: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await context.services.objects.send(
      new ListBucketsCommand({
        Prefix: `upwind-${project}-artifacts-`,
        BucketRegion: region,
        MaxBuckets: 1000,
        ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
      }),
    );
    for (const candidate of page.Buckets ?? []) {
      const bucket = candidate.Name;
      if (bucket === undefined) continue;
      const tagged = await context.services.objects.send(
        new GetBucketTaggingCommand({ Bucket: bucket }),
      );
      if (!tagged.TagSet?.some((tag) => tag.Key === 'upwind:project' && tag.Value === project))
        continue;
      const owner = tagged.TagSet.find((tag) => tag.Key === 'aws:cloudformation:stack-id')?.Value;
      if (owner === undefined)
        throw new Error(
          `retained bucket ${bucket} has no CloudFormation ownership tag; inspect it before removing it`,
        );
      const owningStack = await stack(context, owner);
      if (owningStack !== undefined && owningStack.StackStatus !== 'DELETE_COMPLETE')
        throw new Error(
          `retained bucket ${bucket} still belongs to an existing stack; retry destroy after it settles`,
        );
      await withProjectLock(
        context,
        bucket,
        async () => {
          await emptyBucket(context, bucket, true);
        },
        true,
      );
      await context.services.objects.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    cursor = page.ContinuationToken;
  } while (cursor !== undefined);
}

export async function runAwsDestroy(
  options: DestroyOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io: AwsLifecycleIo = {},
): Promise<number> {
  if (!options.yes)
    throw new Error('upwind destroy deletes all managed AWS resources and data; pass --yes');
  const aws = settingsOf(settings);
  const context = awsContext(aws.region, credentials, io);
  const bootstrap = await existingBootstrap(context, settings.project);
  if (bootstrap === undefined) {
    await deleteRetainedBuckets(context, settings.project, aws.region);
    say(`${settings.project} has no remaining managed AWS deployment`);
    return 0;
  }
  const bucket = bootstrap.ArtifactsBucket;
  await verifyBucket(context, bucket, settings.project);
  try {
    await withProjectLock(
      context,
      bucket,
      async (lock) => {
        const old = await readJson<ProjectState>(context, bucket, STATE_KEY);
        await writeJson(
          context,
          bucket,
          STATE_KEY,
          { ...(old?.value ?? { v: 1 }), destroying: true },
          old?.etag,
        );
        await removeProduction(context, bootstrap.ListenerArn, settings.project, lock);
        for (const record of await records(context, bucket)) {
          if (record.stackName !== deploymentStackName(settings.project, record.deploymentId))
            throw new Error('refusing to delete a stack with a mismatched deployment identity');
          await lock.assertHeld();
          await deleteStack(context, settings.project, record.stackName);
          if (record.secretArn !== undefined)
            await deleteSecret(context, settings.project, record.secretArn);
        }
        await deleteProjectSecrets(context, settings.project);
        await emptyImages(context, bootstrap.RepositoryName);
        await lock.assertHeld();
        // The bucket is intentionally retained by CloudFormation only for this locked interval.
        // The explicit deletion below is part of destroy, never an optional retained resource.
        await deleteStack(context, settings.project, bootstrapName(settings.project));
        await verifyBucket(context, bucket, settings.project);
        await emptyBucket(context, bucket, true);
      },
      true,
    );
    await context.services.objects.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const state = await stateOf(context, bucket).catch(() => undefined);
    throw new Error(
      `AWS destroy is incomplete; inspect stack ${bootstrapName(settings.project)} and bucket ${bucket}${state === undefined ? '' : ' (project marked for destruction)'}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  say(`deleted all managed AWS resources for ${settings.project}`);
  return 0;
}
