import { MAX_TAGS_PER_CALL, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import {
  dataGetRequestSchema,
  dataGetResponseSchema,
  dataSetRequestSchema,
  MAX_DATA_HANDLER_LENGTH,
  MAX_DATA_KEY_LENGTH,
} from '../src/cache/gateway-contract.ts';

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

describe('a data read', () => {
  const read = {
    key: 'k'.repeat(MAX_DATA_KEY_LENGTH),
    kind: 'data:use-cache',
    handler: 'h'.repeat(MAX_DATA_HANDLER_LENGTH),
  };

  it('names a key and a handler as long as a write may', () => {
    expect(dataGetRequestSchema.safeParse(read).success).toBe(true);
  });

  /** Nothing is stored under a longer one, so a read of it has nothing to find. */
  it('names no key or handler longer than a write may', () => {
    const longKey = { ...read, key: `${read.key}k` };
    const longHandler = { ...read, handler: `${read.handler}h` };

    expect(dataSetRequestSchema.safeParse({ ...useCacheWrite(), key: longKey.key }).success).toBe(
      false,
    );
    expect(dataGetRequestSchema.safeParse(longKey).success).toBe(false);
    expect(dataGetRequestSchema.safeParse(longHandler).success).toBe(false);
  });
});

function useCacheWrite() {
  return { key: 'key', entry: entry('data:use-cache', 1), valueBase64: '' };
}
