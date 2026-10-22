import { kvTagKey, tagIdFor, tagKindOf } from '@stayingupwind/core/cache';
import { tagDeltaEntrySchema, type TagsGetResponse } from '@stayingupwind/host/cache';

/** Match the delivery record's regional propagation window; no authority binding is needed. */
const CACHE_TTL_SECONDS = 30;
const MAX_BULK_KEYS = 100;
const BULK_READ_CONCURRENCY = 2;

export async function readTagRecords(
  kv: KVNamespace,
  scopeId: string,
  values: readonly string[],
): Promise<TagsGetResponse> {
  const requested = new Map<string, string>();
  const keys = await Promise.all(
    [...new Set(values)].map(async (value) => {
      const key = kvTagKey(scopeId, await tagIdFor(scopeId, tagKindOf(value), value));
      requested.set(key, value);
      return key;
    }),
  );
  const tags: TagsGetResponse['tags'] = [];
  // One Next.js tag list can exceed KV's 100-key bulk limit. Start its independent reads together
  // so the second batch costs no additional round trip against the Function's read deadline.
  const batchKeys = MAX_BULK_KEYS * BULK_READ_CONCURRENCY;
  for (let offset = 0; offset < keys.length; offset += batchKeys) {
    const batches = [];
    for (
      let start = offset;
      start < Math.min(offset + batchKeys, keys.length);
      start += MAX_BULK_KEYS
    ) {
      batches.push(
        kv.get(keys.slice(start, start + MAX_BULK_KEYS), {
          type: 'json',
          cacheTtl: CACHE_TTL_SECONDS,
        }),
      );
    }
    const results = await Promise.all(batches);
    for (const records of results) {
      for (const [key, value] of records) {
        if (value !== null) tags.push(tagAtKey(scopeId, key, requested, value));
      }
    }
  }
  return { tags };
}

/** A missing record is meaningful, so a wrong record must fail the whole read, never be omitted. */
function tagAtKey(
  scopeId: string,
  key: string,
  requested: ReadonlyMap<string, string>,
  value: unknown,
): TagsGetResponse['tags'][number] {
  const tag = tagDeltaEntrySchema.parse(value);
  if (requested.get(key) !== tag.value || kvTagKey(scopeId, tag.tagId) !== key) {
    throw new Error('the tag record does not match its requested key');
  }
  return tag;
}
