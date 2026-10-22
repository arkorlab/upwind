import {
  MAX_PACK_BYTES,
  MAX_PACK_HEADER_BYTES,
  PACK_SCHEMA_VERSION,
} from '@stayingupwind/core/cache';
import { concatBytes, decodeUtf8, encodeUtf8, releaseStream } from '@stayingupwind/core/util';

import type { GiveBack } from '../isolate-room.ts';
import { BODY_ROOM_BYTES, takeBodyRoom, tryBodyRoom } from './body-room.ts';

/**
 * A delivery record as either gateway answers it: as KV sends it, never read in whole first.
 *
 * One isolate of a gateway answers the reads of every deployment that reaches it, and a record may
 * be as long as a KV value, 25 MiB: a few read whole at once would take more than the isolate
 * holds, and fail every read it was answering besides. So only the record's start is read in — its
 * prefix and its header, `MAX_PACK_HEADER_BYTES` at the most — for the length the header says the
 * record comes to, which the answer says (`content-length`), as a Function takes room for it by
 * before reading it whole (`ReadBudget`); the rest goes on as KV sends it, held to that length. A
 * value whose start says no length this gateway can read — no record, or one of another layout —
 * is read whole in the gateway's shared body room and answered as it is, for the Function to judge.
 * Native byte streams bound the initial read itself. Non-byte adapter streams reserve the same
 * body room synchronously before their first read; pressure fails that read without a new wait.
 */

/** The regional cache the edge reads with; a record changes at most this long after it is written. */
const RECORD_CACHE_TTL_SECONDS = 30;
/** The same pressure wait as a gateway write taking room for its body. */
const LEGACY_ROOM_WAIT_MS = 10_000;
/** What a record is laid out with ahead of its header (`encodeGenerationPack`). */
const MAGIC = encodeUtf8('PPRG');
const VERSION_AT = MAGIC.byteLength;
const HEADER_LENGTH_AT = VERSION_AT + 1;
const HEADER_LENGTH_BYTES = 4;
const PREFIX_LENGTH = HEADER_LENGTH_AT + HEADER_LENGTH_BYTES;
/** A usual header fits one small read; this is a buffer size, not a record acceptance limit. */
const FIRST_READ_BYTES = 4096;

/** A record to answer with: its bytes, or a stream of them, and how many there are. */
export interface RecordAnswer {
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
  readonly byteLength: number;
}

/** What has been read of a value from its first byte, and whether that was all of it. */
interface Start {
  readonly bytes: Uint8Array;
  readonly done: boolean;
}

const NOTHING_READ: Start = { bytes: new Uint8Array(0), done: false };

/** Read on from `start` until `length` bytes are in, or the value has ended. */
async function readTo(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  start: Start,
  length: number,
): Promise<Start> {
  const chunks = [start.bytes];
  let read = start.bytes.byteLength;
  while (read < length) {
    const next = await reader.read();
    if (next.done) {
      return { bytes: concatBytes(chunks), done: true };
    }
    chunks.push(next.value);
    read += next.value.byteLength;
  }
  return { bytes: concatBytes(chunks), done: false };
}

/** A byte reader never accepts an arbitrarily large producer chunk into the header buffer. */
function byteReaderOf(value: ReadableStream<Uint8Array>): ReadableStreamBYOBReader | undefined {
  try {
    return value.getReader({ mode: 'byob' });
  } catch {
    // Adapter streams may not be byte streams. They reserve whole-body room before any read.
    return undefined;
  }
}

/** A native BYOB EOF can return its transferred view together with done. */
interface ByteRead {
  readonly value?: Uint8Array<ArrayBuffer> | undefined;
  readonly done: boolean;
}

/**
 * Read only into this owned buffer. BYOB transfers it on every read, so each returned view's
 * buffer becomes the next view; bytes already written before its offset survive the transfer.
 */
