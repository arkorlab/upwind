import { describe, expect, it } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';

const names = { copyCache: 'publication-test', copyKeyOrigin: 'https://cache.test' };

describe('publication host configuration', () => {
  it('refuses to silently discard a sealed publication requirement when cache bindings are absent', () => {
    const create = cacheHostFor(names, {
      publication: { version: 1, identities: ['a'.repeat(64)], routes: ['/'] },
    });

    expect(() => create({ env: {} })).toThrow('requires its configured cache host');
  });

  it('keeps the existing optional-cache behavior without publication requirements', () => {
    expect(cacheHostFor(names)({ env: {} })).toBeUndefined();
  });
});
