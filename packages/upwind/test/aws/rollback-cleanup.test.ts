import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAwsRollback } from '../../src/aws/lifecycle/index.ts';
import { UncertainAwsMutation, type AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import type { DeploymentRecord } from '../../src/aws/lifecycle/state.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { AwsBootstrapOutputs } from '../../src/aws/types.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

const calls = vi.hoisted(() => ({
  activate: vi.fn(),
  scale: vi.fn(),
  policy: vi.fn(),
  route: vi.fn(),
}));
vi.mock(import('../../src/aws/lifecycle/operations.ts'), async (original) => ({
  ...(await original()),
  activateRecord: calls.activate,
  scale: calls.scale,
  reconcile: async () => ({ v: 1 as const, current: 'previous' }),
  recordOf: async () =>
    ({
      deploymentId: 'previous',
      targetGroupArn: 'previous-target',
      safeStaticBypass: true,
    }) as DeploymentRecord,
}));
vi.mock(import('../../src/aws/lifecycle/bootstrap.ts'), async (original) => ({
  ...(await original()),
  existingBootstrap: async () =>
    ({
      ArtifactsBucket: 'bucket',
      ListenerArn: 'listener',
      DistributionId: 'distribution',
    }) as AwsBootstrapOutputs,
}));
vi.mock(import('../../src/aws/lifecycle/state.ts'), async (original) => ({
  ...(await original()),
  withProjectLock: async <T>(
    _context: unknown,
    _bucket: unknown,
    run: (lock: { assertHeld(): Promise<void> }) => Promise<T>,
  ) => run({ assertHeld: async () => undefined }),
  records: async () => [
    {
      deploymentId: 'chosen',
      status: 'kept',
      targetGroupArn: 'chosen-target',
      settings: { tasks: 2 },
      safeStaticBypass: false,
      stackName: 'chosen-stack',
    } as DeploymentRecord,
  ],
}));
vi.mock(import('../../src/aws/lifecycle/asset-retention.ts'), async (original) => ({
  ...(await original()),
  pruneOrphanStaticManifests: async () => undefined,
}));
vi.mock(import('../../src/aws/lifecycle/cdn.ts'), async (original) => ({
  ...(await original()),
  configureStaticBypass: calls.policy,
}));
vi.mock(import('../../src/aws/lifecycle/routes.ts'), async (original) => ({
  ...(await original()),
  productionRule: calls.route,
}));

const settings = {
  project: 'shop',
  checks: ['/'],
  aws: awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } }),
} as DeploySettings;
const io = { services: {} as AwsServices };

beforeEach(() => {
  vi.clearAllMocks();
  calls.scale.mockResolvedValue(undefined);
  calls.policy.mockResolvedValue(undefined);
  calls.route.mockResolvedValue({
    Actions: [{ Type: 'forward', TargetGroupArn: 'previous-target' }],
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('AWS rollback failure cleanup', () => {
  it('preserves the activation error and restores the confirmed previous CDN policy if stopping the candidate fails', async () => {
    const activation = new Error('original activation error');
    calls.activate.mockRejectedValueOnce(activation);
    calls.scale
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('known cleanup failure'));
    await expect(
      runAwsRollback({ projectDir: '/app', to: undefined }, settings, undefined, io),
    ).rejects.toBe(activation);
    expect(calls.policy.mock.calls.map((call) => call[3])).toStrictEqual([false, true]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be stopped'));
  });

  it('does not restore routing policy or stop tasks after an uncertain activation', async () => {
    const uncertain = new UncertainAwsMutation('switch routing', new Error('lost response'));
    calls.activate.mockRejectedValueOnce(uncertain);
    await expect(
      runAwsRollback({ projectDir: '/app', to: undefined }, settings, undefined, io),
    ).rejects.toBe(uncertain);
    expect(calls.scale).toHaveBeenCalledTimes(1);
    expect(calls.policy.mock.calls.map((call) => call[3])).toStrictEqual([false]);
    expect(calls.route).not.toHaveBeenCalled();
  });

  it('retains the uncertain cleanup outcome instead of replacing it with the original activation error', async () => {
    const uncertain = new UncertainAwsMutation('stop candidate', new Error('lost response'));
    calls.activate.mockRejectedValueOnce(new Error('activation failed'));
    calls.scale.mockResolvedValueOnce(undefined).mockRejectedValueOnce(uncertain);
    await expect(
      runAwsRollback({ projectDir: '/app', to: undefined }, settings, undefined, io),
    ).rejects.toBe(uncertain);
    expect(calls.policy.mock.calls.map((call) => call[3])).toStrictEqual([false]);
  });
});
