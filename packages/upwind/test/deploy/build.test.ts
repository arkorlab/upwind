import {
  UPWIND_CACHE_HOST_MODULE_ENV,
  UPWIND_UNSHIPPED_OUTPUTS_ENV,
} from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildOptions } from '../../src/build/args.ts';
import type { BuildRun } from '../../src/build/run.ts';
import { buildForDeploy, readBuildNote } from '../../src/deploy/build.ts';
import { runDeploy } from '../../src/deploy/command.ts';
import { cacheHostEntry } from '../../src/deploy/shipped.ts';
import { ownVersion } from '../../src/manifest.ts';
import { bundleOf, deployableFunction, projectDir, writeBundle } from './bundle.ts';
import { projectWith } from './project.ts';

/**
 * A deploy's build, with `next build` replaced by what it leaves behind: the bundle of the
 * deployment it was told to build, or — for an adapter that writes none — nothing at all.
 */
const builds = vi.hoisted(() => ({ runs: [] as BuildRun[], writes: true }));

vi.mock(import('../../src/build/run.ts'), async () => {
  const helpers = await import('./bundle.ts');
  return {
    spawnBuild: (options: BuildOptions, run?: BuildRun): Promise<number> => {
      builds.runs.push(run ?? {});
      const deploymentId = run?.extraEnv?.['NEXT_DEPLOYMENT_ID'];
      if (deploymentId !== undefined && builds.writes) {
        const app = helpers.deployableFunction(options.projectDir);
        helpers.writeBundle(options.projectDir, helpers.bundleOf(app, { deploymentId }));
      }
      return Promise.resolve(0);
    },
  };
});

async function project(): Promise<string> {
  const dir = projectDir();
  projectWith({ dir, adapterVersion: await ownVersion(), packageName: 'shop' });
  return dir;
}

describe("a deploy's build", () => {
  let errors: string[];

  beforeEach(() => {
    builds.runs = [];
    builds.writes = true;
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the deployment it chose, with the runtime cache's host in every Function", async () => {
    const dir = await project();
    const built = await buildForDeploy(dir);
    const deploymentId = 'deploymentId' in built ? built.deploymentId : undefined;

    expect(deploymentId).toMatch(/^dpl_/u);

    expect(builds.runs).toStrictEqual([
      {
        forDeploy: true,
        extraEnv: {
          NEXT_DEPLOYMENT_ID: deploymentId,
          [UPWIND_CACHE_HOST_MODULE_ENV]: cacheHostEntry(),
          [UPWIND_UNSHIPPED_OUTPUTS_ENV]: 'prefetch-segments',
        },
      },
    ]);
    await expect(readBuildNote(dir)).resolves.toMatchObject({ deploymentId });
  });

  it('vouches for no bundle the build did not write', async () => {
    const dir = await project();
    writeBundle(dir, bundleOf(deployableFunction(dir)));
    builds.writes = false;

    await expect(buildForDeploy(dir)).resolves.toStrictEqual({ exitCode: 1 });
    await expect(readBuildNote(dir)).resolves.toBeUndefined();
    expect(errors).toStrictEqual([
      expect.stringMatching(/the project's next\.config has to name/u),
    ]);
  });

  it('plans the deployment it built', async () => {
    const dir = await project();
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => {
      printed.push(text);
    });
    const options = {
      projectDir: dir,
      prebuilt: false,
      buildOnly: false,
      envFiles: [],
      keep: undefined,
      message: undefined,
      dryRun: true,
    };

    await expect(runDeploy(options, undefined)).resolves.toBe(0);

    const deploymentId = builds.runs[0]?.extraEnv?.['NEXT_DEPLOYMENT_ID'];

    expect(printed[0]).toBe(`upwind: shop, deployment ${String(deploymentId)}`);
    expect(errors).toStrictEqual([]);
  });
});
