import { describe, expect, it } from 'vitest';

import { verifyCacheDurability } from '../../src/aws/lifecycle/bootstrap.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import type { AwsBootstrapOutputs } from '../../src/aws/types.ts';

function context(effective: string | undefined): AwsContext {
  return {
    services: {
      cache: {
        send: async () => ({
          ReplicationGroups: [{ ReplicationGroupId: 'cache', EffectiveDurability: effective }],
        }),
      },
    } as unknown as AwsServices,
    fetch,
    now: Date.now,
    sleep: async () => undefined,
  };
}

describe('AWS Valkey effective durability', () => {
  it('accepts only the actual synchronous service guarantee', async () => {
    await expect(
      verifyCacheDurability(context('sync'), {
        ValkeyReplicationGroupId: 'cache',
      } as AwsBootstrapOutputs),
    ).resolves.toBeUndefined();
    for (const effective of ['async', 'disabled', undefined]) {
      await expect(
        verifyCacheDurability(context(effective), {
          ValkeyReplicationGroupId: 'cache',
        } as AwsBootstrapOutputs),
      ).rejects.toThrow('EffectiveDurability=sync');
    }
  });

  it('refuses a Valkey project with no replication-group identity', async () => {
    await expect(verifyCacheDurability(context('sync'), {} as AwsBootstrapOutputs)).rejects.toThrow(
      'replication group identity',
    );
  });
});
