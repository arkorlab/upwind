import { describe, expect, it } from 'vitest';

import { computeRscCacheBustingParam } from '../src/request/rsc.ts';

// Vectors generated with next@16.3.5 `computeCacheBustingSearchParam`.
describe('computeRscCacheBustingParam', () => {
  it('matches the Next.js implementation', async () => {
    await expect(
      computeRscCacheBustingParam({ prefetch: '1', segmentPrefetch: '/_tree' }),
    ).resolves.toBe('_i_aeImnuN6u1u1r');
    await expect(computeRscCacheBustingParam({ prefetch: '1' })).resolves.toBe('HEAvJdHAQJrUAe2K');
    await expect(
      computeRscCacheBustingParam({
        stateTree: '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D',
      }),
    ).resolves.toBe('_YfTnOtw-Fvq5Ybl');
    await expect(
      computeRscCacheBustingParam({
        prefetch: '2',
        segmentPrefetch: '/blog/[slug]/__PAGE__',
        stateTree: 'tree',
        nextUrl: '/from',
      }),
    ).resolves.toBe('gjw_1Y7A-9rKuIp0');
  });

  it('returns an empty value when only defaults are present', async () => {
    await expect(computeRscCacheBustingParam({})).resolves.toBe('');
    await expect(computeRscCacheBustingParam({ prefetch: '0' })).resolves.toBe('');
  });
});