async function readBounded(
  reader: ReadableStreamBYOBReader,
  start: Start,
  length: number,
  capacity = length,
): Promise<Start> {
  if (start.done || start.bytes.byteLength >= length) return start;
  let bytes = new Uint8Array(capacity);
  bytes.set(start.bytes);
  let read = start.bytes.byteLength;
  while (read < length) {
    const view = bytes.subarray(read);
    const minimum = length - read;
    const atLeast = typeof reader.readAtLeast === 'function';
    const next: ByteRead = atLeast
      ? await reader.readAtLeast(minimum, view)
      : await reader.read(view);
    // A conforming BYOB reader returns a view even at EOF, including a zero-length one.
    if (next.value === undefined) throw new Error('the record byte reader returned no view');
    read += next.value.byteLength;
    // Keep the whole owned backing store, including the prefix before the returned view's offset.
    // eslint-disable-next-line unicorn/no-unsafe-buffer-conversion -- BYOB transfers the whole owned buffer, including the earlier prefix.
    bytes = new Uint8Array(next.value.buffer, 0, next.value.buffer.byteLength);
    if (bytes.byteLength < read) throw new Error('the record byte reader lost its prefix');
    // Workers readAtLeast returns a short view only at EOF, possibly with done still false.
    if (next.done || (atLeast && next.value.byteLength < minimum)) {
      return { bytes: bytes.subarray(0, read), done: true };
    }
    if (read < length && bytes.byteLength < capacity) {
      const expanded = new Uint8Array(capacity);
      expanded.set(bytes);
      bytes = expanded;
    }
  }
  return { bytes: bytes.subarray(0, read), done: false };
}

/** The prefix and header, bounded for byte streams and reserved before reading for adapters. */
async function recordStart(
  reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader,
): Promise<{ readonly start: Start; readonly headerLength: number | undefined }> {
  const bounded = reader instanceof ReadableStreamBYOBReader;
  let start = bounded
    ? await readBounded(reader, NOTHING_READ, PREFIX_LENGTH, FIRST_READ_BYTES)
    : await readTo(reader, NOTHING_READ, PREFIX_LENGTH);
  const headerLength = headerLengthOf(start.bytes);
  if (
    headerLength !== undefined &&
    !start.done &&
    start.bytes.byteLength < PREFIX_LENGTH + headerLength
  ) {
    const length = PREFIX_LENGTH + headerLength;
    start = bounded
      ? await readBounded(reader, start, length)
      : await readTo(reader, start, length);
  }
  return { start, headerLength };
}

