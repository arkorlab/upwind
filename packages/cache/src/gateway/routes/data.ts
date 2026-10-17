import { sha256Hex } from '@stayingupwind/core/artifact';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { fromBase64 } from '@stayingupwind/core/util';
import {
  currentDataRequestSchema,
  type DataEntryMetadata,
  dataGetRequestSchema,
  dataSetRequestSchema,
  MAX_DATA_HANDLER_LENGTH,
  MAX_DATA_KEY_LENGTH,
  MAX_INLINE_DATA_VALUE_BYTES,
} from '@stayingupwind/host/cache';
import { safeParseBounded } from '@stayingupwind/host/util';
import { Hono } from 'hono';

import { createLogger, detailOf } from '../../logger.ts';
import { dataUploadKey } from '../../scope/data-uploads.ts';
import type { WriteOrder } from '../../scope/data.ts';
import { isRefusal } from '../../scope/state.ts';
import { serverTiming, Timing } from '../../scope/timing.ts';
import {
  answerScope,
  type GatewayContext,
  type GatewayEnv,
  meterWrite,
  refuseRetired,
  retiredScope,
} from '../auth.ts';
import {
  ENTRY_BODY_BYTES,
  JSON_BYTES_PER_CODE_UNIT,
  readJson,
  readRequest,
  refuseMismatch,
} from '../body.ts';
import { dataGetResponseOf, dataReadBytes, readDataRecord } from '../read-data.ts';
import { fail, ok } from '../respond.ts';

/**
 * The data caches. A value is stored by content before the authority records it, so the record
 * only ever names bytes that exist; a read is answered from KV without the authority, from the
 * record the authority wrote — its storage key stripped, the value inline or by reference. A read
 * of the value the key holds now (`/data/current`) is answered by the authority itself.
 */

const OCTET_STREAM = 'application/octet-stream';
const logger = createLogger({ component: 'gateway' });
const KIB = 1024;
/** Base64 writes every three bytes as four characters. */
const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARACTERS = 4;
/** The rest of a `PUT /data` body: its field names, the kind, the coverage and a few numbers. */
const OTHER_FIELDS_KIB = 4;
/**
 * The largest value whose bytes travel to the scope's object with its write, for the write's settle
 * to make the value's record of (`DataSetInput.bytes`). The object holds them for as long as the
 * write is under way — behind the settles queued before its own — and every write a burst sends it
 * holds its own at once: so they are kept small, and a larger value that still travels inside its
 * record (`MAX_INLINE_DATA_VALUE_BYTES`) is read back from storage by its settle, as before.
 */
const CARRIED_VALUE_KIB = 64;
const CARRIED_VALUE_BYTES = Math.min(CARRIED_VALUE_KIB * KIB, MAX_INLINE_DATA_VALUE_BYTES);
const OTHER_FIELDS_BYTES = OTHER_FIELDS_KIB * KIB;
/**
 * What a `PUT /data` body holds beside its value's base64, at most: the key, the handler's name and
 * every tag at their bounds, however JSON escaped them, and the rest of the metadata.
 */
const BESIDE_VALUE_BYTES =
  JSON_BYTES_PER_CODE_UNIT *
    (MAX_DATA_KEY_LENGTH + MAX_DATA_HANDLER_LENGTH + MAX_TAGS_PER_ENTRY * MAX_TAG_LENGTH) +
  OTHER_FIELDS_BYTES;

/**
 * The largest body a value of `maxBytes` can travel in, written as the contract says
 * (`dataSetRequestSchema`): its base64 at a byte a character, as `JSON.stringify` writes it, and
 * the key, the handler and the tags at the longest escape, since any character of theirs may need
 * one. Nothing in the base64 alphabet needs one, and making room for every escape JSON allows in it
 * (`\u002f`, six bytes a slash) would read six times as far before anything is parsed — past
 * what the isolate holds, for the largest value.
 */
export function maxSetBodyBytes(maxBytes: number): number {
  const base64 = Math.ceil(maxBytes / BASE64_GROUP_BYTES) * BASE64_GROUP_CHARACTERS;
  return base64 + BESIDE_VALUE_BYTES;
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    return fromBase64(value);
  } catch {
    return undefined;
  }
}

async function removeUnusedUpload(c: GatewayContext, storageRef: string): Promise<void> {
  try {
    await c.env.ARTIFACTS.delete(storageRef);
  } catch (error) {
    logger.warn('unused data upload cleanup failed', {
      scopeId: c.get('scopeId'),
      detail: detailOf(error),
    });
  }
}

interface SetRequest {
  readonly key: string;
  readonly entry: DataEntryMetadata;
  readonly bytes: Uint8Array;
  readonly order?: WriteOrder | undefined;
}

/**
 * What a `PUT /data` asks to store, or why it cannot be taken.
 *
 * The largest value the gateway takes, sent as the contract says, makes the largest body a request
 * can need, so the body is read no further than that before any of it is parsed. It is parsed once,
 * and the value decoded into bytes allocated once; only those, the key and the metadata are handed
 * back, since the base64 is a third larger than the value itself and nothing after this needs it.
 * A body the schema refuses is refused without its issues past a few KiB, as every other is.
 */
