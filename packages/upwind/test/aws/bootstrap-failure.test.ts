import { describe, expect, it } from 'vitest';

import { existingBootstrap } from '../../src/aws/lifecycle/bootstrap.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';

describe('an owned failed AWS bootstrap', () => {
  it.each(['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'CREATE_FAILED', 'DELETE_FAILED'])(
    'reports the stack and recovery command for %s before validating outputs',
    async (status) => {
      const context: AwsContext = {
        services: {
          stacks: {
            send: async () => ({
              Stacks: [
                {
                  StackName: 'upwind-shop',
                  StackStatus: status,
                  Tags: [{ Key: 'upwind:project', Value: 'shop' }],
                  Outputs: [],
                },
              ],
            }),
          },
        } as unknown as AwsServices,
        fetch,
        now: Date.now,
        sleep: async () => undefined,
      };
      await expect(existingBootstrap(context, 'shop')).rejects.toThrow(
        `AWS bootstrap stack upwind-shop is ${status}`,
      );
      await expect(existingBootstrap(context, 'shop')).rejects.toThrow('upwind destroy --yes');
    },
  );
});
