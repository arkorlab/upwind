import { describe, expect, it } from 'vitest';

import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { createStack } from '../../src/aws/lifecycle/stacks.ts';

describe('reusing an existing AWS stack', () => {
  it.each([
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'CREATE_FAILED',
    'DELETE_FAILED',
    'UPDATE_ROLLBACK_COMPLETE',
  ])('rejects the failed terminal state %s with recovery instructions', async (status) => {
    const context: AwsContext = {
      services: {
        stacks: {
          send: async () => ({
            Stacks: [
              {
                StackName: 'upwind-shop-retire',
                StackStatus: status,
                Tags: [{ Key: 'upwind:project', Value: 'shop' }],
              },
            ],
          }),
        },
      } as unknown as AwsServices,
      fetch,
      now: Date.now,
      sleep: async () => undefined,
    };
    await expect(createStack(context, 'shop', 'upwind-shop-retire', '{}')).rejects.toThrow(
      `upwind-shop-retire is ${status}`,
    );
    await expect(createStack(context, 'shop', 'upwind-shop-retire', '{}')).rejects.toThrow(
      'upwind destroy --yes',
    );
  });
});
