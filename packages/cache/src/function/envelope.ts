import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { decodeUtf8, releaseStream } from '@stayingupwind/core/util';
import { MAX_DATA_HANDLER_LENGTH, MAX_INLINE_DATA_VALUE_BYTES } from '@stayingupwind/host/cache';
import { CacheHostError } from '@stayingupwind/runtime/cache-host';

import { beginBody, type BodyRead, type ReadBudget, saidLength } from './read-budget.ts';

const KIB = 1024;
const MIB = KIB * KIB;
const BASE64_BYTES = 3;
const BASE64_CHARACTERS = 4;
const JSON_ESCAPE_BYTES = 6;
const METADATA_KIB = 16;
const RETURNED_RECORD_MIB = 4;
const FAILURE_KIB = 64;
/** Envelope fields and identifiers beside the separately bounded record/value and tags. */
const METADATA_BYTES = METADATA_KIB * KIB;
/**
 * A start or commit returns at most 4 MiB of record bytes (`scope/commit-record.ts`). Beside that,
 * allow the largest commit's full mebibyte for metadata, including a current redirect repeated
 * by a start, rather than assuming its JSON-escaped form fits an HTTP header's byte count.
 */
export const RECORD_ENVELOPE_BYTES =
  Math.ceil((RETURNED_RECORD_MIB * MIB) / BASE64_BYTES) * BASE64_CHARACTERS + MIB + METADATA_BYTES;
/** The inline value, every tag at its existing bound, its handler, and the remaining metadata. */
export const DATA_ENVELOPE_BYTES =
  Math.ceil(MAX_INLINE_DATA_VALUE_BYTES / BASE64_BYTES) * BASE64_CHARACTERS +
  JSON_ESCAPE_BYTES * (MAX_TAGS_PER_ENTRY * MAX_TAG_LENGTH + MAX_DATA_HANDLER_LENGTH) +
  METADATA_BYTES;
/** A gateway refusal has no record or value; an upstream's arbitrary error page is not its body. */
export const FAILURE_ENVELOPE_BYTES = FAILURE_KIB * KIB;
/**
 * Encoded bytes are also decoded and parsed into strings. Charge four times their size to the
 * shared read room, rather than treating JSON as a raw artifact. This weights the producers'
 * string-heavy envelopes; it is not a heap bound for arbitrary JSON structures or values callers
 * retain after this read. Even the largest record envelope fits without the room's capacity
 * clamp. Only an unknown-length custom or older transport reserves the route's maximum; native
 * fixed-length responses say their actual length.
 */
const JSON_READ_WEIGHT = 4;

function invalidEnvelope(response: Response): CacheHostError {
  return new CacheHostError('cache gateway envelope exceeds its length limit', {
    code: 'internal',
    status: response.status,
  });
}

/**
 * A bounded envelope, held in the Function's existing read room through parsing and validation.
 * Taking free room is synchronous; only pressure waits. A deadline belongs to the caller, so a
 * data read keeps its existing render deadline while a write's response can use a longer one.
 */
// eslint-disable-next-line max-params -- Keep the parse inside its body/room/signal owner without a per-read options object.
export async function withEnvelope<T>(
  response: Response,
  room: ReadBudget,
  limit: number,
  signal: AbortSignal,
  parse: (body: unknown) => T,
): Promise<T> {
  const expected = saidLength(response);
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected > limit)) {
    releaseStream(response.body, 'gateway envelope exceeds its route limit');
    throw invalidEnvelope(response);
  }
  const most = expected ?? limit;
  let release: () => void;
  try {
    signal.throwIfAborted();
    const bytes = (most + 1) * JSON_READ_WEIGHT;
    release = room.takeAtOnce(bytes) ?? (await room.take(bytes, signal));
  } catch (error) {
    releaseStream(response.body, 'gateway envelope abandoned before its body');
    throw error;
  }
  let reading: BodyRead | undefined;
  const abandoned = Promise.withResolvers<never>();
  let waiting = false;
  const abort = (): void => {
    releaseStream(reading?.reader ?? response.body, 'gateway envelope abandoned');
    // A synchronous adapter can abort while opening its reader, before the race is installed.
    if (waiting) abandoned.reject(signal.reason);
  };
  try {
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    if (response.body === null) {
      throw new SyntaxError('Unexpected end of JSON input');
    }
    reading = beginBody(response.body, most, 'gateway envelope');
    const completed = Promise.race([reading.pending, abandoned.promise]);
    waiting = true;
    if (signal.aborted) abort();
    const result = await completed;
    signal.throwIfAborted();
    const bytes = result instanceof Uint8Array ? result : (result.value ?? new Uint8Array());
    if (bytes.byteLength > most || (expected !== undefined && bytes.byteLength !== expected)) {
      throw invalidEnvelope(response);
    }
    return parse(JSON.parse(decodeUtf8(bytes)) as unknown);
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      reading?.reader.releaseLock();
    } finally {
      release();
    }
  }
}
