import { UPWIND_CACHE_HOST_MODULE_ENV } from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheHostEnv } from '../../src/build/run.ts';
import { cacheHostEntry } from '../../src/deploy/shipped.ts';
import { ADAPTER_PATH_ENV } from '../../src/dev/adapter.ts';

/**
 * The runtime cache's host a build names to the project's own adapter: from this repository's
 * sources, the cache package's own module, named as it is.
 */

const PROJECT = '/project';
const ADAPTER = '/project/node_modules/@stayingupwind/adapter/dist/index.js';

describe('the cache host `upwind build` names', () => {
  beforeEach(() => {
    vi.stubEnv(ADAPTER_PATH_ENV, '');
    vi.stubEnv(UPWIND_CACHE_HOST_MODULE_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the runtime cache's, for the project's own adapter", async () => {
    await expect(cacheHostEnv(PROJECT, ADAPTER, {})).resolves.toStrictEqual({
      [UPWIND_CACHE_HOST_MODULE_ENV]: cacheHostEntry(),
    });
  });

  it('is none where the build names no adapter, as on Vercel', async () => {
    await expect(cacheHostEnv(PROJECT, undefined, {})).resolves.toStrictEqual({});
  });

  it('is none for an adapter NEXT_ADAPTER_PATH names, which reads no environment', async () => {
    vi.stubEnv(ADAPTER_PATH_ENV, '/elsewhere/adapter.js');

    await expect(cacheHostEnv(PROJECT, '/elsewhere/adapter.js', {})).resolves.toStrictEqual({});
  });

  it('is none where the environment names one already', async () => {
    vi.stubEnv(UPWIND_CACHE_HOST_MODULE_ENV, '/own/host.js');

    await expect(cacheHostEnv(PROJECT, ADAPTER, {})).resolves.toStrictEqual({});
  });

  it("is none where the run's environment names one", async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      [UPWIND_CACHE_HOST_MODULE_ENV]: '/own/host.js',
    };

    await expect(cacheHostEnv(PROJECT, ADAPTER, { env })).resolves.toStrictEqual({});
  });

  it("is none where the run names one itself, as a deploy's build does", async () => {
    const extraEnv = { [UPWIND_CACHE_HOST_MODULE_ENV]: '/deploy/host.mjs' };

    await expect(cacheHostEnv(PROJECT, ADAPTER, { extraEnv })).resolves.toStrictEqual({});
  });
});
