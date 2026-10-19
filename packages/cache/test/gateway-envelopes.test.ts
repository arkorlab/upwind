import { deriveEntry, MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';
import { encodeUtf8, isDeadlineError, toBase64 } from '@stayingupwind/core/util';
import {
  type CommitRequest,
  type DataGetRequest,
  type DataGetResponse,
  dataGetResponseSchema,
  MAX_DATA_HANDLER_LENGTH,
  MAX_INLINE_DATA_VALUE_BYTES,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DATA_ENVELOPE_BYTES,
  FAILURE_ENVELOPE_BYTES,
  RECORD_ENVELOPE_BYTES,
} from '../src/function/envelope.ts';
import { Gateway } from '../src/function/gateway.ts';
import { FUNCTION_READ_BYTES, functionReadBudget } from '../src/function/read-budget.ts';

const SCOPE = 'scope_envelope_room';
const ENTRY = { kind: 'app-page', route: '/', pathname: '/' } as const;
const DATA = { kind: 'data:use-cache', handler: 'remote', key: 'value' } as const;
const MIB = 1024 * 1024;
const RECORD_BYTES = 4 * MIB;
const CHUNK = 64 * 1024;
const UNKNOWN = { kind: 'unknown' } as const;

type RecordMethod = 'start' | 'commit';

function gateway(send: FetchLike, nearby = false): Gateway {
  return new Gateway({
    scopeId: SCOPE,
    gatewayUrl: 'https://authority.example',
    token: 'scope-token',
    naming: { copyCache: 'envelope-copies', copyKeyOrigin: 'https://copies.example' },
    fetchImpl: send,
    ...(nearby && { readGatewayUrl: 'https://read.example', readFetchImpl: send }),
  });
}

function commitRequest(): CommitRequest {
  return {
    fencingToken: 1,
    observedTagRevision: 0,
    generation: {
      cacheTimestamp: 1,
      producedAt: 1,
      policy: {
        revalidateAfter: UNKNOWN,
        expireAfter: UNKNOWN,
        clientStale: UNKNOWN,
        source: 'runtime-output',
      },
      status: 200,
      headers: {},
      tags: [],
      outputs: [
        {
          representationKey: 'html',
          pathname: '/',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: null,
          artifacts: [],
        },
      ],
      dependencies: [],
      dependencyCoverage: 'complete',
    },
  };
}

function recordCall(subject: Gateway, method: RecordMethod) {
  return method === 'start'
    ? subject.startAttempt({ entry: ENTRY, reason: 'miss' })
    : subject.commit('attempt', commitRequest());
}

async function startResult(record?: string, location?: string) {
  const { entryId } = await deriveEntry(SCOPE, ENTRY);
  return {
    kind: 'leased',
    entryId,
    attemptId: 'attempt',
    fencingToken: 1,
    dependencyRevision: 0,
    leaseExpiresAt: 10_000,
    current:
      location === undefined
        ? null
        : {
            generationId: 'previous-generation',
            seq: 1,
            cacheTimestamp: 1,
            policy: commitRequest().generation.policy,
            condemned: null,
            status: 302,
            location,
          },
    ...(record !== undefined && { record }),
  };
}

async function dataResult(
  request: DataGetRequest = DATA,
  tags: string[] = [],
  base64 = btoa('value'),
): Promise<DataGetResponse> {
  const { entryId } = await deriveEntry(SCOPE, request);
  return {
    entryId,
    generationId: 'generation',
    dependencyRevision: 1,
    entry: {
      kind: request.kind,
      ...(request.handler !== undefined && { handler: request.handler }),
      tags,
      stale: 30,
      timestamp: 1,
      expire: 120,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    value: { kind: 'inline', base64 },
  };
}

function nativeBody(source: UnderlyingSource<Uint8Array>): ReadableStream<Uint8Array> {
  Reflect.set(source, 'type', 'bytes');
  return new ReadableStream<Uint8Array>(source, { highWaterMark: 0 });
}

/** A real byte body, including harmless JSON whitespace beyond its valid prefix. */
function envelopeBody(
  text: string,
  options: {
    extra?: number;
    declared?: number;
    unknown?: boolean;
    status?: number;
  } = {},
) {
  const prefix = encodeUtf8(text);
  const total = prefix.byteLength + (options.extra ?? 0);
  const stated = options.unknown === true ? undefined : (options.declared ?? total);
  let sent = 0;
  let held: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const length = Math.min(CHUNK, total - sent);
    if (length === 0) {
      controller.close();
      return;
    }
    const chunk = new Uint8Array(length).fill(32);
    if (sent < prefix.byteLength) chunk.set(prefix.subarray(sent, sent + length));
    sent += length;
    controller.enqueue(chunk);
  });
  const body = nativeBody({
    start(controller) {
      held = controller;
    },
    pull,
    cancel,
  });
  return {
    response: new Response(body, {
      status: options.status ?? 200,
      headers: stated === undefined ? {} : { 'content-length': String(stated) },
    }),
    pull,
    cancel,
    sent: () => sent,
    stop() {
      held?.error(new Error('envelope fixture ended'));
    },
  };
}

