import { MAX_TAG_LENGTH, MAX_TAGS_PER_CALL, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { ENTITY_SCHEMA_VERSION, invalidationRecordSchema } from '../src/cache/entities.ts';
import {
  answersTheRead,
  answersTheTags,
  dataGetRequestSchema,
  dataGetResponseSchema,
  dataSetRequestSchema,
  invalidateRequestSchema,
  invalidateResponseSchema,
  MAX_DATA_HANDLER_LENGTH,
  MAX_DATA_KEY_LENGTH,
  MAX_DELTA_PAGE_TAGS,
  tagDeltaEntrySchema,
  tagsDeltaResponseSchema,
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

describe("a data read's answer", () => {
  const useCache = { entry: entry('data:use-cache', 1) };
  const fetched = { entry: entry('data:fetch', 1) };

  it('is taken where it is of the namespace the read asked in', () => {
    expect(answersTheRead({ kind: 'data:use-cache', handler: 'default' }, useCache)).toBe(true);
    expect(answersTheRead({ kind: 'data:fetch' }, fetched)).toBe(true);
  });

  /** Kept as the value of the key the read asked for, it would be served as that one (Codex). */
  it("is refused where it is of another handler's, or of the other kind", () => {
    expect(answersTheRead({ kind: 'data:use-cache', handler: 'remote' }, useCache)).toBe(false);
    expect(answersTheRead({ kind: 'data:fetch' }, useCache)).toBe(false);
    expect(answersTheRead({ kind: 'data:use-cache', handler: 'default' }, fetched)).toBe(false);
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

  /** Of some of the tags asked about, or none: a tag with no record was never invalidated. */
  it('is taken where it speaks of the tags asked about', () => {
    expect(answersTheTags(['a', 'b'], { tags: [tagRecord('b')] })).toBe(true);
    expect(answersTheTags(['a', 'b'], { tags: [] })).toBe(true);
  });

  /**
   * Its reader takes a record for the tag the record names, and every tag it asked about as read:
   * one of a tag not asked about would leave the one asked about held as invalidated by nothing
   * (Codex).
   */
  it('is refused where it speaks of a tag not asked about', () => {
    expect(answersTheTags(['a'], { tags: [tagRecord('b')] })).toBe(false);
    expect(answersTheTags(['a'], { tags: [tagRecord('a'), tagRecord('A')] })).toBe(false);
  });
});

/** A page of the delta holding `count` records, with more to follow. */
function deltaPage(count: number) {
  return { revision: 1, floor: 0, truncated: true, ...tagsAnswer(count) };
}

describe('a page of the delta', () => {
  it.each([
    { truncated: false, tagRevision: 11, historyRevision: 5, accepted: false },
    { truncated: false, tagRevision: 10, historyRevision: 11, accepted: false },
    { truncated: true, tagRevision: 10, historyRevision: 11, accepted: false },
    { truncated: false, tagRevision: 7, historyRevision: 8, accepted: false },
    { truncated: false, tagRevision: 7, historyRevision: 5, accepted: true },
    { truncated: true, tagRevision: 10, historyRevision: 10, accepted: true },
  ])('bounds tag and historical revisions by its cursor: %j', (example) => {
    const page = {
      revision: 10,
      floor: 0,
      truncated: example.truncated,
      tags: [
        {
          ...tagRecord('posts'),
          revision: example.tagRevision,
          history: [{ revision: example.historyRevision, staleAt: 1, hardExpireAt: null }],
        },
      ],
    };

    expect(tagsDeltaResponseSchema.safeParse(page).success).toBe(example.accepted);
  });

  it('holds as many records as a reader may ask a page for', () => {
    expect(tagsDeltaResponseSchema.safeParse(deltaPage(MAX_DELTA_PAGE_TAGS)).success).toBe(true);
  });

  /** One revision goes whole, however few were asked for: one invalidation's tags at the most. */
  it('holds the tags of one invalidation whole', () => {
    expect(MAX_TAGS_PER_CALL).toBeLessThanOrEqual(MAX_DELTA_PAGE_TAGS);
  });

  /** The rest of a longer delta is the next page's (`truncated`). */
  it('holds no more records than a reader may ask a page for', () => {
    expect(tagsDeltaResponseSchema.safeParse(deltaPage(MAX_DELTA_PAGE_TAGS + 1)).success).toBe(
      false,
    );
  });

  /**
   * One with more to follow stands at the last revision whose tags it holds: one that stood past
   * them, or held none, would have its reader stand past invalidations it never heard of, however
   * it stood to the latest it reports (Codex). The last page stands at the scope's
   * revision, which a write moves as an invalidation does, and so past its tags.
   */
  it('stands at the last revision whose tags it holds while more follow', () => {
    const tags = [
      { ...tagRecord('a'), revision: 3 },
      { ...tagRecord('b'), revision: 5 },
    ];
    const page = {
      revision: 5,
      floor: 0,
      truncated: true,
      tags,
      latest: { revision: 9, invalidatedAt: 1 },
    };

    expect(tagsDeltaResponseSchema.safeParse(page).success).toBe(true);
    expect(tagsDeltaResponseSchema.safeParse({ ...page, revision: 9 }).success).toBe(false);
    expect(tagsDeltaResponseSchema.safeParse({ ...page, revision: 4 }).success).toBe(false);
    expect(tagsDeltaResponseSchema.safeParse({ ...page, tags: [] }).success).toBe(false);
    expect(
      tagsDeltaResponseSchema.safeParse({ ...page, revision: 9, truncated: false }).success,
    ).toBe(true);
  });
});

describe("a tag's record in a delta or a tag read", () => {
  /** What a runtime keeps each one under, as a key of its tag cache. */
  it('names a tag no longer than an invalidation may', () => {
    const longest = 't'.repeat(MAX_TAG_LENGTH);

    expect(tagDeltaEntrySchema.safeParse(tagRecord(longest)).success).toBe(true);
    expect(tagDeltaEntrySchema.safeParse(tagRecord(`${longest}t`)).success).toBe(false);
    expect(tagsGetResponseSchema.safeParse({ tags: [tagRecord(`${longest}t`)] }).success).toBe(
      false,
    );
  });
});

const REVALIDATED = { source: 'app-worker', api: 'revalidateTag' } as const;

/** An invalidation of one tag, stale for `expire` seconds. */
function invalidationOf(expire: number) {
  return { tags: [{ value: 'posts' }], expire, cause: REVALIDATED };
}

describe("an invalidation's window", () => {
  /** A `cacheLife` profile's `expire`, which Next.js takes in seconds, whole or not. */
  it('is any number of seconds a profile can give, and none below zero', () => {
    expect(invalidateRequestSchema.safeParse(invalidationOf(1.5)).success).toBe(true);
    expect(invalidateRequestSchema.safeParse(invalidationOf(0.0001)).success).toBe(true);
    expect(invalidateRequestSchema.safeParse(invalidationOf(-0.5)).success).toBe(false);
  });

  it('is recorded as it was asked for', () => {
    const recorded = {
      invalidationId: 'inv_1',
      scopeId: 'dpl_1',
      revision: 2,
      target: { kind: 'tag', id: 'tag_1', value: 'posts' },
      staleAt: 1000,
      hardExpireAt: 2500,
      meaning: 'swr',
      expireSeconds: 1.5,
      cause: REVALIDATED,
      recordedAt: 1000,
      schemaVersion: ENTITY_SCHEMA_VERSION,
    };

    expect(invalidationRecordSchema.safeParse(recorded).success).toBe(true);
  });
});

/** What an invalidation of a tag came to, as the authority answers it. */
function invalidationResult(value: string) {
  return {
    invalidationId: `inv_${value}`,
    tagId: `tag_${value}`,
    value,
    staleAt: 1,
    hardExpireAt: null,
    meaning: 'immediate',
  };
}

/** An invalidation's answer holding `count` results: the authority's holds one for each tag. */
function invalidationAnswer(count: number) {
  return {
    revision: 1,
    invalidations: Array.from({ length: count }, (_, index) => invalidationResult(`tag-${index}`)),
    affectedEntryIds: [],
  };
}

describe("an invalidation's answer", () => {
  it('holds a result for each tag an invalidation may name', () => {
    expect(invalidateResponseSchema.safeParse(invalidationAnswer(MAX_TAGS_PER_CALL)).success).toBe(
      true,
    );
  });

  /** A result for each tag the invalidation named at the most, which none names more of. */
  it('holds no more results than an invalidation may name tags', () => {
    expect(
      invalidateResponseSchema.safeParse(invalidationAnswer(MAX_TAGS_PER_CALL + 1)).success,
    ).toBe(false);
  });
});
