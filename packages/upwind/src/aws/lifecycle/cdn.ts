import { GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront';

import { staticCacheBehaviors } from '../templates.ts';
import type { AwsBootstrapOutputs } from '../types.ts';
import { mutation, type AwsContext, UncertainAwsMutation } from './sdk.ts';
import { bootstrapName, updateStack } from './stacks.ts';
import type { ProjectLock } from './state.ts';

/** CDN bypass is a deployment proof, never a permanent property of a project. */
export async function configureStaticBypass(
  context: AwsContext,
  project: string,
  bootstrap: AwsBootstrapOutputs,
  enabled: boolean,
  lock: ProjectLock,
): Promise<void> {
  const distribution = bootstrap.DistributionId;
  if (distribution === undefined) return;
  await lock.assertHeld();
  const response = await context.services.stacks.send(
    new GetTemplateCommand({ StackName: bootstrapName(project), TemplateStage: 'Original' }),
  );
  if (response.TemplateBody === undefined)
    throw new Error('CloudFormation returned no bootstrap template');
  const template = JSON.parse(response.TemplateBody) as {
    Resources?: Record<
      string,
      { Properties?: { DistributionConfig?: { CacheBehaviors?: unknown[] } } }
    >;
  };
  const configuration = template.Resources?.['Distribution']?.Properties?.DistributionConfig;
  if (configuration === undefined)
    throw new Error('the AWS project template has no managed CloudFront distribution');
  const actual = configuration.CacheBehaviors ?? [];
  const desired = enabled ? staticCacheBehaviors() : [];
  if (JSON.stringify(actual) !== JSON.stringify(desired)) {
    configuration.CacheBehaviors = [...desired];
    await lock.assertHeld();
    await updateStack(context, project, bootstrapName(project), JSON.stringify(template));
  }
  if (enabled) return;
  // Repeat clearing even when the template already disables bypass: an interrupted previous
  // operation may have updated the distribution before it submitted its invalidation.
  const invalidated = await mutation('clear previous CloudFront static behavior', () =>
    context.services.cdn.send(
      new CreateInvalidationCommand({
        DistributionId: distribution,
        InvalidationBatch: {
          CallerReference: `upwind-${crypto.randomUUID()}`,
          Paths: { Quantity: 1, Items: ['/_next/static/*'] },
        },
      }),
    ),
  );
  const id = invalidated.Invalidation?.Id;
  if (id === undefined)
    throw new UncertainAwsMutation('CloudFront returned no invalidation ID', undefined);
  const deadline = context.now() + 900_000;
  while (context.now() < deadline) {
    const result = await context.services.cdn
      .send(new GetInvalidationCommand({ DistributionId: distribution, Id: id }))
      .catch((error: unknown) => {
        throw new UncertainAwsMutation(
          `CloudFront invalidation ${id} could not be observed`,
          error,
        );
      });
    if (result.Invalidation?.Status === 'Completed') return;
    await context.sleep(5000);
  }
  throw new UncertainAwsMutation(`CloudFront invalidation ${id} is still running`, undefined);
}
