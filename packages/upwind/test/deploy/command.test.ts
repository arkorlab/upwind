import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { createId } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWNER_KEY, readAccount } from '../../src/deploy/account.ts';
import type { DeployOptions } from '../../src/deploy/args.ts';
import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { runDeploy } from '../../src/deploy/command.ts';
import { readDeploySettings } from '../../src/deploy/config.ts';
import { deployToAccount } from '../../src/deploy/deploy-run.ts';
import { runDeployments } from '../../src/deploy/deployments.ts';
import { runDestroy } from '../../src/deploy/destroy.ts';
import { deploymentLabel, functionScriptName, projectNames } from '../../src/deploy/names.ts';
import { preflight } from '../../src/deploy/preflight.ts';
import { projectLockBucket } from '../../src/deploy/project-lock.ts';
import { runRollback } from '../../src/deploy/rollback.ts';
import { ownVersion } from '../../src/manifest.ts';
import {
  bundleOf,
  deployableFunction,
  functionOf,
  moduleOf,
  projectDir,
  writeBundle,
} from './bundle.ts';
import { type FakeCloudflare, fakeCloudflare, type FakeScript } from './fake-cloudflare.ts';
import { projectWith } from './project.ts';

/**
 * A project with a build `upwind deploy --build-only` made, and the adapter to read its settings:
 * one Function, or as many as `functions` says, the first one's pages split among the rest.
 */
async function builtProject(
  input: {
    readonly deployable?: boolean;
    readonly noted?: boolean;
    readonly functions?: number;
  } = {},
) {
  const dir = projectDir();
  projectWith({ dir, adapterVersion: await ownVersion(), packageName: 'shop' });
  const app =
    input.deployable === false
      ? functionOf([moduleOf(dir, 'index.mjs', 'esm', 'export default {};')])
      : deployableFunction(dir);
  const split = Array.from(
    { length: (input.functions ?? 1) - 1 },
    (_, index) => `app-${index + 2}`,
  );
  const bundle =
    split.length === 0
      ? bundleOf(app)
      : bundleOf(app, {
          v: 2,
          entrypoints: [
            { id: '/', kind: 'app-page', pathname: '/' },
            ...split.map((name) => {
              return {
                id: `/${name}`,
                kind: 'app-page' as const,
                pathname: `/${name}`,
                function: name,
              };
            }),
          ],
          functions: { app, split: Object.fromEntries(split.map((name) => [name, app])) },
        });
  writeBundle(dir, bundle);
  if (input.noted !== false) {
    const note = { v: 1, deploymentId: bundle.deploymentId, upwind: '0.4.0', builtAt: 'now' };
    writeFileSync(path.join(dir, '.arkor/upwind-deploy.json'), JSON.stringify(note));
  }
  return { dir, deploymentId: bundle.deploymentId };
}

