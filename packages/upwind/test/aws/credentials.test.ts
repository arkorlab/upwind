import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  awsCredentialProvider,
  credentialIdentity,
  takeAwsCredentials,
} from '../../src/aws/credentials.ts';

describe('isolated AWS credential identity', () => {
  it('keeps non-authentication AWS application configuration available before provider selection', () => {
    const env = {
      AWS_SHOP_NAME: 'actual-shop',
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'actual-project-profile',
      AWS_SECRET_ACCESS_KEY: 'private',
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/run/auth',
    };
    const captured = takeAwsCredentials(env);
    expect(env).toStrictEqual({
      AWS_SHOP_NAME: 'actual-shop',
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'actual-project-profile',
    });
    expect(captured.env['AWS_SECRET_ACCESS_KEY']).toBe('private');
  });

  it('rejects malformed optional fields without echoing their values', () => {
    for (const extra of [
      { sessionToken: 42 },
      { expiration: 'invalid-private-value' },
      { expiration: 123 },
    ]) {
      expect(() =>
        credentialIdentity({ accessKeyId: 'key', secretAccessKey: 'secret', ...extra }),
      ).toThrow('invalid AWS credential helper identity');
    }
    expect(
      credentialIdentity({
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        expiration: '2030-01-01T00:00:00.000Z',
      }).expiration,
    ).toEqual(new Date('2030-01-01T00:00:00.000Z'));
  });

  it('resolves credentials through IPC when a Node preload writes non-JSON stdout', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'upwind-aws-identity-'));
    try {
      const preload = path.join(directory, 'preload.mjs');
      await writeFile(preload, "console.log('user preload output');\n");
      const provider = awsCredentialProvider({
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: 'upwind-ci-access',
          AWS_SECRET_ACCESS_KEY: 'upwind-ci-secret',
          AWS_SESSION_TOKEN: 'upwind-ci-session',
          AWS_PROFILE: undefined,
          AWS_EC2_METADATA_DISABLED: 'true',
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
      });
      const identity = await provider();
      expect(identity).toMatchObject({
        accessKeyId: 'upwind-ci-access',
        secretAccessKey: 'upwind-ci-secret',
        sessionToken: 'upwind-ci-session',
      });
      expect(await provider()).toBe(identity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not wait on stdout inherited by an unreferenced preload descendant', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'upwind-aws-preload-child-'));
    try {
      const preload = path.join(directory, 'preload.mjs');
      await writeFile(
        preload,
        [
          "import { spawn } from 'node:child_process';",
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });",
          'child.unref();',
        ].join('\n'),
      );
      const provider = awsCredentialProvider({
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: 'upwind-ci-access',
          AWS_SECRET_ACCESS_KEY: 'upwind-ci-secret',
          AWS_PROFILE: undefined,
          AWS_EC2_METADATA_DISABLED: 'true',
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
      });
      const started = performance.now();
      await expect(provider()).resolves.toMatchObject({ accessKeyId: 'upwind-ci-access' });
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
