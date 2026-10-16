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
  const keys = await Promise.all(
    [...new Set(values)].map(async (value) =>
      kvTagKey(scopeId, await tagIdFor(scopeId, tagKindOf(value), value)),
    ),
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
    for (const records of await Promise.all(batches)) {
      for (const value of records.values()) {
        if (value !== null) tags.push(tagDeltaEntrySchema.parse(value));
      }
    }
  }
  return { tags };
}
