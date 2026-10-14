import { MAX_TAGS_PER_CALL, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import {
  dataGetRequestSchema,
  dataGetResponseSchema,
  dataSetRequestSchema,
  MAX_DATA_HANDLER_LENGTH,
  MAX_DATA_KEY_LENGTH,
  tagsGetResponseSchema,
} from '../src/cache/gateway-contract.ts';

/** An entry's metadata: a `use cache` entry's under the handler that made it, a fetch entry's under none. */
function entry(kind: 'data:fetch' | 'data:use-cache', count: number) {
  return {
    kind,
    ...(kind === 'data:use-cache' && { handler: 'default' }),
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

describe("a data entry's handler", () => {
  const { handler, ...unnamed } = entry('data:use-cache', 1);
  const fetched = entry('data:fetch', 1);

  it('is named by a use-cache entry, and by no fetch entry', () => {
    expect(dataSetRequestSchema.safeParse({ ...useCacheWrite(), entry: fetched }).success).toBe(
      true,
    );
    expect(dataGetRequestSchema.safeParse({ key: 'key', kind: 'data:fetch' }).success).toBe(true);
    expect(
      dataGetRequestSchema.safeParse({ key: 'key', kind: 'data:use-cache', handler }).success,
    ).toBe(true);
  });

  /** Left out, every handler's values would be one namespace; given, one no runtime reads. */
  it.each([
    ['a use-cache entry that names none', unnamed, { key: 'key', kind: 'data:use-cache' }],
    [
      'a fetch entry that names one',
      { ...fetched, handler },
      { key: 'key', kind: 'data:fetch', handler },
    ],
  ] as const)('is refused for %s', (_, metadata, request) => {
    const read = { entryId: 'ent_1', generationId: 'gen_1', dependencyRevision: 1 };

    expect(dataSetRequestSchema.safeParse({ ...useCacheWrite(), entry: metadata }).success).toBe(
      false,
    );
    expect(
      dataGetResponseSchema.safeParse({
        ...read,
        entry: metadata,
        value: { kind: 'inline', base64: '' },
      }).success,
    ).toBe(false);
    expect(dataGetRequestSchema.safeParse(request).success).toBe(false);
  });
});

/** A tag's record as the gateway answers a tag read or a delta with it. */
function tagRecord(value: string) {
  return {
    tagId: `tag_${value}`,
    kind: 'next-explicit',
    value,
    revision: 1,
    staleAt: 1,
    hardExpireAt: null,
    meaning: 'immediate',
  };
}

/** A tag read's answer holding `count` records. */
function tagsAnswer(count: number) {
  return { tags: Array.from({ length: count }, (_, index) => tagRecord(`tag-${index}`)) };
}

describe("a tag read's answer", () => {
  it('holds a record for each tag a read may name', () => {
    expect(tagsGetResponseSchema.safeParse(tagsAnswer(MAX_TAGS_PER_CALL)).success).toBe(true);
  });

  /** A record for each tag the read named at the most, which no read names more of. */
  it('holds no more records than a read may name tags', () => {
    expect(tagsGetResponseSchema.safeParse(tagsAnswer(MAX_TAGS_PER_CALL + 1)).success).toBe(false);
  });
});
