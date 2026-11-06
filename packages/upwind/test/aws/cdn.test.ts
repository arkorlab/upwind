import { GetTemplateCommand, UpdateStackCommand } from '@aws-sdk/client-cloudformation';
import { CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { describe, expect, it } from 'vitest';

import { configureStaticBypass } from '../../src/aws/lifecycle/cdn.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { staticCacheBehaviors } from '../../src/aws/templates.ts';
import type { AwsBootstrapOutputs } from '../../src/aws/types.ts';

function fixture(enabled: boolean) {
  const calls: string[] = [];
  let now = 0;
  let polls = 0;
  const template = {
    Resources: {
      Distribution: {
        Properties: {
          DistributionConfig: { CacheBehaviors: enabled ? staticCacheBehaviors() : [] },
        },
      },
    },
  };
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof GetTemplateCommand) {
      calls.push('template');
      return { TemplateBody: JSON.stringify(template) };
    }
    if (command instanceof UpdateStackCommand) {
      calls.push('update');
      const changed = JSON.parse(command.input.TemplateBody ?? '{}') as typeof template;
      template.Resources.Distribution.Properties.DistributionConfig.CacheBehaviors =
        changed.Resources.Distribution.Properties.DistributionConfig.CacheBehaviors;
      return {};
    }
    if (command instanceof CreateInvalidationCommand) {
      calls.push('invalidate');
      return { Invalidation: { Id: 'clear' } };
    }
    if (command instanceof GetInvalidationCommand) {
      calls.push('poll');
      return { Invalidation: { Status: ++polls < 2 ? 'InProgress' : 'Completed' } };
    }
    return {
      Stacks: [
        {
          StackName: 'upwind-shop',
          StackStatus: 'UPDATE_COMPLETE',
          Tags: [{ Key: 'upwind:project', Value: 'shop' }],
        },
      ],
    };
  };
  const context: AwsContext = {
    services: { stacks: { send }, cdn: { send } } as unknown as AwsServices,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    fetch,
  };
  return { context, calls, template };
}

describe('deployment-scoped CloudFront static bypass', () => {
  it('disables the old bypass and waits for invalidation before returning to activation', async () => {
    const value = fixture(true);
    await configureStaticBypass(
      value.context,
      'shop',
      { DistributionId: 'distribution' } as AwsBootstrapOutputs,
      false,
      { assertHeld: async () => undefined },
    );
    expect(
      value.template.Resources.Distribution.Properties.DistributionConfig.CacheBehaviors,
    ).toStrictEqual([]);
    expect(value.calls).toStrictEqual(['template', 'update', 'invalidate', 'poll', 'poll']);
  });

  it('still clears an interrupted transition whose template already disables bypass', async () => {
    const value = fixture(false);
    await configureStaticBypass(
      value.context,
      'shop',
      { DistributionId: 'distribution' } as AwsBootstrapOutputs,
      false,
      { assertHeld: async () => undefined },
    );
    expect(value.calls).toStrictEqual(['template', 'invalidate', 'poll', 'poll']);
  });

  it('enables the verified behavior without clearing immutable content', async () => {
    const value = fixture(false);
    await configureStaticBypass(
      value.context,
      'shop',
      { DistributionId: 'distribution' } as AwsBootstrapOutputs,
      true,
      { assertHeld: async () => undefined },
    );
    expect(
      value.template.Resources.Distribution.Properties.DistributionConfig.CacheBehaviors,
    ).toStrictEqual(staticCacheBehaviors());
    expect(value.calls).toStrictEqual(['template', 'update']);
  });
});