async function readSetRequest(c: GatewayContext, maxBytes: number): Promise<SetRequest | Response> {
  const tooLarge = `a value may hold at most ${maxBytes} bytes, its base64 sent as JSON.stringify writes it`;
  const body = await readJson(c, maxSetBodyBytes(maxBytes), tooLarge);
  if (body instanceof Response) {
    return body;
  }
  const parsed = safeParseBounded(dataSetRequestSchema, body.json, body.length);
  if (!parsed.success) {
    return refuseMismatch(c, parsed.error);
  }
  const bytes = decodeBase64(parsed.data.valueBase64);
  if (bytes === undefined) {
    return fail(c, 'invalid_request', 'the value is not base64');
  }
  if (bytes.byteLength > maxBytes) {
    return fail(c, 'too_large', tooLarge);
  }
  return {
    key: parsed.data.key,
    entry: parsed.data.entry,
    bytes,
    ...(parsed.data.order !== undefined && { order: parsed.data.order }),
  };
}

async function setValue(c: GatewayContext): Promise<Response> {
  // How long each part of the write takes, here and in the scope's object: said on its answer
  // (`Server-Timing`), so that where a write's time goes can be read where it is made.
  const timing = new Timing();
  // The one change that waits for the marker: it stores its bytes before the authority answers,
  // and what it stored for a scope retention has erased nothing would ever sweep, should the
  // removal after the refusal fail.
  const retired = await retiredScope(c);
  timing.lap('retired');
  if (retired) {
    return refuseRetired(c);
  }
  const request = await readSetRequest(c, c.get('vars').MAX_ARTIFACT_BYTES);
  if (request instanceof Response) {
    return request;
  }
  timing.lap('read');
  const { bytes } = request;
  const sha256 = await sha256Hex(bytes);
  timing.lap('hash');
  // A request may delete only its own upload. Content deduplication is decided atomically by
  // the authority, so a rejected writer can never remove another generation's bytes.
  const storageRef = dataUploadKey(c.get('scopeId'), sha256, c.get('now'));
  await c.env.ARTIFACTS.put(storageRef, bytes as BufferSource, {
    httpMetadata: { contentType: OCTET_STREAM },
  });
  timing.lap('upload');
  // An RPC failure can lose an already committed reply. Leave uncertain uploads for the
  // authority's orphan sweep, which checks references before deleting them. A small value travels
  // with the write as well (`CARRIED_VALUE_BYTES`): its settle makes the record of these bytes rather
  // than read back from storage what was stored just above.
  const outcome = await c.get('scope').setData(
    {
      key: request.key,
      entry: request.entry,
      value: { sha256, byteLength: bytes.byteLength, contentType: OCTET_STREAM, storageRef },
      ...(request.order !== undefined && { order: request.order }),
      ...(bytes.byteLength <= CARRIED_VALUE_BYTES && { bytes }),
    },
    c.get('now'),
  );
  timing.lap('scope');
  if (isRefusal(outcome) || outcome.retainedStorageRef !== storageRef) {
    // Adoption is complete. Removing this request's unused upload must not delay its response.
    c.executionCtx.waitUntil(removeUnusedUpload(c, storageRef));
  }
  if (isRefusal(outcome)) return answerScope(c, outcome);
  if (outcome.metered !== undefined) {
    meterWrite(c, outcome.metered);
  }
  const parts = [serverTiming(timing.parts), serverTiming(outcome.timing ?? [], 'scope-')];
  c.header('server-timing', parts.filter((part) => part !== '').join(', '));
  // Storage references, what was metered and how long the parts took are internal to this
  // gateway and the authority: the timing goes on the answer's header, not in its body.
  return ok(c, {
    entryId: outcome.entryId,
    generationId: outcome.generationId,
    revision: outcome.revision,
    ...(outcome.invalidation !== undefined && { invalidation: outcome.invalidation }),
    ...(outcome.superseded === true && { superseded: true }),
  });
}

async function getValue(c: GatewayContext): Promise<Response> {
  const request = await readRequest(c, dataGetRequestSchema, ENTRY_BODY_BYTES);
  if (request instanceof Response) {
    return request;
  }
  const [record, retired] = await Promise.all([
    readDataRecord(c.env.CACHE_STATE, c.get('scopeId'), request),
    retiredScope(c),
  ]);
  if (retired) {
    return refuseRetired(c);
  }
  if (record === undefined) {
    return fail(c, 'not_found', 'no record for the key');
  }
  c.get('host').meter.read(c.get('scopeId'), dataReadBytes(record));
  return ok(c, record);
}

/**
 * The value the key holds now, as the authority holds it rather than as KV last answered with it:
 * what a Function asks where the value it read was stale or expired, and its data center held none
 * later (`getNewerData`). A data center reads KV through a cache of its own for half a minute, so a
 * value another data center wrote meanwhile is read nowhere else but here, and each data center
 * would compute it again. Answered as a read of KV is, and metered as one; with none where the key
 * holds nothing later than the value the Function read (`than`), whose value is then not read.
 */
async function getCurrentValue(c: GatewayContext): Promise<Response> {
  const request = await readRequest(c, currentDataRequestSchema, ENTRY_BODY_BYTES);
  if (request instanceof Response) {
    return request;
  }
  const [record, retired] = await Promise.all([
    c.get('scope').currentData(request),
    retiredScope(c),
  ]);
  if (retired) {
    return refuseRetired(c);
  }
  if (record === undefined) {
    return fail(c, 'not_found', 'no value for the key');
  }
  const answer = dataGetResponseOf(record);
  c.get('host').meter.read(c.get('scopeId'), dataReadBytes(answer));
  return ok(c, answer);
}

export const dataRoutes = new Hono<GatewayEnv>()
  // Not `zValidator`: it parses whatever arrives before anything has measured it.
  .put('/data', (c) => setValue(c))
  .post('/data/get', (c) => getValue(c))
  .post('/data/current', (c) => getCurrentValue(c));