/** How long the header is that the record's prefix names, or `undefined` for no prefix of one. */
function headerLengthOf(prefix: Uint8Array): number | undefined {
  if (prefix.byteLength < PREFIX_LENGTH || prefix[VERSION_AT] !== PACK_SCHEMA_VERSION) {
    return undefined;
  }
  if (MAGIC.some((byte, at) => prefix[at] !== byte)) {
    return undefined;
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, PREFIX_LENGTH);
  const length = view.getUint32(HEADER_LENGTH_AT, true);
  return length > MAX_PACK_HEADER_BYTES ? undefined : length;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The length the record's header says it comes to, or `undefined` where the header says none. */
function recordLengthOf(
  start: Uint8Array,
  headerLength: number | undefined,
  expectedScopeId: string,
  expectedEntryId: string,
): number | undefined {
  if (headerLength === undefined) return undefined;
  let header: unknown;
  try {
    header = JSON.parse(decodeUtf8(start.subarray(PREFIX_LENGTH, PREFIX_LENGTH + headerLength)));
  } catch {
    return undefined;
  }
  if (typeof header !== 'object' || header === null) {
    return undefined;
  }
  const { scopeId, entryId, htmlLength, postponedLength } = header as Readonly<
    Record<string, unknown>
  >;
  if (!isCount(htmlLength) || !isCount(postponedLength)) {
    return undefined;
  }
  // This header is already read for its length. Its identity must also name the key requested:
  // valid bytes stored under another entry's key are not that entry's delivery record.
  if (scopeId !== expectedScopeId || entryId !== expectedEntryId) {
    throw new Error('the delivery record does not belong to the requested scope and entry');
  }
  // Past what one KV value holds, it is no record's: read whole, it is whatever KV holds.
  const length = PREFIX_LENGTH + headerLength + htmlLength + postponedLength;
  return length > MAX_PACK_BYTES ? undefined : length;
}

/**
 * The bytes read, then the rest of `value` as KV sends it, into a stream held to the length the
 * answer says (`FixedLengthStream`): a value that ends short of it or runs past it errors the
 * answer, rather than go out as a record it is not. Behind the response, which a Worker keeps
 * running while its body is read.
 */
async function sendOn(
  start: Uint8Array,
  value: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  giveBack: GiveBack | undefined,
): Promise<void> {
  try {
    const writer = writable.getWriter();
    try {
      await writer.write(start);
    } catch (error) {
      releaseStream(value, 'the record was not read on');
      throw error;
    } finally {
      writer.releaseLock();
    }
    await value.pipeTo(writable);
  } finally {
    giveBack?.();
  }
}

/** An unknown KV length takes the whole pool; a value already ended needs only its bytes. */
function legacyRoom(start: Start): GiveBack | Promise<GiveBack | undefined> {
  return takeBodyRoom(start.done ? start.bytes.byteLength : BODY_ROOM_BYTES, LEGACY_ROOM_WAIT_MS);
}

/** The buffered compatibility value owns its room until its response is sent or cancelled. */
async function sendBuffered(
  bytes: Uint8Array,
  writable: WritableStream<Uint8Array>,
  giveBack: GiveBack,
): Promise<void> {
  try {
    const writer = writable.getWriter();
    try {
      await writer.write(bytes);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  } finally {
    giveBack();
  }
}

function bufferedAnswer(bytes: Uint8Array, giveBack: GiveBack): RecordAnswer {
  const { readable, writable } = new FixedLengthStream(bytes.byteLength);
  void sendBuffered(bytes, writable, giveBack).catch(() => {
    // Cancelling/discarding the response rejects its write; its finally returns the room.
  });
  return { body: readable, byteLength: bytes.byteLength };
}

/** The record KV holds under `key`, to answer with; `undefined` where it holds none. */
export async function readRecordAnswer(
  kv: KVNamespace,
  key: string,
  scopeId: string,
  entryId: string,
): Promise<RecordAnswer | undefined> {
  const value: ReadableStream<Uint8Array> | null = await kv.get(key, {
    type: 'stream',
    cacheTtl: RECORD_CACHE_TTL_SECONDS,
  });
  if (value === null) {
    return undefined;
  }
  const byteReader = byteReaderOf(value);
  let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader =
    byteReader ?? value.getReader();
  let reserved: GiveBack | undefined;
  try {
    if (byteReader === undefined) {
      // An adapter's first chunk may hold the whole value. Pressure is a read failure now,
      // before pulling any bytes, rather than an extra foreground wait holding those bytes.
      reserved = tryBodyRoom(BODY_ROOM_BYTES);
      if (reserved === undefined) throw new Error('no room for the delivery record read');
    }
    const { start, headerLength } = await recordStart(reader);
    const byteLength = recordLengthOf(start.bytes, headerLength, scopeId, entryId);
    if (
      byteLength === undefined ||
      byteLength < start.bytes.byteLength ||
      (start.done && byteLength !== start.bytes.byteLength)
    ) {
      // Native unknown layouts retain the existing compatibility wait. Adapter streams already
      // own the same room; neither path adds an accepted record size limit.
      const claim = reserved ?? legacyRoom(start);
      reserved = typeof claim === 'function' ? claim : await claim;
      if (reserved === undefined) throw new Error('no room for the delivery record read');
      if (reader instanceof ReadableStreamBYOBReader) {
        reader.releaseLock();
        reader = value.getReader();
      }
      const whole = start.done ? start : await readTo(reader, start, Infinity);
      reader.releaseLock();
      const answer = bufferedAnswer(whole.bytes, reserved);
      reserved = undefined;
      return answer;
    }
    const { readable, writable } = new FixedLengthStream(byteLength);
    reader.releaseLock();
    void sendOn(start.bytes, value, writable, reserved).catch(() => {
      // Whichever side failed has taken the other with it; the send's finally returns adapter room.
    });
    reserved = undefined;
    return { body: readable, byteLength };
  } catch (error) {
    reserved?.();
    releaseStream(reader, 'the record could not be read');
    throw error;
  }
}

/** Let go of a record not answered with: the rest of it is not read. */
export function dropRecordAnswer(record: RecordAnswer | undefined): void {
  if (record?.body instanceof ReadableStream) {
    releaseStream(record.body, 'the record was not answered with');
  }
}

/** A parallel read failed: let go of the record whenever its own read finishes. */
export function dropRecordWhenRead(reading: Promise<RecordAnswer | undefined>): void {
  void reading.then(dropRecordAnswer).catch(() => {
    // A failed record read releases its own stream.
  });
}

/** The answer of a record: what a Function reads it whole in room for, said before it is sent. */
export function recordResponse(record: RecordAnswer): Response {
  return new Response(record.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(record.byteLength),
      'cache-control': 'private, no-store',
    },
  });
}
