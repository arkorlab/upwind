import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import type { AwsDeploySettings } from '../types.ts';
import { errorCode, mutation, type AwsContext, UncertainAwsMutation } from './sdk.ts';

export interface DeploymentRecord {
  readonly v: 1;
  readonly compute: 'fargate';
  readonly deploymentId: string;
  readonly stackName: string;
  readonly createdAt: string;
  readonly image: string;
  readonly imageTag: string;
  readonly archiveSha256: string;
  readonly safeStaticBypass?: boolean;
  readonly template: string;
  readonly probeToken: string;
  readonly probePriority: number;
  readonly settings: AwsDeploySettings;
  readonly secretArn?: string;
  readonly message?: string;
  readonly publicOrigin: string;
  readonly targetGroupArn?: string;
  readonly taskDefinitionArn?: string;
  /** Persisted before deleting compute; retries must not invoke a deregistered task definition. */
  readonly cacheRetired?: boolean;
  readonly lastServed?: string;
  readonly status: 'staging' | 'live' | 'kept' | 'deleted';
}

export interface ProjectState {
  readonly v: 1;
  readonly current?: string;
  readonly productionRuleArn?: string;
  readonly destroying?: boolean;
}

export interface Stored<T> {
  readonly value: T;
  readonly etag: string;
}
export const STATE_KEY = 'upwind/control.json';
export const LOCK_KEY = 'upwind/project-lock.json';
const RECORD_PREFIX = 'upwind/deployments/';

export async function readJson<T>(
  context: AwsContext,
  bucket: string,
  key: string,
): Promise<Stored<T> | undefined> {
  try {
    const object = await context.services.objects.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (object.Body === undefined || object.ETag === undefined)
      throw new Error(`AWS object ${key} has no body or version`);
    return { value: JSON.parse(await object.Body.transformToString()) as T, etag: object.ETag };
  } catch (error) {
    if (errorCode(error) === 'NoSuchKey' || errorCode(error) === 'NotFound') return undefined;
    throw error;
  }
}

export async function writeJson(
  context: AwsContext,
  bucket: string,
  key: string,
  value: unknown,
  etag?: string,
): Promise<string> {
  const written = await mutation(`write ${key}`, () =>
    context.services.objects.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json',
        ...(etag === undefined ? { IfNoneMatch: '*' } : { IfMatch: etag }),
      }),
    ),
  );
  if (written.ETag === undefined)
    throw new UncertainAwsMutation(`write ${key} returned no version`, undefined);
  return written.ETag;
}

export function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}.json`;
}

export async function records(context: AwsContext, bucket: string): Promise<DeploymentRecord[]> {
  const found: DeploymentRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.services.objects.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: RECORD_PREFIX,
        ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key === undefined) continue;
      const stored = await readJson<DeploymentRecord>(context, bucket, object.Key);
      if (stored !== undefined) {
        if (stored.value.compute !== 'fargate')
          throw new Error(
            `deployment ${stored.value.deploymentId} belongs to another AWS compute driver`,
          );
        found.push(stored.value);
      }
    }
    cursor = page.NextContinuationToken;
  } while (cursor !== undefined);
  return found;
}

export async function saveRecord(
  context: AwsContext,
  bucket: string,
  record: DeploymentRecord,
): Promise<void> {
  const key = recordKey(record.deploymentId);
  const previous = await readJson<DeploymentRecord>(context, bucket, key);
  await writeJson(context, bucket, key, record, previous?.etag);
}

export interface ProjectLock {
  assertHeld(): Promise<void>;
}

/** No timed takeover: a crashed deploy can leave a CloudFormation operation still running. */
export async function withProjectLock<T>(
  context: AwsContext,
  bucket: string,
  run: (lock: ProjectLock) => Promise<T>,
  allowDestroying = false,
): Promise<T> {
  const control = await readJson<ProjectState>(context, bucket, STATE_KEY);
  if (control?.value.destroying && !allowDestroying)
    throw new Error('this AWS project is being destroyed; finish destroy before deploying again');
  const owner = randomUUID();
  let etag: string;
  try {
    etag = await writeJson(context, bucket, LOCK_KEY, {
      owner,
      startedAt: new Date(context.now()).toISOString(),
    });
  } catch (error) {
    if (
      errorCode(error) === 'PreconditionFailed' ||
      errorCode(error) === 'ConditionalRequestConflict'
    ) {
      throw new Error(
        `another operation owns s3://${bucket}/${LOCK_KEY}; after confirming every operation and pending AWS mutation has stopped, remove that object to recover`,
      );
    }
    throw error;
  }
  let uncertain = false;
  try {
    const current = await readJson<ProjectState>(context, bucket, STATE_KEY);
    if (current?.value.destroying && !allowDestroying)
      throw new Error('this AWS project is being destroyed');
    return await run({
      assertHeld: async () => {
        const held = await readJson<{ owner: string }>(context, bucket, LOCK_KEY);
        if (held?.etag !== etag || held.value.owner !== owner)
          throw new Error('the AWS project lock changed; refusing further mutations');
      },
    });
  } catch (error) {
    uncertain = error instanceof UncertainAwsMutation;
    throw error;
  } finally {
    if (uncertain) {
      console.error(
        `upwind: retained s3://${bucket}/${LOCK_KEY}; confirm the AWS mutation has settled before manual recovery`,
      );
    } else {
      await context.services.objects.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: LOCK_KEY, IfMatch: etag }),
      );
    }
  }
}
