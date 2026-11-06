import { createHash } from 'node:crypto';

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';

import { errorCode, mutation, type AwsContext } from './sdk.ts';

export async function deploymentSecret(
  context: AwsContext,
  project: string,
  deploymentId: string,
  values: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  if (values.size === 0) return undefined;
  const name = `upwind/${project}/${deploymentId}`;
  try {
    const result = await mutation('create application secret', () =>
      context.services.secrets.send(
        new CreateSecretCommand({
          Name: name,
          ClientRequestToken: createHash('sha256').update(deploymentId).digest('hex'),
          SecretString: JSON.stringify(Object.fromEntries(values)),
          Tags: [
            { Key: 'upwind:project', Value: project },
            { Key: 'upwind:deployment', Value: deploymentId },
          ],
        }),
      ),
    );
    if (result.ARN === undefined) throw new Error('Secrets Manager returned no ARN');
    return result.ARN;
  } catch (error) {
    if (errorCode(error) !== 'ResourceExistsException') throw error;
    const held = await context.services.secrets.send(new DescribeSecretCommand({ SecretId: name }));
    if (
      held.ARN === undefined ||
      !held.Tags?.some((tag) => tag.Key === 'upwind:project' && tag.Value === project) ||
      !held.Tags.some((tag) => tag.Key === 'upwind:deployment' && tag.Value === deploymentId)
    )
      throw new Error('application secret is owned by another deployment');
    return held.ARN;
  }
}

export async function deleteSecret(
  context: AwsContext,
  project: string,
  arn: string,
): Promise<void> {
  try {
    const held = await context.services.secrets.send(new DescribeSecretCommand({ SecretId: arn }));
    if (!held.Tags?.some((tag) => tag.Key === 'upwind:project' && tag.Value === project))
      throw new Error('refusing to delete an application secret owned by another project');
    await mutation('delete application secret', () =>
      context.services.secrets.send(
        new DeleteSecretCommand({ SecretId: arn, ForceDeleteWithoutRecovery: true }),
      ),
    );
  } catch (error) {
    if (errorCode(error) !== 'ResourceNotFoundException') throw error;
  }
}

/** Failed uploads can have created a secret before their deployment record was committed. */
export async function deleteProjectSecrets(context: AwsContext, project: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await context.services.secrets.send(
      new ListSecretsCommand({
        Filters: [{ Key: 'name', Values: [`upwind/${project}/`] }],
        MaxResults: 100,
        ...(cursor === undefined ? {} : { NextToken: cursor }),
      }),
    );
    for (const secret of page.SecretList ?? []) {
      if (
        secret.ARN === undefined ||
        !secret.Name?.startsWith(`upwind/${project}/`) ||
        !secret.Tags?.some((tag) => tag.Key === 'upwind:project' && tag.Value === project) ||
        !secret.Tags.some((tag) => tag.Key === 'upwind:deployment')
      )
        continue;
      await deleteSecret(context, project, secret.ARN);
    }
    cursor = page.NextToken;
  } while (cursor !== undefined);
}
