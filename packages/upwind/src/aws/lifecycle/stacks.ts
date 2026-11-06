import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
  type Stack,
  type StackResourceSummary,
} from '@aws-sdk/client-cloudformation';

import { errorCode, mutation, type AwsContext, UncertainAwsMutation } from './sdk.ts';

export function bootstrapName(project: string): string {
  return `upwind-${project}`;
}
export function deploymentStackName(project: string, id: string): string {
  return `upwind-${project}-${id.replaceAll('_', '-')}`;
}

export async function stack(context: AwsContext, name: string): Promise<Stack | undefined> {
  try {
    return (await context.services.stacks.send(new DescribeStacksCommand({ StackName: name })))
      .Stacks?.[0];
  } catch (error) {
    if (
      errorCode(error) === 'ValidationError' &&
      error instanceof Error &&
      /does not exist/u.test(error.message)
    )
      return undefined;
    throw error;
  }
}

export function outputs(value: Stack): Record<string, string> {
  return Object.fromEntries(
    (value.Outputs ?? []).flatMap((output) =>
      output.OutputKey !== undefined && output.OutputValue !== undefined
        ? [[output.OutputKey, output.OutputValue]]
        : [],
    ),
  );
}

/** Physical resource discovery also works when a failed stack has never produced outputs. */
export async function stackResources(
  context: AwsContext,
  name: string,
): Promise<StackResourceSummary[]> {
  const resources: StackResourceSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.services.stacks.send(
      new ListStackResourcesCommand({
        StackName: name,
        ...(cursor === undefined ? {} : { NextToken: cursor }),
      }),
    );
    resources.push(...(page.StackResourceSummaries ?? []));
    cursor = page.NextToken;
  } while (cursor !== undefined);
  return resources;
}

export function owned(value: Stack, project: string): void {
  if (!value.Tags?.some((tag) => tag.Key === 'upwind:project' && tag.Value === project)) {
    throw new Error(`${value.StackName ?? 'stack'} is not owned by upwind project ${project}`);
  }
}

export async function waitStack(
  context: AwsContext,
  name: string,
  deleting = false,
): Promise<Stack | undefined> {
  const deadline = context.now() + 3_600_000;
  while (context.now() < deadline) {
    const current = await stack(context, name).catch((error: unknown) => {
      throw new UncertainAwsMutation(
        `CloudFormation ${name} could not be observed while settling`,
        error,
      );
    });
    if (current === undefined) {
      if (deleting) return undefined;
      throw new Error(`CloudFormation stack ${name} disappeared`);
    }
    const status = current.StackStatus ?? '';
    if (!status.endsWith('_IN_PROGRESS')) {
      if (
        (!deleting && (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE')) ||
        (deleting && status === 'DELETE_COMPLETE')
      )
        return current;
      const events = await context.services.stacks.send(
        new DescribeStackEventsCommand({ StackName: name }),
      );
      const failed = events.StackEvents?.filter((event) =>
        event.ResourceStatus?.endsWith('_FAILED'),
      )
        .slice(0, 3)
        .map(
          (event) =>
            `${event.LogicalResourceId ?? 'resource'}: ${event.ResourceStatusReason ?? event.ResourceStatus}`,
        )
        .join('; ');
      throw new Error(
        `CloudFormation ${name}: ${status}${failed === undefined || failed === '' ? '' : ` (${failed})`}`,
      );
    }
    await context.sleep(10_000);
  }
  throw new UncertainAwsMutation(
    `CloudFormation ${name} has not settled within one hour`,
    undefined,
  );
}

export async function createStack(
  context: AwsContext,
  project: string,
  name: string,
  template: string,
): Promise<Stack> {
  const existing = await stack(context, name);
  if (existing !== undefined) {
    owned(existing, project);
    const current = await waitStack(context, name);
    if (current === undefined) throw new Error(`CloudFormation ${name} disappeared`);
    return current;
  }
  try {
    await mutation(`create CloudFormation ${name}`, () =>
      context.services.stacks.send(
        new CreateStackCommand({
          StackName: name,
          TemplateBody: template,
          Capabilities: ['CAPABILITY_NAMED_IAM'],
          Tags: [{ Key: 'upwind:project', Value: project }],
        }),
      ),
    );
  } catch (error) {
    // A concurrent first deploy may have won stack creation before there is an S3 project lock.
    if (errorCode(error) !== 'AlreadyExistsException') throw error;
  }
  const created = await waitStack(context, name);
  if (created === undefined) throw new Error(`CloudFormation ${name} disappeared`);
  owned(created, project);
  return created;
}

export async function updateStack(
  context: AwsContext,
  project: string,
  name: string,
  template: string,
): Promise<void> {
  const current = await stack(context, name);
  if (current === undefined) throw new Error(`CloudFormation ${name} is missing`);
  owned(current, project);
  try {
    await mutation(`update CloudFormation ${name}`, () =>
      context.services.stacks.send(
        new UpdateStackCommand({
          StackName: name,
          TemplateBody: template,
          Capabilities: ['CAPABILITY_NAMED_IAM'],
        }),
      ),
    );
  } catch (error) {
    if (
      errorCode(error) === 'ValidationError' &&
      error instanceof Error &&
      /No updates are to be performed/u.test(error.message)
    )
      return;
    throw error;
  }
  await waitStack(context, name);
}

export async function deleteStack(
  context: AwsContext,
  project: string,
  name: string,
): Promise<void> {
  const current = await stack(context, name);
  if (current === undefined) return;
  owned(current, project);
  await mutation(`delete CloudFormation ${name}`, () =>
    context.services.stacks.send(new DeleteStackCommand({ StackName: name })),
  );
  await waitStack(context, name, true);
}

/** DesiredCount has exactly one owner, CloudFormation, including retained deployments at zero. */
export function withDesiredCount(template: string, count: number): string {
  const parsed = JSON.parse(template) as {
    Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  };
  const services = Object.values(parsed.Resources).filter(
    (resource) => resource.Type === 'AWS::ECS::Service',
  );
  if (services.length !== 1 || services[0] === undefined)
    throw new Error('deployment template must contain exactly one ECS service');
  services[0].Properties['DesiredCount'] = count;
  return JSON.stringify(parsed);
}
