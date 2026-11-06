import { describe, expect, it, vi } from 'vitest';

import { awsComputeDriver } from '../../src/aws/compute.ts';
import { runAwsDeploy } from '../../src/aws/provider.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import { parseDeployRequest } from '../../src/deploy/args.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

const commands = vi.hoisted(() => ({
  deploy: vi.fn(),
  deployments: vi.fn(),
  rollback: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('../../src/aws/drivers/fargate.ts', () => ({
  fargateDriver: { compute: 'fargate', ...commands },
}));

function settings(): DeploySettings {
  return {
    target: 'aws',
    aws: awsDeploySettings({ region: 'ap-northeast-1' }),
    file: undefined,
    project: 'shop',
    workersDev: true,
    hostnames: [],
    keep: 5,
    storage: [],
    secrets: [],
    images: false,
    checks: ['/'],
    cspNonce: undefined,
    logs: false,
  };
}

describe('AWS compute driver selection', () => {
  it('resolves the complete lifecycle at one boundary', async () => {
    const selected = await awsComputeDriver(settings());
    expect(selected.compute).toBe('fargate');
    expect(selected.deploy).toBe(commands.deploy);
    expect(selected.deployments).toBe(commands.deployments);
    expect(selected.rollback).toBe(commands.rollback);
    expect(selected.destroy).toBe(commands.destroy);
  });

  it('refuses an unknown execution target before invoking a command', async () => {
    const value = settings();
    Reflect.set(value.aws ?? {}, 'compute', 'lambda');
    const request = parseDeployRequest(['/app']);
    if (request.answer !== undefined) throw new Error('missing deploy options');
    await expect(runAwsDeploy(request.options, value)).rejects.toThrow(
      'unsupported AWS compute driver',
    );
    expect(commands.deploy).not.toHaveBeenCalled();
  });
});
