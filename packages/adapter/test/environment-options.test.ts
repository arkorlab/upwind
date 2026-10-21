import { afterEach, describe, expect, it, vi } from 'vitest';

import { environmentOptions } from '../src/environment-options.ts';

describe("the default export's options", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are nothing outside a deploy', () => {
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', '');
    vi.stubEnv('UPWIND_UNSHIPPED_OUTPUTS', 'prefetch-segments');

    expect(environmentOptions()).toStrictEqual({});
  });

  it('are the cache host a deploy names, and what it leaves out of a Function beside it', () => {
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', '/project/.upwind/deploy/cache-host.mjs');

    expect(environmentOptions()).toStrictEqual({
      cacheHostModule: '/project/.upwind/deploy/cache-host.mjs',
    });

    vi.stubEnv('UPWIND_UNSHIPPED_OUTPUTS', 'prefetch-segments');

    expect(environmentOptions()).toStrictEqual({
      cacheHostModule: '/project/.upwind/deploy/cache-host.mjs',
      unshippedOutputs: 'prefetch-segments',
    });
  });
});
