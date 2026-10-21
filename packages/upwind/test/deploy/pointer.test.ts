import {
  DeployRefusalError,
  type DeployTarget,
  publishDeployment,
  type StagedDeployment,
} from '@stayingupwind/deploy/deploy';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_VARIABLE_BYTES } from '../../src/deploy/env.ts';
import { publishPointer, selectedPolicyOf } from '../../src/deploy/pointer.ts';

vi.mock(import('@stayingupwind/deploy/deploy'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, publishDeployment: vi.fn<typeof actual.publishDeployment>() };
});

const publish = vi.mocked(publishDeployment);

/** What a publication answers with: a pointer, as `publishDeployment` makes one. */
function pointerOf(extra: Record<string, unknown> = {}): EdgePointer {
  return {
    v: 1,
    projectId: 'shop',
    originHost: 'shop.example.com',
    mode: 'edge',
    manifestId: 'a'.repeat(64),
    policyId: DEFAULT_DELIVERY_POLICY.id,
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...extra,
  };
}

/** Neither is read: the publication that would read them is the mock's. */
const TARGET = {} as DeployTarget;
const STAGED = { manifestId: 'a'.repeat(64) } as StagedDeployment;

/** A clock that moves only when the run waits, as long as it waits. */
function clock(): {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly waits: number[];
} {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: (ms) => {
      waits.push(ms);
      at += ms;
      return Promise.resolve();
    },
    waits,
  };
}

describe("the deployment's pointer", () => {
  beforeEach(() => {
    publish.mockReset();
  });

  it('selects the built-in policy by its id, and carries any other whole', () => {
    expect(selectedPolicyOf(DEFAULT_DELIVERY_POLICY)).toBe('builtin');

    const named = { ...DEFAULT_DELIVERY_POLICY, id: 'shop-custom' };

    expect(selectedPolicyOf(named)).toStrictEqual(named);

    // The built-in's id, and not its spec: never taken for the built-in.
    const changed = {
      ...DEFAULT_DELIVERY_POLICY,
      shell: { ...DEFAULT_DELIVERY_POLICY.shell, memoryLru: false },
    };

    expect(selectedPolicyOf(changed)).toStrictEqual(changed);
  });

  it("is published under the default policy, the project's nonce setting with it", async () => {
    publish.mockResolvedValue(pointerOf({ cspNonce: true }));
    const time = clock();
    const json = await publishPointer({
      target: TARGET,
      staged: STAGED,
      settings: { cspNonce: { mode: 'report-only', strictDynamic: true } },
      ...time,
    });

    expect(JSON.parse(json)).toStrictEqual({
      ...pointerOf({ cspNonce: true }),
      selectedPolicy: 'builtin',
    });
    expect(publish).toHaveBeenCalledWith(TARGET, STAGED, {
      policy: DEFAULT_DELIVERY_POLICY,
      cspNonce: true,
      cspNonceMode: 'report-only',
      cspStrictDynamic: true,
      now: time.now,
    });
  });

  it('is published again while what the publication wrote does not read back yet', async () => {
    publish.mockRejectedValueOnce(new Error('KV does not show manifest:a yet'));
    publish.mockResolvedValueOnce(pointerOf());
    const time = clock();

    await expect(
      publishPointer({
        target: TARGET,
        staged: STAGED,
        settings: { cspNonce: undefined },
        ...time,
      }),
    ).resolves.toContain('"selectedPolicy":"builtin"');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(time.waits).toStrictEqual([3000]);
  });

  it('is given up on once the wait is over', async () => {
    publish.mockRejectedValue(new Error('KV does not show manifest:a yet'));
    const time = clock();

    await expect(
      publishPointer({
        target: TARGET,
        staged: STAGED,
        settings: { cspNonce: undefined },
        ...time,
      }),
    ).rejects.toThrow('KV does not show manifest:a yet');
    expect(time.now()).toBeGreaterThanOrEqual(90_000);
    expect(time.now()).toBeLessThan(90_000 + 3000);
  });

  it('is not published again where the publication refused the deployment', async () => {
    publish.mockRejectedValue(new DeployRefusalError('no', { code: 'bundle_invalid' }));
    const time = clock();

    await expect(
      publishPointer({
        target: TARGET,
        staged: STAGED,
        settings: { cspNonce: undefined },
        ...time,
      }),
    ).rejects.toBeInstanceOf(DeployRefusalError);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(time.waits).toStrictEqual([]);
  });

  it("is refused where it is more than a Worker's variable holds", async () => {
    publish.mockResolvedValue(pointerOf({ reason: 'x'.repeat(MAX_VARIABLE_BYTES) }));
    const time = clock();

    await expect(
      publishPointer({
        target: TARGET,
        staged: STAGED,
        settings: { cspNonce: undefined },
        ...time,
      }),
    ).rejects.toThrow(`over the ${MAX_VARIABLE_BYTES} a Worker's variable holds`);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
