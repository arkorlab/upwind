import { describe, expect, it } from 'vitest';

import { spawnBuild } from '../../src/build/run.ts';

describe('native build target environment', () => {
  it('refuses a Workers deploy selected as native by its inherited build environment', async () => {
    await expect(
      spawnBuild(
        { projectDir: process.cwd() },
        {
          env: { UPWIND_BUILD_TARGET: 'node' },
          forDeploy: true,
        },
      ),
    ).rejects.toThrow('native Node artifact');
  });
});
