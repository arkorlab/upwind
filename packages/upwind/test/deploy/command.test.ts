import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeployOptions } from '../../src/deploy/args.ts';
import { runDeploy } from '../../src/deploy/command.ts';
import { deploymentLabel } from '../../src/deploy/names.ts';
import { ownVersion } from '../../src/manifest.ts';
import {
  bundleOf,
  deployableFunction,
  functionOf,
  moduleOf,
  projectDir,
  writeBundle,
} from './bundle.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';
import { projectWith } from './project.ts';

/** A project with a build `upwind deploy --build-only` made, and the adapter to read its settings. */
async function builtProject(
  input: { readonly deployable?: boolean; readonly noted?: boolean } = {},
) {
  const dir = projectDir();
  projectWith({ dir, adapterVersion: await ownVersion(), packageName: 'shop' });
  const app =
    input.deployable === false
      ? functionOf([moduleOf(dir, 'index.mjs', 'esm', 'export default {};')])
      : deployableFunction(dir);
  const bundle = bundleOf(app);
  writeBundle(dir, bundle);
  if (input.noted !== false) {
    const note = { v: 1, deploymentId: bundle.deploymentId, upwind: '0.4.0', builtAt: 'now' };
    writeFileSync(path.join(dir, '.arkor/upwind-deploy.json'), JSON.stringify(note));
  }
  return { dir, deploymentId: bundle.deploymentId };
}

function optionsFor(dir: string, overrides: Partial<DeployOptions> = {}): DeployOptions {
  return {
    projectDir: dir,
    prebuilt: true,
    buildOnly: false,
    envFiles: [],
    keep: undefined,
    message: undefined,
    dryRun: true,
    ...overrides,
  };
}

describe('`upwind deploy --dry-run`', () => {
  let printed: string[];
  let errors: string[];

  beforeEach(() => {
    printed = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => {
      printed.push(text);
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what it would deploy, without an account to read', async () => {
    const { dir, deploymentId } = await builtProject();

    await expect(runDeploy(optionsFor(dir), undefined)).resolves.toBe(0);
    expect(printed).toStrictEqual([
      `upwind: shop, deployment ${deploymentId}`,
      `  Functions: app as shop-${deploymentLabel(deploymentId)}-app`,
      '  Workers: up to 12 for this project, keeping 5 deployments to roll back to',
      '  reached at: shop-edge on workers.dev',
      '  account: not read, since CLOUDFLARE_API_TOKEN is not set',
    ]);
    expect(errors).toStrictEqual([]);
  });

  it('reads the account it would deploy to, and changes nothing on it', async () => {
    const { dir } = await builtProject();
    const fake = fakeCloudflare();

    await expect(
      runDeploy(
        optionsFor(dir),
        { apiToken: 'token', accountId: undefined },
        { fetch: fake.fetch },
      ),
    ).resolves.toBe(0);
    expect(printed).toContain('  reached at: https://shop-edge.example.workers.dev');
    expect(printed).toContain(
      "  account account-1: 0 Workers, 0 of them this project's; with this project's at most, 12 of 500",
    );
    expect(printed).toContain('  live: nothing yet; this would be the first deployment');
    expect(fake.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('refuses a deployment the account has no room for, counting its other Workers', async () => {
    const { dir } = await builtProject();
    const fake = fakeCloudflare();
    for (let index = 0; index < 490; index += 1) {
      fake.scripts.set(`other-${index}`, {
        name: `other-${index}`,
        versions: [],
        deployments: [],
        subdomain: { enabled: true, previews_enabled: true },
        migrationTag: undefined,
        secrets: new Map(),
      });
    }

    await expect(
      runDeploy(
        optionsFor(dir),
        { apiToken: 'token', accountId: undefined },
        { fetch: fake.fetch },
      ),
    ).resolves.toBe(1);
    expect(errors).toStrictEqual([
      'upwind: one thing stops this deployment:',
      expect.stringContaining(
        "holds 490 Workers besides this project's, and with this project's at most it would hold 502, over the 500",
      ),
    ]);
  });

  it('refuses what a deployment would get wrong, and says each thing', async () => {
    const { dir } = await builtProject({ deployable: false });

    await expect(runDeploy(optionsFor(dir), undefined)).resolves.toBe(1);
    expect(errors).toStrictEqual([
      'upwind: one thing stops this deployment:',
      expect.stringMatching(/built without the runtime cache's host/u),
    ]);
  });

  it('deploys with --prebuilt only what a deploy built', async () => {
    const { dir } = await builtProject({ noted: false });

    await expect(runDeploy(optionsFor(dir), undefined)).resolves.toBe(1);
    expect(errors).toStrictEqual([expect.stringMatching(/nothing it built is here/u)]);
  });

  it('stops after planning, in this version, without --dry-run', async () => {
    const { dir } = await builtProject();

    await expect(runDeploy(optionsFor(dir, { dryRun: false }), undefined)).resolves.toBe(1);
    expect(errors).toStrictEqual([expect.stringMatching(/run it with --dry-run/u)]);
  });
});
