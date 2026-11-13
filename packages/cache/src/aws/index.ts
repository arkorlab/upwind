import { isSignableScopeId } from '@stayingupwind/host/cache';

import { AwsAuthority } from './authority.ts';
import { DynamoAuthorityStore } from './dynamodb.ts';
import { S3Objects } from './objects.ts';
import type { AuthorityStore, AwsCache, AwsCacheOptions } from './types.ts';
import { ValkeyAuthorityStore } from './valkey.ts';

export type { AwsCache, AwsCacheOptions } from './types.ts';

/** Open the deployment's shared authority before the native server becomes ready. */
async function openAuthority(options: AwsCacheOptions): Promise<AwsAuthority> {
  if (!isSignableScopeId(options.scopeId) || options.scopeId.length > 256)
    throw new Error('AWS cache requires a valid immutable scope identity');
  if (
    options.bucket === '' ||
    options.region === '' ||
    options.buildId === '' ||
    options.deploymentId !== options.scopeId
  )
    throw new Error(
      'AWS cache requires its region, bucket, build and matching deployment identity',
    );
  let store: AuthorityStore;
  if (options.backend === 'valkey') {
    if (options.valkeyUrl === undefined) throw new Error('AWS Valkey cache has no endpoint');
    const valkey = new ValkeyAuthorityStore(
      options.valkeyUrl,
      options.scopeId,
      options.valkeyUsername,
      options.valkeyPassword,
    );
    await valkey.connect();
    store = valkey;
  } else {
    if (options.table === undefined || options.table === '')
      throw new Error('AWS DynamoDB cache has no table');
    store = new DynamoAuthorityStore(options.region, options.table, options.scopeId);
  }
  const objects = new S3Objects(options.region, options.bucket, options.scopeId);
  return new AwsAuthority(options, store, objects);
}

export async function createAwsCache(options: AwsCacheOptions): Promise<AwsCache> {
  const authority = await openAuthority(options);
  try {
    await authority.initialize();
  } catch (error) {
    await authority.close();
    throw error;
  }
  return {
    binding: { host: authority, scopeId: options.scopeId, clockOf: (): undefined => undefined },
    readScopeRevision: () => authority.readScopeRevision(),
    close: () => authority.close(),
  };
}

/** One-off ECS job, using the same private network and scoped task permissions as the app. */
export async function retireAwsCache(options: AwsCacheOptions): Promise<void> {
  const authority = await openAuthority(options);
  try {
    await authority.retire();
  } finally {
    await authority.close();
  }
}
