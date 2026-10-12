import { MAX_TAGS_PER_CALL, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { dataGetResponseSchema, dataSetRequestSchema } from '../src/cache/gateway-contract.ts';

function entry(kind: 'data:fetch' | 'data:use-cache', count: number) {
  return {
    kind,
    handler: 'default',
    tags: Array.from({ length: count }, (_, index) => `tag-${index}`),
    stale: 300,
    timestamp: 1,
    expire: 900,
    revalidate: 60,
    dependencyCoverage: 'complete',
  };
}

describe('data-cache tag bounds', () => {
  it.each([
    ['data:fetch', MAX_TAGS_PER_CALL],
    ['data:use-cache', MAX_TAGS_PER_ENTRY],
  ] as const)('round-trips %s at its bound and refuses metadata beyond it', (kind, limit) => {
    const metadata = entry(kind, limit);
    const write = { key: 'key', entry: metadata, valueBase64: '' };
    const read = {
      entryId: 'ent_1',
      generationId: 'gen_1',
      dependencyRevision: 1,
      entry: metadata,
      value: { kind: 'inline', base64: '' },
    };

    expect(dataSetRequestSchema.safeParse(write).success).toBe(true);
    expect(dataGetResponseSchema.safeParse(read).success).toBe(true);
    expect(
      dataSetRequestSchema.safeParse({ ...write, entry: entry(kind, limit + 1) }).success,
    ).toBe(false);
    expect(
      dataGetResponseSchema.safeParse({ ...read, entry: entry(kind, limit + 1) }).success,
    ).toBe(false);
  });
});
