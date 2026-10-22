import { describe, expect, it } from 'vitest';

import { createAdapter } from '../src/index.ts';

const RANGE = { minBytes: 8, maxBytes: 16 };
const HOST_MODULE = '/host/cache.ts';
const HOST_ERROR = 'unshippedPrerenderBodies requires a nonempty cacheHostModule';

describe('completed page body adapter options', () => {
  it('rejects a configured range without a host module at adapter creation', () => {
    expect(() => createAdapter({ unshippedPrerenderBodies: RANGE })).toThrow(HOST_ERROR);
  });

  it.each(['', ' \t\n '])('rejects a blank host module: %j', (cacheHostModule) => {
    expect(() => createAdapter({ unshippedPrerenderBodies: RANGE, cacheHostModule })).toThrow(
      HOST_ERROR,
    );
  });

  it('validates the byte range before requiring its host module', () => {
    expect(() =>
      createAdapter({ unshippedPrerenderBodies: { minBytes: 0, maxBytes: RANGE.maxBytes } }),
    ).toThrow('unshippedPrerenderBodies requires positive integer minBytes <= maxBytes');
  });

  it('keeps the default adapter available without a host module', () => {
    expect(createAdapter().name).toBe('upwind');
  });

  it('accepts an explicitly absent range without a host module', () => {
    expect(createAdapter({ unshippedPrerenderBodies: undefined }).name).toBe('upwind');
  });

  it('accepts a configured range with its host module', () => {
    expect(
      createAdapter({ unshippedPrerenderBodies: RANGE, cacheHostModule: HOST_MODULE }).name,
    ).toBe('upwind');
  });

  it('keeps the existing prefetch-segments option independent of this guard', () => {
    expect(createAdapter({ unshippedOutputs: 'prefetch-segments' }).name).toBe('upwind');
  });

  it('rejects a range left to the limit without a host module, as any range', () => {
    expect(() =>
      createAdapter({ unshippedPrerenderBodies: { ...RANGE, when: 'over-limit' } }),
    ).toThrow(HOST_ERROR);
  });

  it.each(['always', 'over-limit'] as const)('accepts when: %s with its host module', (when) => {
    expect(
      createAdapter({
        unshippedPrerenderBodies: { ...RANGE, when },
        cacheHostModule: HOST_MODULE,
      }).name,
    ).toBe('upwind');
  });

  it.each(['', 'overLimit', 'never', null])('rejects an unknown when: %j', (when) => {
    const range = { ...RANGE, when } as unknown as typeof RANGE;

    expect(() =>
      createAdapter({ unshippedPrerenderBodies: range, cacheHostModule: HOST_MODULE }),
    ).toThrow("unshippedPrerenderBodies.when must be 'always' or 'over-limit'");
  });
});
