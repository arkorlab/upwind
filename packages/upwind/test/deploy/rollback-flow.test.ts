import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { bundleObjectKey } from '@stayingupwind/host/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDeploy } from '../../src/deploy/command.ts';
import { projectNames } from '../../src/deploy/names.ts';
import { runRollback } from '../../src/deploy/rollback.ts';
import { bundleOf, deployableFunction, moduleOf, writeBundle } from './bundle.ts';
import { bindingText } from './fake-cloudflare.ts';
import {
  deployableProject,
  deployOptions,
  type LiveAccount,
  liveAccount,
  scriptOn,
  servedBy,
} from './live-account.ts';

/**
 * `upwind rollback` from end to end, on an account that answers as Cloudflare's does, with the
 * agent and the cache authority running as uploaded (`live-account.ts`): the deployment gone back
 * to is published again against the one that was live, so that deployment's files stay served.
 */

// Bundled once for the file: every run would bundle the five Workers again otherwise.
vi.mock(import('../../src/deploy/shipped.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  const held: { workers?: ReturnType<typeof actual.shippedWorkers> } = {};
  return {
    ...actual,
    shippedWorkers: () => {
      held.workers ??= actual.shippedWorkers();
      return held.workers;
    },
  };
});

const PROJECT = 'shop';
const NAMES = projectNames(PROJECT);

/** A build whose page loads a script of its own name, as each build's chunks are its own. */
function buildWith(dir: string, chunk: string): DeploymentBundle {
  const bundle = bundleOf(deployableFunction(dir));
  const script = moduleOf(dir, `${chunk}.js`, 'text', `console.log(${JSON.stringify(chunk)});\n`);
  const built = {
    ...bundle,
    staticFiles: [
      {
        pathname: `/_next/static/chunks/${chunk}.js`,
        blob: { ...script.blob, contentType: 'text/javascript; charset=utf-8' },
        immutable: true,
      },
    ],
  };
  writeBundle(dir, built);
  const note = { v: 1, deploymentId: built.deploymentId, upwind: '0.4.0', builtAt: 'now' };
  writeFileSync(path.join(dir, '.arkor/upwind-deploy.json'), JSON.stringify(note));
  return built;
}

/** The version the edge gives all of its traffic to. */
function liveVersion(account: LiveAccount): string | undefined {
  return scriptOn(account, NAMES.edge).deployments[0]?.versions[0]?.version_id;
}

/** The manifest the edge's live version serves by, as the stores hold it. */
async function servedManifest(
  account: LiveAccount,
): Promise<{ readonly staticFiles?: Record<string, unknown> }> {
  const edge = scriptOn(account, NAMES.edge);
  const version = edge.versions.find((candidate) => candidate.id === liveVersion(account));
  const pointer = version === undefined ? undefined : bindingText(version, 'POINTER');
  const { manifestId } = JSON.parse(pointer ?? '{}') as { readonly manifestId?: string };
  const state = await account.stack.mf.getKVNamespace('EDGE_STATE', 'agent');
  const manifest = await state.get(`manifest:${String(manifestId)}`);
  return JSON.parse(manifest ?? '{}') as { readonly staticFiles?: Record<string, unknown> };
}

describe('`upwind rollback` on an account', () => {
  const held: { account?: LiveAccount; warnings: string[]; errors: string[] } = {
    warnings: [],
    errors: [],
  };
  const account = (): LiveAccount => {
    if (held.account === undefined) {
      throw new Error('no account yet');
    }
    return held.account;
  };

  beforeEach(async () => {
    held.account = await liveAccount(PROJECT);
    held.warnings = [];
    held.errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {
      // A run says what it does; the tests read the account instead.
    });
    vi.spyOn(console, 'warn').mockImplementation((text: string) => {
      held.warnings.push(text);
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      held.errors.push(text);
    });
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await held.account?.dispose();
  });

  /** Two deployments made, the second live; the first's own version of the edge. */
  async function twoDeployed(dir: string): Promise<{
    readonly first: DeploymentBundle;
    readonly second: DeploymentBundle;
    readonly firstVersion: string | undefined;
  }> {
    const first = buildWith(dir, 'one');

    await expect(runDeploy(deployOptions(dir), account().credentials, account().io)).resolves.toBe(
      0,
    );

    const firstVersion = liveVersion(account());
    const second = buildWith(dir, 'two');

    await expect(runDeploy(deployOptions(dir), account().credentials, account().io)).resolves.toBe(
      0,
    );
    expect(servedBy(account(), NAMES.edge)).toBe(second.deploymentId);

    return { first, second, firstVersion };
  }

  it("publishes the deployment again with the live one's files beside its own", async () => {
    const dir = await deployableProject(PROJECT);
    const { first, firstVersion } = await twoDeployed(dir);

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);
    expect(held.errors).toStrictEqual([]);
    expect(servedBy(account(), NAMES.edge)).toBe(first.deploymentId);
    // A version of its own, made now, whose pointer names a manifest staged against the second.
    expect(liveVersion(account())).not.toBe(firstVersion);

    const manifest = await servedManifest(account());

    expect(Object.keys(manifest.staticFiles ?? {}).toSorted(compareCodeUnits)).toStrictEqual([
      '/_next/static/chunks/one.js',
      '/_next/static/chunks/two.js',
    ]);
  });

  it('discards the key it took the agent with, as a deploy does', async () => {
    const dir = await deployableProject(PROJECT);
    await twoDeployed(dir);
    const before = new Set(account().keys);

    await expect(
      runRollback({ projectDir: dir, to: undefined }, account().credentials, account().io),
    ).resolves.toBe(0);

    // Every key the agent took after the two deploys: the rollback's own.
    const taken: string[] = [];
    for (const key of account().keys) {
      if (!before.has(key)) {
        taken.push(key);
      }
    }
    const agentKey = scriptOn(account(), NAMES.agent).secrets.get('AGENT_KEY');

    expect(taken).toHaveLength(1);
    expect(agentKey).not.toBe(taken[0]);
  });

  it("switches to the deployment's version as it stands where its bundle is not kept", async () => {
    const dir = await deployableProject(PROJECT);
    const { first, firstVersion } = await twoDeployed(dir);
    const bucket = await account().stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.delete(bundleObjectKey(PROJECT, first.deploymentId));

    await expect(
      runRollback({ projectDir: dir, to: first.deploymentId }, account().credentials, account().io),
    ).resolves.toBe(0);
    expect(liveVersion(account())).toBe(firstVersion);
    expect(held.warnings).toStrictEqual([
      expect.stringContaining(
        `keeps no bundle of ${first.deploymentId}, so its version is switched to as it stands`,
      ),
    ]);
  });
});
