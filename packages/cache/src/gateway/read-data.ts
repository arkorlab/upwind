import { cacheKeyDigestOf, kvDataKey } from '@stayingupwind/core/cache';
import { type DataGetRequest, type DataGetResponse } from '@stayingupwind/host/cache';

import { type DataRecord, dataRecordSchema } from '../scope/records.ts';

/** The same projection, read locally by either gateway; no authority call is needed. */
const RECORD_CACHE_TTL_SECONDS = 30;

export async function readDataRecord(
  kv: KVNamespace,
  scopeId: string,
  request: DataGetRequest,
): Promise<DataGetResponse | undefined> {
  const digest = await cacheKeyDigestOf(request);
  const stored = await kv.get(kvDataKey(scopeId, digest), {
    type: 'json',
    cacheTtl: RECORD_CACHE_TTL_SECONDS,
  });
  const record = dataRecordSchema.safeParse(stored);
  return record.success ? dataGetResponseOf(record.data) : undefined;
}

/** What a read of the data cache is answered with of a record: its storage key stays here. */
export function dataGetResponseOf(data: DataRecord): DataGetResponse {
  return {
    entryId: data.entryId,
    generationId: data.generationId,
    dependencyRevision: data.dependencyRevision,
    entry: data.entry,
    value:
      data.value.kind === 'inline'
        ? { kind: 'inline', base64: data.value.base64 }
        : { kind: 'ref', artifactId: data.value.artifactId },
    ...(data.invalidation !== undefined && { invalidation: data.invalidation }),
  };
}

/** Base64 writes every three bytes as four characters, and pads the last group with `=`. */
const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARACTERS = 4;

function base64ByteLength(base64: string): number {
  let padding = 0;
  if (base64.endsWith('==')) {
    padding = 2;
  } else if (base64.endsWith('=')) {
    padding = 1;
  }
  return Math.floor((base64.length * BASE64_GROUP_BYTES) / BASE64_GROUP_CHARACTERS) - padding;
}

/**
 * The bytes a data read answered with, as a host's meter is told them (`CacheMeter`): an inline
 * value's own; for a value stored apart, none of the value's — the record says only where it is.
 * The read is told all the same, with no bytes; the value's bytes are told when the artifact is
 * read, which is a read of its own.
 */
export function dataReadBytes(record: DataGetResponse): number {
  return record.value.kind === 'inline' ? base64ByteLength(record.value.base64) : 0;
}