function holdAllRoom(): () => void {
  const release = functionReadBudget().takeAtOnce(FUNCTION_READ_BYTES);
  if (release === undefined) throw new Error('the test needs an empty shared read room');
  return release;
}

function roomIsFree(): boolean {
  const release = functionReadBudget().takeAtOnce(FUNCTION_READ_BYTES);
  release?.();
  return release !== undefined;
}

/** Observe every started request immediately, including one an assertion later abandons. */
async function settled(pending: Promise<unknown>): Promise<unknown> {
  try {
    return await pending;
  } catch (error) {
    return error;
  }
}

function schemaReading(valid: DataGetResponse, kind: 'valid' | 'invalid') {
  const result = kind === 'valid' ? valid : { ...valid, entry: { ...valid.entry, tags: 42 } };
  const parse = dataGetResponseSchema.parse.bind(dataGetResponseSchema);
  const held: boolean[] = [];
  vi.spyOn(dataGetResponseSchema, 'parse').mockImplementation((value) => {
    held.push(!roomIsFree());
    return parse(value);
  });
  const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result }));
  return { held, reading: gateway(send).getData(DATA) };
}

describe('gateway JSON envelopes share the Function read room', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['start', 256 * 1024 + 2],
    ['commit', 0],
  ] as const)('accepts a 4 MiB record returned by %s', async (method, locationLength) => {
    const record = toBase64(new Uint8Array(RECORD_BYTES));
    const location = method === 'start' ? '"\\'.repeat(64 * 1024) : undefined;
    const result =
      method === 'start'
        ? await startResult(record, location)
        : {
            kind: 'published',
            generationId: 'generation',
            seq: 1,
            revision: 1,
            condemned: null,
            record,
          };
    const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result }));
    const answer = await recordCall(gateway(send), method);
    const serializedLocation = location === undefined ? '' : JSON.stringify(location);

    expect('record' in answer && answer.record === record).toBe(true);
    expect('current' in answer && answer.current?.location === location).toBe(method === 'start');
    expect(serializedLocation).toHaveLength(locationLength);
    expect(send).toHaveBeenCalledTimes(1);
    expect(roomIsFree()).toBe(true);
  });

  it.each(['getData', 'currentData'] as const)(
    'accepts maximum inline bytes and escaped metadata from %s',
    async (method) => {
      const request = { ...DATA, handler: '\0'.repeat(MAX_DATA_HANDLER_LENGTH) };
      const tags = Array.from(
        { length: MAX_TAGS_PER_ENTRY },
        (_, index) => index.toString(16).padStart(4, '0') + '\0'.repeat(MAX_TAG_LENGTH - 4),
      );
      const base64 = toBase64(new Uint8Array(MAX_INLINE_DATA_VALUE_BYTES));
      const result = await dataResult(request, tags, base64);
      const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result }));
      const answer = await gateway(send)[method](request);

      expect(answer?.value.kind === 'inline' && answer.value.base64 === base64).toBe(true);
      expect(answer?.entry.tags).toHaveLength(MAX_TAGS_PER_ENTRY);
      expect(answer?.entry.tags.every((tag, index) => tag === tags[index])).toBe(true);
      expect(answer?.entry.handler).toBe(request.handler);
      expect(roomIsFree()).toBe(true);
    },
  );

  it.each(['record', 'data'] as const)(
    'refuses an oversized declared %s body unread',
    async (route) => {
      const result = route === 'record' ? await startResult() : await dataResult();
      const limit = route === 'record' ? RECORD_ENVELOPE_BYTES : DATA_ENVELOPE_BYTES;
      const source = envelopeBody(JSON.stringify({ ok: true, result }), { declared: limit + 1 });
      const subject = gateway(() => Promise.resolve(source.response));
      const reading = route === 'record' ? recordCall(subject, 'start') : subject.getData(DATA);
      try {
        await expect(reading).rejects.toThrow(/length limit/u);
        expect(source.pull).not.toHaveBeenCalled();
        expect(source.cancel).toHaveBeenCalledTimes(1);
        expect(roomIsFree()).toBe(true);
      } finally {
        source.stop();
      }
    },
  );

  it('bounds an unknown body before EOF and cancels its unread remainder', async () => {
    const text = JSON.stringify({ ok: true, result: await dataResult() });
    const source = envelopeBody(text, {
      unknown: true,
      extra: DATA_ENVELOPE_BYTES + 2 * CHUNK - encodeUtf8(text).byteLength,
    });
    try {
      await expect(gateway(() => Promise.resolve(source.response)).getData(DATA)).rejects.toThrow(
        Error,
      );
      expect(source.sent()).toBeLessThanOrEqual(DATA_ENVELOPE_BYTES + CHUNK);
      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(roomIsFree()).toBe(true);
    } finally {
      source.stop();
    }
  });

  it('refuses an understated native length and cancels instead of parsing its prefix', async () => {
    const text = JSON.stringify({ ok: true, result: await dataResult() });
    const source = envelopeBody(text, { declared: encodeUtf8(text).byteLength - 1, extra: CHUNK });
    try {
      await expect(gateway(() => Promise.resolve(source.response)).getData(DATA)).rejects.toThrow(
        Error,
      );
      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(roomIsFree()).toBe(true);
    } finally {
      source.stop();
    }
  });

  it('waits for the shared full budget before pulling an envelope body', async () => {
    const source = envelopeBody(JSON.stringify({ ok: true, result: await dataResult() }));
    const asked = Promise.withResolvers<true>();
    const subject = gateway(() => {
      asked.resolve(true);
      return Promise.resolve(source.response);
    });
    vi.useFakeTimers();
    const release = holdAllRoom();
    const reading = subject.getData(DATA);
    const finished = settled(reading);
    try {
      await asked.promise;
      await vi.advanceTimersByTimeAsync(0);

      expect(source.pull).not.toHaveBeenCalled();

      release();
      await vi.advanceTimersByTimeAsync(25);

      await expect(reading).resolves.toMatchObject({ entry: { kind: DATA.kind } });
      expect(source.pull).toHaveBeenCalledWith(expect.anything());
      expect(roomIsFree()).toBe(true);
    } finally {
      release();
      source.stop();
      await vi.advanceTimersByTimeAsync(25);
      await finished;
    }
  });

  it.each([
    { method: 'getData', deadline: 300 },
    { method: 'currentData', deadline: 1000 },
    { method: 'getTags', deadline: 300 },
  ] as const)(
    'keeps the existing $method deadline while waiting for room',
    async ({ method, deadline }) => {
      const responseBody =
        method === 'getTags'
          ? { ok: false, error: { code: 'internal', message: 'refused' } }
          : { ok: true, result: await dataResult() };
      const source = envelopeBody(JSON.stringify(responseBody), {
        status: method === 'getTags' ? 503 : 200,
      });
      const asked = Promise.withResolvers<true>();
      const subject = gateway(() => {
        asked.resolve(true);
        return Promise.resolve(source.response);
      }, true);
      vi.useFakeTimers();
      const release = holdAllRoom();
      const reading = method === 'getTags' ? subject.getTags(['tag']) : subject[method](DATA);
      const finished = settled(reading);
      try {
        await asked.promise;
        await vi.advanceTimersByTimeAsync(deadline - 1);

        expect(source.pull).not.toHaveBeenCalled();
        expect(source.cancel).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(reading).rejects.toSatisfy(isDeadlineError);
        expect(source.cancel).toHaveBeenCalledTimes(1);

        release();

        expect(roomIsFree()).toBe(true);
      } finally {
        release();
        source.stop();
        await vi.advanceTimersByTimeAsync(25);
        await Promise.allSettled([reading, finished]);
      }
    },
  );

  it('holds room through valid schema validation', async () => {
    const valid = await dataResult();
    const { held, reading } = schemaReading(valid, 'valid');

    await expect(reading).resolves.toMatchObject({ entryId: valid.entryId });
    expect(held).toStrictEqual([true]);
    expect(roomIsFree()).toBe(true);
  });

  it('holds room through invalid schema validation', async () => {
    const valid = await dataResult();
    const { held, reading } = schemaReading(valid, 'invalid');

    await expect(reading).rejects.toThrow(Error);
    expect(held).toStrictEqual([true]);
    expect(roomIsFree()).toBe(true);
  });

  it('returns its room after JSON parsing fails', async () => {
    const source = envelopeBody('{');
    try {
      await expect(gateway(() => Promise.resolve(source.response)).getData(DATA)).rejects.toThrow(
        SyntaxError,
      );
      expect(roomIsFree()).toBe(true);
    } finally {
      source.stop();
    }
  });

  it('ends a stalled write-response body at ten seconds without awaiting cancel acknowledgement', async () => {
    const entered = Promise.withResolvers<true>();
    const acknowledgement = Promise.withResolvers<undefined>();
    const cancel = vi.fn(() => acknowledgement.promise);
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = nativeBody({
      start(controller) {
        held = controller;
      },
      pull() {
        entered.resolve(true);
      },
      cancel,
    });
    const subject = gateway(() =>
      Promise.resolve(new Response(body, { headers: { 'content-length': '32' } })),
    );
    vi.useFakeTimers();
    const reading = recordCall(subject, 'start');
    const finished = settled(reading);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(9999);

      expect(roomIsFree()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      await expect(reading).rejects.toSatisfy(isDeadlineError);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(roomIsFree()).toBe(true);
    } finally {
      acknowledgement.resolve(undefined);
      held?.error(new Error('stalled envelope fixture ended'));
      await vi.advanceTimersByTimeAsync(25);
      await Promise.allSettled([reading, finished, acknowledgement.promise]);
    }
  });

  it('bounds failure bodies and retains the status-only fallback', async () => {
    const source = envelopeBody(
      JSON.stringify({ ok: false, error: { code: 'internal', message: 'refused' } }),
      {
        status: 503,
        declared: FAILURE_ENVELOPE_BYTES + 1,
      },
    );
    try {
      await expect(
        gateway(() => Promise.resolve(source.response)).getData(DATA),
      ).rejects.toMatchObject({
        status: 503,
        message: 'cache gateway answered 503',
      });
      expect(source.pull).not.toHaveBeenCalled();
      expect(source.cancel).toHaveBeenCalledTimes(1);
      expect(roomIsFree()).toBe(true);
    } finally {
      source.stop();
    }
  });

  it('retains a bounded structured refusal and releases its room', async () => {
    const response = Response.json(
      { ok: false, error: { code: 'internal', message: 'refused' } },
      { status: 503 },
    );

    await expect(gateway(() => Promise.resolve(response)).getData(DATA)).rejects.toMatchObject({
      code: 'internal',
      status: 503,
      message: 'refused',
    });
    expect(roomIsFree()).toBe(true);
  });
});
