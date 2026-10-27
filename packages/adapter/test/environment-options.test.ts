import { afterEach, describe, expect, it, vi } from 'vitest';

import { environmentOptions } from '../src/environment-options.ts';

const MIB = 1024 * 1024;
const HOST = '/project/.upwind/deploy/cache-host.mjs';
/** What a build beside a named host leaves to its reader unless told otherwise. */
const OVER_LIMIT = { minBytes: MIB, maxBytes: 32 * MIB, when: 'over-limit' };

describe("the default export's options", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are nothing outside a deploy', () => {
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', '');
    vi.stubEnv('UPWIND_UNSHIPPED_OUTPUTS', 'prefetch-segments');
    vi.stubEnv('UPWIND_UNSHIPPED_PRERENDER_BODIES', 'large');

    expect(environmentOptions()).toStrictEqual({});
  });

  it('are the cache host a deploy names, and what it leaves out of a Function beside it', () => {
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', HOST);

    expect(environmentOptions()).toStrictEqual({
      cacheHostModule: HOST,
      unshippedPrerenderBodies: OVER_LIMIT,
    });

    vi.stubEnv('UPWIND_UNSHIPPED_OUTPUTS', 'prefetch-segments');

    expect(environmentOptions()).toStrictEqual({
      cacheHostModule: HOST,
      unshippedOutputs: 'prefetch-segments',
      unshippedPrerenderBodies: OVER_LIMIT,
    });
  });

  it.each([
    { asked: 'auto', bodies: OVER_LIMIT },
    { asked: '', bodies: OVER_LIMIT },
    { asked: 'large', bodies: { minBytes: MIB, maxBytes: 32 * MIB } },
    { asked: 'none', bodies: undefined },
  ])('leave the page bodies $asked says to the host beside it', ({ asked, bodies }) => {
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', HOST);
    vi.stubEnv('UPWIND_UNSHIPPED_PRERENDER_BODIES', asked);

    expect(environmentOptions()).toStrictEqual({
      cacheHostModule: HOST,
      ...(bodies !== undefined && { unshippedPrerenderBodies: bodies }),
    });
  });

  it('refuse a page-body setting they do not know rather than take it for one they do', () => {
    vi.stubEnv('UPWIND_CACHE_HOST_MODULE', HOST);
    vi.stubEnv('UPWIND_UNSHIPPED_PRERENDER_BODIES', 'over-limit');

    expect(() => environmentOptions()).toThrow(
      'UPWIND_UNSHIPPED_PRERENDER_BODIES must be auto, large or none, not "over-limit"',
    );
  });
});
