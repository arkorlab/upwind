import { describe, expect, it } from 'vitest';

import { restoreAwsApplicationEnvironment, takeAwsCredentials } from '../../src/aws/credentials.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import { readDeploySettings } from '../../src/deploy/config.ts';
import { ownVersion } from '../../src/manifest.ts';
import { projectWith } from '../deploy/project.ts';

describe('AWS Fargate settings', () => {
  it('selects AWS without requiring Cloudflare configuration', async () => {
    const dir = projectWith({
      adapterVersion: await ownVersion(),
      config: {
        file: 'upwind.config.ts',
        crons: [],
        deploy: { target: 'aws', aws: { region: 'ap-northeast-1' } },
      },
    });
    const settings = await readDeploySettings(dir);
    expect(settings).toMatchObject({
      target: 'aws',
      aws: {
        region: 'ap-northeast-1',
        tasks: 2,
        cloudFront: true,
        cache: { backend: 'valkey', nodeType: 'cache.m7g.large' },
        cpu: 1024,
        memoryMiB: 2048,
        architecture: 'x86_64',
        build: { context: '.', env: [] },
      },
    });
  });

  it('supports both caches with or without CloudFront', () => {
    for (const backend of ['valkey', 'dynamodb'] as const) {
      for (const cloudFront of [true, false]) {
        const value = awsDeploySettings({
          region: 'ap-northeast-1',
          cache: { backend },
          cloudFront,
          ...(cloudFront
            ? {}
            : {
                publicOrigin: 'https://app.example.com',
                certificateArn:
                  'arn:aws:acm:ap-northeast-1:123456789012:certificate/11111111-1111-1111-1111-111111111111',
              }),
        });
        expect(value.cache.backend).toBe(backend);
        expect(value.cloudFront).toBe(cloudFront);
      }
    }
  });

  it('refuses invalid native resource combinations before provisioning', () => {
    expect(() =>
      awsDeploySettings({ region: 'ap-northeast-1', cpu: 256, memoryMiB: 1536 }),
    ).toThrow('CPU/memory');
    expect(() => awsDeploySettings({ region: 'ap-northeast-1', cloudFront: false })).toThrow(
      'certificateArn',
    );
    expect(() =>
      awsDeploySettings({
        region: 'ap-northeast-1',
        cache: { backend: 'valkey', nodeType: 'cache.t4g.micro' },
      }),
    ).toThrow('durability');
    expect(() =>
      awsDeploySettings({ region: 'ap-northeast-1', build: { env: ['AWS_ACCESS_KEY_ID'] } }),
    ).toThrow('credentials');
    expect(() =>
      awsDeploySettings({ region: 'ap-northeast-1', build: { env: ['aws_secret_access_key'] } }),
    ).toThrow('credentials');
  });

  it('captures AWS authentication without leaving it in the project environment', () => {
    const env = {
      AWS_PROFILE: 'deployment',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/run/token',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/deploy',
      AWS_SECRET_ACCESS_KEY: 'secret',
      APP_VALUE: 'keep',
    };
    const captured = takeAwsCredentials(env);
    expect(env).toStrictEqual({
      AWS_PROFILE: 'deployment',
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/deploy',
      APP_VALUE: 'keep',
    });
    expect(captured.env['AWS_PROFILE']).toBe('deployment');
    expect(captured.env['AWS_WEB_IDENTITY_TOKEN_FILE']).toBe('/run/token');
    restoreAwsApplicationEnvironment(captured, env);
    expect(env.AWS_PROFILE).toBe('deployment');
    expect(env.APP_VALUE).toBe('keep');
  });
});