/** A Worker on the fake account, of any kind: what the account's count of them is made of. */
function workerOn(fake: FakeCloudflare, name: string): void {
  const script: FakeScript = {
    name,
    versions: [],
    deployments: [],
    subdomain: { enabled: true, previews_enabled: true },
    migrationTag: undefined,
    secrets: new Map(),
  };
  fake.scripts.set(name, script);
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
    resetCacheKey: false,
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
      workerOn(fake, `other-${index}`);
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

  it('refuses a deployment the account has no room for at its peak, before older ones are cleaned up', async () => {
    // Six deployments of seven Functions each, kept or live, beside 450 Workers of others: 497 in
    // all. A build of four Functions keeps to 483 once it has cleaned up, and needs 501 before.
    const { dir } = await builtProject({ functions: 4 });
    const fake = fakeCloudflare();
    for (let index = 0; index < 450; index += 1) {
      workerOn(fake, `other-${index}`);
    }
    const names = projectNames('shop');
    for (const own of [names.edge, names.cache, names.cacheRead, names.prefetch, names.agent]) {
      workerOn(fake, own);
    }
    const roles = ['app', ...Array.from({ length: 6 }, (_, index) => `app-${index + 2}`)];
    for (let deployment = 0; deployment < 6; deployment += 1) {
      const deploymentId = createId('dpl');
      for (const role of roles) {
        workerOn(fake, functionScriptName('shop', deploymentId, role));
      }
    }
    // The project's own, marked as such, so nothing but room stops the deploy.
    const mark = new TextEncoder().encode(JSON.stringify({ v: 1, project: 'shop', made: {} }));
    fake.buckets.set(
      names.artifactsBucket,
      new Map([[OWNER_KEY, { bytes: mark, contentType: 'application/json' }]]),
    );

    await expect(
      runDeploy(
        optionsFor(dir),
        { apiToken: 'token', accountId: undefined },
        { fetch: fake.fetch },
      ),
    ).resolves.toBe(1);
    expect(printed).toContain(
      "  account account-1: 497 Workers, 47 of them this project's; with this project's at most, 501 of 500",
    );
    expect(errors).toStrictEqual([
      'upwind: one thing stops this deployment:',
      expect.stringContaining(
        "holds 497 Workers, 47 of them this project's, and this deploy would bring it to 501 before it cleans any up, over the 500",
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

  it('reports local build problems without reaching the account or creating a lock', async () => {
    const { dir } = await builtProject({ deployable: false });
    const fake = fakeCloudflare();
    fake.buckets.set(projectLockBucket(projectNames('shop')), new Map());

    await expect(
      runDeploy(
        optionsFor(dir, { dryRun: false }),
        { apiToken: 'token', accountId: undefined },
        fake,
      ),
    ).resolves.toBe(1);
    expect(errors).toStrictEqual([
      'upwind: one thing stops this deployment:',
      expect.stringMatching(/built without the runtime cache's host/u),
    ]);
    expect(printed).toContain('  account: not read, since local build checks failed');
    expect(fake.requests).toStrictEqual([]);
  });

  it('rejects a direct deploy with local plan problems before acquiring a lock', async () => {
    const { dir } = await builtProject({ deployable: false });
    const fake = fakeCloudflare();
    const scope = {
      client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
      accountId: 'account-1',
    };
    const settings = await readDeploySettings(dir);
    const secrets = new Map<string, string>();
    const plan = await preflight({ projectDir: dir, settings, secrets });

    await expect(
      deployToAccount({
        scope,
        settings,
        plan,
        secrets,
        message: undefined,
        resetCacheKey: false,
        fetch: fake.fetch,
      }),
    ).rejects.toThrow(/built without the runtime cache's host/u);
    expect(fake.requests).toStrictEqual([]);
  });

  it('deploys with --prebuilt only what a deploy built', async () => {
    const { dir } = await builtProject({ noted: false });

    await expect(runDeploy(optionsFor(dir), undefined)).resolves.toBe(1);
    expect(errors).toStrictEqual([expect.stringMatching(/nothing it built is here/u)]);
  });

  it('goes no further than the plan without the token that reaches the account', async () => {
    const { dir } = await builtProject();

    await expect(runDeploy(optionsFor(dir, { dryRun: false }), undefined)).resolves.toBe(1);
    expect(errors).toStrictEqual([
      expect.stringMatching(/CLOUDFLARE_API_TOKEN, which is not set/u),
    ]);
  });

  it('refuses every mutating command before reading the project while another host holds it', async () => {
    const { dir } = await builtProject();
    const fake = fakeCloudflare();
    const bucket = projectLockBucket(projectNames('shop'));
    fake.buckets.set(bucket, new Map());
    const credentials = { apiToken: 'token', accountId: 'account-1' };
    const commands = [
      () => runDeploy(optionsFor(dir, { dryRun: false }), credentials, fake),
      () => runRollback({ projectDir: dir, to: undefined }, credentials, fake),
      () => runDestroy({ projectDir: dir, yes: true, includeStorage: true }, credentials, fake),
    ];
    for (const command of commands) {
      const from = fake.requests.length;
      await expect(command()).rejects.toThrow(/could not acquire the project lock/u);
      expect(fake.requests.slice(from).map(({ method, path }) => ({ method, path }))).toStrictEqual(
        [{ method: 'POST', path: '/accounts/account-1/r2/buckets' }],
      );
    }
    expect([...fake.buckets.keys()]).toStrictEqual([bucket]);
    expect(fake.kv.size).toBe(0);
    expect(fake.scripts.size).toBe(0);
  });

  it('keeps planning and listing read-only while a project lock is held', async () => {
    const { dir } = await builtProject();
    const fake = fakeCloudflare();
    const bucket = projectLockBucket(projectNames('shop'));
    fake.buckets.set(bucket, new Map());
    const credentials = { apiToken: 'token', accountId: 'account-1' };

    await expect(runDeploy(optionsFor(dir), credentials, fake)).resolves.toBe(0);
    await expect(runDeployments({ projectDir: dir }, credentials, fake)).resolves.toBe(0);
    expect(fake.requests.every((request) => request.method === 'GET')).toBe(true);
    expect([...fake.buckets.keys()]).toStrictEqual([bucket]);
  });

  it('replaces a direct deploy caller account snapshot only after acquiring the lock', async () => {
    const { dir } = await builtProject();
    const fake = fakeCloudflare();
    const names = projectNames('shop');
    const scope = {
      client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
      accountId: 'account-1',
    };
    const account = await readAccount(scope, names);
    const settings = await readDeploySettings(dir);
    const secrets = new Map<string, string>();
    const plan = await preflight({ projectDir: dir, settings, secrets });
    // A caller's valid earlier snapshot must not authorize provisioning against the changed account.
    fake.subdomain = undefined;
    const from = fake.requests.length;

    await expect(
      deployToAccount({
        scope,
        account,
        settings,
        plan,
        secrets,
        message: undefined,
        resetCacheKey: false,
        fetch: fake.fetch,
      }),
    ).rejects.toThrow(/the account has no workers.dev subdomain/u);
    const requests = fake.requests.slice(from);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/accounts/account-1/r2/buckets' });
    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/accounts/account-1/r2/buckets/${projectLockBucket(names)}`,
    });
    expect(requests.slice(1, -1).every((request) => request.method === 'GET')).toBe(true);
    expect(fake.buckets.size).toBe(0);
    expect(fake.kv.size).toBe(0);
    expect(fake.scripts.size).toBe(0);
  });
});
