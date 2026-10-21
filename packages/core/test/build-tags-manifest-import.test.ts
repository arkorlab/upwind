import { describe, expect, it, vi } from 'vitest';

import { routeCacheSchema } from '../src/manifest/schema.ts';

vi.mock(import('../src/cache/schema.ts'), () => {
  throw new Error('a manifest must not initialize the complete cache schema module');
});

describe('manifest build tag initialization', () => {
  it('validates build membership without constructing the other cache schemas', () => {
    const cache = {
      entryId: 'entry',
      kind: 'app-page',
      delivery: 'complete',
      buildTags: [{ kind: 'next-explicit', value: 'posts' }],
    };

    expect(routeCacheSchema.parse(cache)).toStrictEqual(cache);
  });
});
