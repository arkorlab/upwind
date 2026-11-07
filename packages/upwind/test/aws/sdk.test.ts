import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  ModifyRuleCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { checkDeployment } from '../../src/aws/lifecycle/routes.ts';
import { awsContext } from '../../src/aws/lifecycle/sdk.ts';
import { stack } from '../../src/aws/lifecycle/stacks.ts';

function failure(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });
}

function fixture() {
  const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
  const context = awsContext('us-east-1', undefined, { sleep });
  const { stacks, loadBalancer, cdn, objects } = context.services;
  if (
    !(stacks instanceof CloudFormationClient) ||
    !(loadBalancer instanceof ElasticLoadBalancingV2Client) ||
    !(cdn instanceof CloudFrontClient) ||
    !(objects instanceof S3Client)
  )
    throw new Error('The retry tests require production AWS SDK clients');
  return { context, sleep, stacks, loadBalancer, cdn, objects };
}

function respond(
  client: CloudFormationClient | ElasticLoadBalancingV2Client | CloudFrontClient | S3Client,
  run: () => Record<string, unknown>,
): void {
  // Stop before serialization/auth/network, inside the real production retry middleware.
  client.middlewareStack.add(
    () => async () => ({ response: {}, output: { $metadata: {}, ...run() } }),
    { step: 'initialize', priority: 'low', name: 'testResponse' },
  );
}

describe('AWS lifecycle read retries', () => {
  it('recovers a transient stack observation without treating the mutation as uncertain', async () => {
    const value = fixture();
    const response = vi
      .fn<() => Record<string, unknown>>()
      .mockImplementationOnce(() => {
        throw failure('ServiceUnavailable', 503);
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      })
      .mockReturnValue({ Stacks: [{ StackName: 'project', StackStatus: 'UPDATE_COMPLETE' }] });
    respond(value.stacks, response);
    await expect(stack(value.context, 'project')).resolves.toMatchObject({
      StackName: 'project',
      StackStatus: 'UPDATE_COMPLETE',
    });
    expect(response).toHaveBeenCalledTimes(3);
    expect(value.sleep).toHaveBeenCalledTimes(2);
    expect(value.sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0);
    expect(value.sleep.mock.calls[0]?.[0]).toBeLessThan(100);
    expect(value.sleep.mock.calls[1]?.[0]).toBeGreaterThanOrEqual(0);
    expect(value.sleep.mock.calls[1]?.[0]).toBeLessThan(200);
  });

  it('retries throttled target health before candidate readiness can fail', async () => {
    const value = fixture();
    const response = vi
      .fn<() => Record<string, unknown>>()
      .mockImplementationOnce(() => {
        throw failure('ThrottlingException', 429);
      })
      .mockReturnValue({
        TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }],
      });
    respond(value.loadBalancer, response);
    await expect(
      checkDeployment(
        {
          ...value.context,
          fetch: vi.fn<typeof fetch>(async () =>
            Response.json({ ready: true, deploymentId: 'candidate' }),
          ),
        },
        {
          target: 'target',
          tasks: 1,
          origin: 'https://app.example',
          deploymentId: 'candidate',
          checks: [],
        },
      ),
    ).resolves.toBeUndefined();
    expect(response).toHaveBeenCalledTimes(2);
    expect(value.sleep).toHaveBeenCalledTimes(1);
    expect(value.sleep.mock.calls[0]?.[0]).toBeLessThan(1000);
  });

  it('retries CloudFront invalidation observations', async () => {
    const value = fixture();
    const response = vi
      .fn<() => Record<string, unknown>>()
      .mockImplementationOnce(() => {
        throw failure('InternalError', 500);
      })
      .mockReturnValue({ Invalidation: { Id: 'invalidation', Status: 'Completed' } });
    respond(value.cdn, response);
    await expect(
      value.cdn.send(
        new GetInvalidationCommand({ DistributionId: 'distribution', Id: 'invalidation' }),
      ),
    ).resolves.toMatchObject({ Invalidation: { Status: 'Completed' } });
    expect(response).toHaveBeenCalledTimes(2);
  });

  it('bounds an unavailable read at three total attempts', async () => {
    const value = fixture();
    const error = failure('ServiceUnavailable', 503);
    const response = vi.fn(() => {
      throw error;
    });
    respond(value.stacks, response);
    await expect(
      value.stacks.send(new DescribeStacksCommand({ StackName: 'project' })),
    ).rejects.toBe(error);
    expect(response).toHaveBeenCalledTimes(3);
    expect(value.sleep).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AccessDeniedException', 403],
    ['ValidationError', 400],
    ['AbortError', undefined],
  ])('does not retry permanent or canceled reads: %s', async (name, status) => {
    const value = fixture();
    const error = failure(name, status);
    const response = vi.fn(() => {
      throw error;
    });
    respond(value.loadBalancer, response);
    await expect(
      value.loadBalancer.send(new DescribeTargetHealthCommand({ TargetGroupArn: 'target' })),
    ).rejects.toBe(error);
    expect(response).toHaveBeenCalledTimes(1);
    expect(value.sleep).not.toHaveBeenCalled();
  });

  it('keeps all mutating requests at one attempt even for retryable provider failures', async () => {
    const value = fixture();
    const mutations = [
      [value.stacks, () => value.stacks.send(new CreateStackCommand({ StackName: 'project' }))],
      [
        value.loadBalancer,
        () => value.loadBalancer.send(new ModifyRuleCommand({ RuleArn: 'rule' })),
      ],
      [
        value.objects,
        () =>
          value.objects.send(new PutObjectCommand({ Bucket: 'bucket', Key: 'lock', Body: '{}' })),
      ],
      [
        value.cdn,
        () =>
          value.cdn.send(
            new CreateInvalidationCommand({
              DistributionId: 'distribution',
              InvalidationBatch: {
                CallerReference: 'reference',
                Paths: { Quantity: 1, Items: ['/*'] },
              },
            }),
          ),
      ],
    ] as const;
    for (const [client, run] of mutations) {
      const error = failure('ServiceUnavailable', 503);
      const response = vi.fn(() => {
        throw error;
      });
      respond(client, response);
      expect(await client.config.maxAttempts()).toBe(1);
      await expect(run()).rejects.toBe(error);
      expect(response).toHaveBeenCalledTimes(1);
    }
    expect(value.sleep).not.toHaveBeenCalled();
  });
});
