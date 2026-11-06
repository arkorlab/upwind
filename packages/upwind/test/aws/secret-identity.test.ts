import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';

import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { deploymentSecret } from '../../src/aws/lifecycle/secrets.ts';

const values = new Map([
  ['API_TOKEN', 'requested-token'],
  ['DATABASE_PASSWORD', 'requested-password'],
]);
const serialized = JSON.stringify(Object.fromEntries(values));

function fixture(secretString: string | undefined, owned = true) {
  const send = vi.fn(async (command: unknown): Promise<unknown> => {
    if (command instanceof CreateSecretCommand)
      throw Object.assign(new Error('secret exists'), {
        name: 'ResourceExistsException',
        $metadata: { httpStatusCode: 400 },
      });
    if (command instanceof DescribeSecretCommand)
      return {
        ARN: 'secret-arn',
        Tags: [
          { Key: 'upwind:project', Value: owned ? 'shop' : 'other-project' },
          { Key: 'upwind:deployment', Value: 'candidate' },
        ],
      };
    if (command instanceof GetSecretValueCommand) return { SecretString: secretString };
    throw new Error('unexpected secret mutation');
  });
  const context: AwsContext = {
    services: { secrets: { send } } as unknown as AwsServices,
    now: Date.now,
    fetch,
    sleep: async () => undefined,
  };
  return { context, send };
}

describe('AWS immutable application secret identity', () => {
  it('reuses an owned secret only when its full serialized contents match', async () => {
    const value = fixture(serialized);
    await expect(deploymentSecret(value.context, 'shop', 'candidate', values)).resolves.toBe(
      'secret-arn',
    );
    const create = value.send.mock.calls.find(
      ([command]) => command instanceof CreateSecretCommand,
    )?.[0];
    const read = value.send.mock.calls.find(
      ([command]) => command instanceof GetSecretValueCommand,
    )?.[0];
    expect(create).toBeInstanceOf(CreateSecretCommand);
    expect(read).toBeInstanceOf(GetSecretValueCommand);
    if (create instanceof CreateSecretCommand) expect(create.input.SecretString).toBe(serialized);
    if (read instanceof GetSecretValueCommand) expect(read.input.SecretId).toBe('secret-arn');
  });

  it.each([
    JSON.stringify({ API_TOKEN: 'requested-token', DATABASE_PASSWORD: 'old-password' }),
    undefined,
  ])('rejects different or absent string contents without exposing either value', async (held) => {
    const value = fixture(held);
    const failure: unknown = await deploymentSecret(
      value.context,
      'shop',
      'candidate',
      values,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('secret identity was not rejected');
    expect(failure.message).toContain('different application secrets');
    for (const secret of [...values.values(), 'old-password'])
      expect(failure.message).not.toContain(secret);
  });

  it('checks ownership before reading another deployment secret value', async () => {
    const value = fixture(serialized, false);
    await expect(deploymentSecret(value.context, 'shop', 'candidate', values)).rejects.toThrow(
      'owned by another deployment',
    );
    expect(
      value.send.mock.calls.some(([command]) => command instanceof GetSecretValueCommand),
    ).toBe(false);
  });
});
