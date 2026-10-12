import { kvTagKey, tagIdFor, tagKindOf } from '@stayingupwind/core/cache';
import { tagDeltaEntrySchema, type TagsGetResponse } from '@stayingupwind/host/cache';

/** Match the delivery record's regional propagation window; no authority binding is needed. */
const CACHE_TTL_SECONDS = 30;
const MAX_BULK_KEYS = 100;

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
  // Workers KV bulk get accepts at most 100 keys per operation.
  for (let offset = 0; offset < keys.length; offset += MAX_BULK_KEYS) {
    const records = await kv.get(keys.slice(offset, offset + MAX_BULK_KEYS), {
      type: 'json',
      cacheTtl: CACHE_TTL_SECONDS,
    });
    for (const value of records.values()) {
      if (value !== null) tags.push(tagDeltaEntrySchema.parse(value));
    }
  }
  return { tags };
}
