/* eslint-disable unicorn/no-keyword-prefix -- Matches the host registration className field. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DeploySettings } from '../../src/deploy/config.ts';
import { preflight } from '../../src/deploy/preflight.ts';
import {
  bundleOf,
  deployableFunction,
  functionOf,
  moduleOf,
  projectDir,
  writeBundle,
} from './bundle.ts';

const SETTINGS: DeploySettings = {
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

const NO_SECRETS: ReadonlyMap<string, string> = new Map();

describe('checking a build before a deploy', () => {
  it('finds nothing wrong with a build made for one', async () => {
    const dir = projectDir();
    const bundle = bundleOf(deployableFunction(dir));
    writeBundle(dir, bundle);
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toStrictEqual([]);
    expect(plan.functions.map((script) => script.name)).toStrictEqual(['app']);
    // One Function for each of the five kept, the live one and the one being deployed; five of its own.
    expect(plan.projectedWorkers).toBe(1 * 7 + 5);
  });

  it.each([
    ['an app page', '/', 'app-page'],
    ['an app route', '/api/private', 'app-route'],
    ['a dynamic page', '/posts/[slug]', 'app-page'],
  ] as const)('refuses %s whose route gate the command cannot bind', async (_, route, kind) => {
    const dir = projectDir();
    writeBundle(
      dir,
      bundleOf(deployableFunction(dir), {
        entrypoints: [{ id: route, kind, pathname: route }],
        gates: { [route]: 'members' },
      }),
    );
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toStrictEqual([expect.stringContaining('route gates')]);
    expect(plan.problems[0]).toContain('`upwind deploy` does not bind yet');
  });

  it('refuses a Function built without the runtime cache', async () => {
    const dir = projectDir();
    const plain = functionOf([moduleOf(dir, 'index.mjs', 'esm', 'export default {};')]);
    writeBundle(dir, bundleOf(plain));
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toStrictEqual([
      expect.stringMatching(/built without the runtime cache's host/u),
    ]);
  });

  it('refuses Cloudflare Workflow artifacts when no scoped execution service is provisioned', async () => {
    const dir = projectDir();
    const app = deployableFunction(dir);
    writeBundle(
      dir,
      bundleOf(app, {
        v: 9,
        routerReferences: 'one-pass',
        cloudflareWorkflows: [{ name: 'JOBS', module: 'jobs.ts', className: 'Job' }],
        functions: { app, cloudflareWorkflows: { JOBS: app } },
      }),
    );
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toContainEqual(
      expect.stringMatching(/scoped Workflow execution service/u),
    );
  });

  it('refuses workflows and a module the upload keeps for itself, and takes cron jobs', async () => {
    const dir = projectDir();
    const app = deployableFunction(dir);
    const workflow = functionOf([...app.modules, moduleOf(dir, 'metadata', 'text', '{}')]);
    writeBundle(
      dir,
      bundleOf(workflow, {
        functions: { app: workflow, workflow: app },
        workflow: { route: '/.well-known/workflow/v1/flow', sdk: '4.0.0' },
        crons: [{ path: '/api/tick', schedule: '0 * * * *' }],
      }),
    );
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toStrictEqual([
      expect.stringMatching(/runs workflows/u),
      expect.stringMatching(/module called `metadata`/u),
    ]);
  });

  it('takes cron jobs, and says when they are sent with no secret', async () => {
    const dir = projectDir();
    const crons = [
      { path: '/api/tick', schedule: '0 * * * *' },
      { path: '/api/weekly', schedule: '0 9 * * 1' },
    ];
    writeBundle(dir, bundleOf(deployableFunction(dir), { crons }));
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toStrictEqual([]);
    expect(plan.warnings).toStrictEqual([expect.stringMatching(/CRON_SECRET is not among/u)]);

    const secret = await preflight({
      projectDir: dir,
      settings: SETTINGS,
      secrets: new Map([['CRON_SECRET', 's'.repeat(32)]]),
    });

    expect(secret.problems).toStrictEqual([]);
    expect(secret.warnings).toStrictEqual([]);
  });

  it('refuses an edge nothing would reach, and more Workers than an account holds', async () => {
    const dir = projectDir();
    writeBundle(dir, bundleOf(deployableFunction(dir)));
    const plan = await preflight({
      projectDir: dir,
      settings: { ...SETTINGS, workersDev: false, keep: 50 },
      secrets: NO_SECRETS,
    });

    expect(plan.problems).toStrictEqual([expect.stringMatching(/nothing would reach the edge/u)]);

    const split = projectDir();
    const app = deployableFunction(split);
    const names = Array.from({ length: 9 }, (_, index) => `app-${index + 2}`);
    const many = Object.fromEntries(names.map((name) => [name, app]));
    writeBundle(
      split,
      bundleOf(app, {
        v: 2,
        entrypoints: [
          { id: '/', kind: 'app-page', pathname: '/' },
          ...names.map((name) => {
            return {
              id: `/${name}`,
              kind: 'app-page' as const,
              pathname: `/${name}`,
              function: name,
            };
          }),
        ],
        functions: { app, split: many },
      }),
    );
    const crowded = await preflight({
      projectDir: split,
      settings: { ...SETTINGS, keep: 50 },
      secrets: NO_SECRETS,
    });

    expect(crowded.problems).toStrictEqual([
      expect.stringMatching(/over the 500 an account on Workers Paid may hold/u),
    ]);
  });

  it('warns of a project that signs users in with no secret in its environment', async () => {
    const dir = projectDir();
    mkdirSync(path.join(dir, 'app'));
    writeFileSync(path.join(dir, 'auth.ts'), 'export default {};');
    writeBundle(dir, bundleOf(deployableFunction(dir)));
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    // Its auth configuration may name a secret of its own, which only its code knows.
    expect(plan.problems).toStrictEqual([]);
    expect(plan.warnings).toStrictEqual([expect.stringMatching(/signs users in/u)]);

    const empty = await preflight({
      projectDir: dir,
      settings: SETTINGS,
      secrets: new Map([['AUTH_SECRET', '']]),
    });

    expect(empty.warnings).toStrictEqual([expect.stringMatching(/signs users in/u)]);

    const signed = await preflight({
      projectDir: dir,
      settings: SETTINGS,
      secrets: new Map([['AUTH_SECRET', 'x']]),
    });

    expect(signed.warnings).toStrictEqual([]);
  });

  it("refuses storage named as one of the host's own bindings", async () => {
    const dir = projectDir();
    writeBundle(dir, bundleOf(deployableFunction(dir)));
    const plan = await preflight({
      projectDir: dir,
      settings: {
        ...SETTINGS,
        storage: [
          { name: 'ARKOR_CACHE', kind: 'kv' },
          { name: 'UPWIND_KV', kind: 'kv' },
        ],
      },
      secrets: NO_SECRETS,
    });

    expect(plan.problems).toStrictEqual([
      expect.stringMatching(/^deploy\.storage names ARKOR_CACHE, which the host binds/u),
    ]);
  });

  it('says where to build when there is no build', async () => {
    const dir = projectDir();

    await expect(
      preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS }),
    ).rejects.toThrow(/build first/u);
  });
});
