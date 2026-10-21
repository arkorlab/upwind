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
  crons: 0,
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
    expect(plan.projectedWorkers).toBe(1 * 6 + 5);
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

  it('refuses crons, workflows and a module the upload keeps for itself', async () => {
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
      expect.stringMatching(/declares cron jobs/u),
      expect.stringMatching(/module called `metadata`/u),
    ]);
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
      expect.stringMatching(/over the 500 an account may hold/u),
    ]);
  });

  it('refuses a project that signs users in without its secret', async () => {
    const dir = projectDir();
    mkdirSync(path.join(dir, 'app'));
    writeFileSync(path.join(dir, 'auth.ts'), 'export default {};');
    writeBundle(dir, bundleOf(deployableFunction(dir)));
    const plan = await preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS });

    expect(plan.problems).toStrictEqual([expect.stringMatching(/signs users in/u)]);

    const signed = await preflight({
      projectDir: dir,
      settings: SETTINGS,
      secrets: new Map([['AUTH_SECRET', 'x']]),
    });

    expect(signed.problems).toStrictEqual([]);
  });

  it('says where to build when there is no build', async () => {
    const dir = projectDir();

    await expect(
      preflight({ projectDir: dir, settings: SETTINGS, secrets: NO_SECRETS }),
    ).rejects.toThrow(/build first/u);
  });
});
