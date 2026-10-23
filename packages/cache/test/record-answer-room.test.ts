import { sha256Hex } from '@stayingupwind/core/artifact';
import { encodeGenerationPack, kvGenerationKey, policyFromBuild } from '@stayingupwind/core/cache';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { signCacheToken } from '@stayingupwind/host/cache';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BODY_ROOM_BYTES,
  tryBodyRoom,
  UNCOUNTED_BODY_BYTES,
  withBodyRoom,
} from '../src/gateway/body-room.ts';
import {
  dropRecordAnswer,
  dropRecordWhenRead,
  readRecordAnswer,
  type RecordAnswer,
  recordResponse,
} from '../src/gateway/record-answer.ts';
import { createReadGateway } from '../src/read-gateway.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

const WAIT_MS = 10_000;
const PREFIX = encodeUtf8('old-layout');
const TAIL = encodeUtf8(' legacy delivery bytes');
const WHOLE = concatBytes([PREFIX, TAIL]);

function legacy() {
  const tailRead = vi.fn();
  const cancelled = vi.fn();
  const stream = new ReadableStream(
    {
      type: 'bytes',
      start(controller) {
        controller.enqueue(new Uint8Array(PREFIX));
      },
      pull(controller) {
        tailRead();
        controller.enqueue(new Uint8Array(TAIL));
        controller.close();
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  return { stream, tailRead, cancelled };
}

function records(values: Map<string, ReadableStream<Uint8Array>>) {
  const kv: {
    get(
      key: string,
      options: { type: 'stream'; cacheTtl?: number },
    ): Promise<ReadableStream<Uint8Array> | null>;
  } = env.CACHE_STATE;
  return vi.spyOn(kv, 'get').mockImplementation((key) => Promise.resolve(values.get(key) ?? null));
}

async function holdingWrite() {
  const entered = Promise.withResolvers<undefined>();
  const done = Promise.withResolvers<undefined>();
  const writing = withBodyRoom(
    BODY_ROOM_BYTES,
    WAIT_MS,
    async () => {
      entered.resolve(undefined);
      await done.promise;
      return 'write';
    },
    () => 'refused',
  );
  await entered.promise;
  return { done, writing };
}

async function currentBytes(
  scopeId = 'scope',
  body = TAIL,
  headers: Readonly<Record<string, string>> = {},
  schemaVersion: 1 | 2 = 1,
): Promise<Uint8Array> {
  return encodeGenerationPack(
    {
      schemaVersion,
      scopeId,
      entryId: 'entry',
      generationId: 'generation',
      seq: 1,
      revision: 1,
      source: 'build',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: 100,
      producedAt: 100,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html', ...headers },
      tags: [],
      htmlSha256: await sha256Hex(body),
      htmlLength: body.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    body,
    undefined,
  );
}

function responseOf(answer: RecordAnswer | undefined): Response {
  if (answer === undefined) throw new Error('the record was missing');
  return recordResponse(answer);
}

function streamReaderOf(answer: RecordAnswer | undefined): ReadableStreamDefaultReader<Uint8Array> {
  if (answer === undefined || answer.body instanceof Uint8Array) {
    throw new TypeError('the record answer has no stream');
  }
  return answer.body.getReader();
}

async function remainingBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return concatBytes(chunks);
    chunks.push(next.value);
  }
}

async function nativeBytes(kind: string, scopeId: string): Promise<Uint8Array> {
  switch (kind) {
    case 'current': {
      return currentBytes(scopeId);
    }
    case 'empty': {
      return new Uint8Array();
    }
    case 'fragment': {
      return encodeUtf8('PPR');
    }
    case 'legacy': {
      return new Uint8Array(1024 * 1024).fill(97);
    }
    case 'older': {
      return encodeUtf8('PPRG-pre-current-layout');
    }
    default: {
      return encodeUtf8('{malformed record');
    }
  }
}

describe('room for unrecognized delivery record bytes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits for existing write room before buffering a legacy tail', async () => {
    vi.useFakeTimers();
    const value = legacy();
    records(new Map([['legacy', value.stream]]));
    const write = await holdingWrite();
    const reading = readRecordAnswer(env.CACHE_STATE, 'legacy', 'scope', 'entry');
    try {
      await vi.advanceTimersByTimeAsync(0);

      expect(value.tailRead).not.toHaveBeenCalled();
    } finally {
      write.done.resolve(undefined);
      await write.writing;
      await vi.advanceTimersByTimeAsync(20);
      const answer = await reading;
      if (answer !== undefined) await recordResponse(answer).arrayBuffer();
    }
  });

  it('holds room until an unread legacy response is discarded', async () => {
    vi.useFakeTimers();
    const value = legacy();
    records(new Map([['legacy', value.stream]]));
    const answer = await readRecordAnswer(env.CACHE_STATE, 'legacy', 'scope', 'entry');
    const made = vi.fn(() => Promise.resolve('write'));
    const writing = withBodyRoom(BODY_ROOM_BYTES, WAIT_MS, made, () => 'refused');
    try {
      await vi.advanceTimersByTimeAsync(0);

      expect(made).not.toHaveBeenCalled();
    } finally {
      dropRecordAnswer(answer);
      await vi.advanceTimersByTimeAsync(20);
      await writing;
    }

    expect(made).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent legacy buffering through body consumption', async () => {
    vi.useFakeTimers();
    const first = legacy();
    const second = legacy();
    records(
      new Map([
        ['first', first.stream],
        ['second', second.stream],
      ]),
    );
    const answer = await readRecordAnswer(env.CACHE_STATE, 'first', 'scope', 'entry');
    const reading = readRecordAnswer(env.CACHE_STATE, 'second', 'scope', 'entry');
    try {
      await vi.advanceTimersByTimeAsync(0);

      expect(second.tailRead).not.toHaveBeenCalled();
    } finally {
      const response = responseOf(answer);

      expect(response.headers.get('content-length')).toBe(String(WHOLE.byteLength));
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(WHOLE);

      await vi.advanceTimersByTimeAsync(20);
      const next = await reading;

      expect(new Uint8Array(await responseOf(next).arrayBuffer())).toStrictEqual(WHOLE);
    }
  });

  it.each(['legacy', 'older', 'malformed', 'empty', 'fragment', 'current'])(
    'keeps actual KV %s bytes, length and gateway metering exact',
    async (kind) => {
      const scopeId = `legacy_${kind}`;
      const bytes = await nativeBytes(kind, scopeId);
      const entryId = 'entry';
      await env.CACHE_STATE.put(kvGenerationKey(scopeId, entryId), bytes);
      const read = vi.fn<(scopeId: string, bytes: number) => void>();
      const host = { ...STANDALONE_AUTHORITY, meter: { ...STANDALONE_AUTHORITY.meter, read } };
      const token = await signCacheToken(env.CACHE_TOKEN_KEY ?? '', scopeId, host.naming);
      const gateway = createReadGateway(host);
      const response = await gateway.fetch(
        new Request(`https://cache.invalid/v1/scopes/${scopeId}/entries/${entryId}/record`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
        createExecutionContext(),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));

      const actual = await response.arrayBuffer();

      expect(new DataView(actual)).toStrictEqual(
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
      expect(read).toHaveBeenCalledExactlyOnceWith(scopeId, bytes.byteLength);
    },
  );

  it.each([1, 2] as const)(
    'keeps version-%i streaming independent of occupied body room',
    async (version) => {
      const bytes = await currentBytes('scope', TAIL, {}, version);
      await env.CACHE_STATE.put('current', bytes);
      vi.useFakeTimers();
      const write = await holdingWrite();
      try {
        const answer = await readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry');

        expect(answer?.body).toBeInstanceOf(ReadableStream);

        expect(new Uint8Array(await responseOf(answer).arrayBuffer())).toStrictEqual(bytes);
      } finally {
        write.done.resolve(undefined);
        await write.writing;
      }
    },
  );

  it('bounds the first response chunk when one producer chunk contains a large current record', async () => {
    const bytes = await currentBytes('scope', new Uint8Array(1024 * 1024).fill(97));
    const stream = new ReadableStream({
      type: 'bytes',
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    records(new Map([['current', stream]]));
    const answer = await readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry');
    const response = responseOf(answer);
    const reader = streamReaderOf(answer);
    const first = await reader.read();
    let rest: Uint8Array;
    try {
      rest = await remainingBytes(reader);
    } finally {
      reader.releaseLock();
    }
    const served = concatBytes([first.value ?? new Uint8Array(), rest]);
    const [actualDigest, expectedDigest] = await Promise.all([sha256Hex(served), sha256Hex(bytes)]);

    expect(first.value?.byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(served.byteLength).toBe(bytes.byteLength);
    expect(actualDigest).toBe(expectedDigest);
  });

  it('answers a header larger than the first buffer before its gated body arrives', async () => {
    const bytes = await currentBytes('scope', TAIL, { 'x-padding': 'a'.repeat(8 * 1024) });
    const headerEnd = 9 + new DataView(bytes.buffer, bytes.byteOffset, 9).getUint32(5, true);
    const body = Promise.withResolvers<true>();
    const tailRead = vi.fn();
    const stream = new ReadableStream(
      {
        type: 'bytes',
        start(controller) {
          controller.enqueue(bytes.slice(0, headerEnd));
        },
        async pull(controller) {
          tailRead();
          await body.promise;
          controller.enqueue(bytes.slice(headerEnd));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    records(new Map([['current', stream]]));
    let answer: RecordAnswer | undefined;
    try {
      answer = await readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry');

      expect(answer?.byteLength).toBe(bytes.byteLength);
      expect(tailRead).not.toHaveBeenCalled();
    } finally {
      body.resolve(true);
      const actual = await responseOf(answer).arrayBuffer();

      expect(new Uint8Array(actual)).toStrictEqual(bytes);
    }
  });

  it('rejects a non-byte stream under pressure without pulling or waiting, then reads its retry', async () => {
    const bytes = await currentBytes();
    const pulled = vi.fn();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled();
          controller.enqueue(bytes);
          controller.close();
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    const values = new Map([['current', stream]]);
    records(values);
    vi.useFakeTimers();
    const write = await holdingWrite();
    try {
      await expect(readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry')).rejects.toThrow(
        'no room for the delivery record read',
      );
      expect(pulled).not.toHaveBeenCalled();
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      write.done.resolve(undefined);
      await write.writing;
    }
    values.set(
      'current',
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
    const answer = await readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry');

    expect(new Uint8Array(await responseOf(answer).arrayBuffer())).toStrictEqual(bytes);
  });

  it('holds non-byte current room through sending and returns it on discard', async () => {
    const bytes = await currentBytes();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel: cancelled,
    });
    records(new Map([['current', stream]]));
    vi.useFakeTimers();
    const answer = await readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry');
    const competing = tryBodyRoom(BODY_ROOM_BYTES);
    try {
      expect(competing).toBeUndefined();
    } finally {
      competing?.();
      dropRecordAnswer(answer);
      await vi.advanceTimersByTimeAsync(0);
    }
    const giveBack = tryBodyRoom(BODY_ROOM_BYTES);
    try {
      expect(giveBack).toBeTypeOf('function');
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      giveBack?.();
    }
  });

  it('returns non-byte current room after its streamed body errors', async () => {
    const bytes = await currentBytes();
    const headerEnd = 9 + new DataView(bytes.buffer, bytes.byteOffset, 9).getUint32(5, true);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(bytes.subarray(0, headerEnd));
        },
        pull() {
          throw new Error('current body failed');
        },
      },
      { highWaterMark: 0 },
    );
    records(new Map([['current', stream]]));
    const answer = await readRecordAnswer(env.CACHE_STATE, 'current', 'scope', 'entry');

    await expect(responseOf(answer).arrayBuffer()).rejects.toThrow('current body failed');

    const giveBack = tryBodyRoom(BODY_ROOM_BYTES);
    try {
      expect(giveBack).toBeTypeOf('function');
    } finally {
      giveBack?.();
    }
  });

  it('keeps the selected small-write bypass while a legacy body holds room', async () => {
    vi.useFakeTimers();
    records(new Map([['legacy', legacy().stream]]));
    const answer = await readRecordAnswer(env.CACHE_STATE, 'legacy', 'scope', 'entry');
    const made = vi.fn(() => Promise.resolve('small'));
    try {
      await expect(
        withBodyRoom(UNCOUNTED_BODY_BYTES, WAIT_MS, made, () => 'refused'),
      ).resolves.toBe('small');
      expect(made).toHaveBeenCalledTimes(1);
    } finally {
      dropRecordAnswer(answer);
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('returns the reservation after a legacy body read fails', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(PREFIX);
        },
        pull() {
          throw new Error('legacy read failed');
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    records(new Map([['legacy', stream]]));

    await expect(readRecordAnswer(env.CACHE_STATE, 'legacy', 'scope', 'entry')).rejects.toThrow(
      'legacy read failed',
    );
    await expect(
      withBodyRoom(
        BODY_ROOM_BYTES,
        WAIT_MS,
        () => Promise.resolve('next'),
        () => 'refused',
      ),
    ).resolves.toBe('next');
  });

  it('releases a legacy prefix when the existing pressure wait expires', async () => {
    vi.useFakeTimers();
    const value = legacy();
    records(new Map([['legacy', value.stream]]));
    const write = await holdingWrite();
    const reading = (async () => {
      try {
        return await readRecordAnswer(env.CACHE_STATE, 'legacy', 'scope', 'entry');
      } catch (error) {
        return error;
      }
    })();
    try {
      await vi.advanceTimersByTimeAsync(WAIT_MS + 1);

      await expect(reading).resolves.toBeInstanceOf(Error);
      expect(value.tailRead).not.toHaveBeenCalled();
      expect(value.cancelled).toHaveBeenCalledTimes(1);
    } finally {
      write.done.resolve(undefined);
      await write.writing;
    }
  });

  it('returns room when a parallel failure discards a late legacy answer', async () => {
    vi.useFakeTimers();
    records(new Map([['legacy', legacy().stream]]));
    const write = await holdingWrite();
    const reading = readRecordAnswer(env.CACHE_STATE, 'legacy', 'scope', 'entry');
    dropRecordWhenRead(reading);
    write.done.resolve(undefined);
    await write.writing;
    await vi.advanceTimersByTimeAsync(20);
    await reading;
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      withBodyRoom(
        BODY_ROOM_BYTES,
        WAIT_MS,
        () => Promise.resolve('next'),
        () => 'refused',
      ),
    ).resolves.toBe('next');
  });
});
