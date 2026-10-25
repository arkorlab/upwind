import path from 'node:path';

import { UPWIND_CACHE_HOST_MODULE_ENV } from '@stayingupwind/core/paas';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheHostEnv } from '../../src/build/run.ts';
import { cacheHostEntry } from '../../src/deploy/shipped.ts';
import { ADAPTER_PATH_ENV } from '../../src/dev/adapter.ts';
import { ownVersion } from '../../src/manifest.ts';
import { projectWith } from '../deploy/project.ts';

/**
 * The runtime cache's host a build names to the project's own adapter: from this repository's
 * sources, the cache package's own module, named as it is.
 */

/** The adapter a project has installed, by the module its package resolves to. */
function adapterOf(dir: string): string {
  return path.join(dir, 'node_modules/@stayingupwind/adapter/index.js');
}

describe('the cache host `upwind build` names', () => {
  let project: string;
  let adapter: string;

  beforeAll(async () => {
    project = projectWith({ adapterVersion: await ownVersion() });
    adapter = adapterOf(project);
  });

  beforeEach(() => {
    vi.stubEnv(ADAPTER_PATH_ENV, '');
    vi.stubEnv(UPWIND_CACHE_HOST_MODULE_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the runtime cache's, for the project's own adapter", async () => {
    await expect(cacheHostEnv(project, adapter, {})).resolves.toStrictEqual({
      [UPWIND_CACHE_HOST_MODULE_ENV]: cacheHostEntry(),
      UPWIND_BUILD_CACHE_HOST_MODULE: cacheHostEntry(),
    });
  });

  it('is none, said, for an adapter of another version than this command', async () => {
    const other = projectWith({ adapterVersion: '0.0.1' });
    const warned = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    await expect(cacheHostEnv(other, adapterOf(other), {})).resolves.toStrictEqual({});
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('0.0.1 is installed, and this is upwind'),
    );

    warned.mockRestore();
  });

  it('is none where the build names no adapter, as on Vercel', async () => {
    await expect(cacheHostEnv(project, undefined, {})).resolves.toStrictEqual({});
  });

  it('is none for an adapter NEXT_ADAPTER_PATH names, which reads no environment', async () => {
    vi.stubEnv(ADAPTER_PATH_ENV, '/elsewhere/adapter.js');

    await expect(cacheHostEnv(project, '/elsewhere/adapter.js', {})).resolves.toStrictEqual({});
  });

  it('is none where the environment names one already', async () => {
    vi.stubEnv(UPWIND_CACHE_HOST_MODULE_ENV, '/own/host.js');

    await expect(cacheHostEnv(project, adapter, {})).resolves.toStrictEqual({});
  });

  it("is none where the run's environment names one", async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      [UPWIND_CACHE_HOST_MODULE_ENV]: '/own/host.js',
    };

    await expect(cacheHostEnv(project, adapter, { env })).resolves.toStrictEqual({});
  });

  it("is none where the run names one itself, as a deploy's build does", async () => {
    const extraEnv = { [UPWIND_CACHE_HOST_MODULE_ENV]: '/deploy/host.mjs' };

    await expect(cacheHostEnv(project, adapter, { extraEnv })).resolves.toStrictEqual({});
  });
});
