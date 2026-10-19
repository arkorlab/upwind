import { tagKindOf } from '@stayingupwind/core/cache';
import { isDeadlineError } from '@stayingupwind/core/util';
import type { TagRevision, TagsDeltaResponse } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';

type Method = 'revision' | 'delta';
const METHODS: readonly Method[] = ['revision', 'delta'];
const REVISION: TagRevision = { revision: 5, invalidatedAt: 123 };
const DELTA: TagsDeltaResponse = {
  revision: 5,
  floor: 0,
  truncated: false,
  tags: [],
  latest: REVISION,
};

function resultOf(method: Method): TagRevision | TagsDeltaResponse {
  return method === 'revision' ? REVISION : DELTA;
}

function read(subject: Gateway, method: Method): Promise<TagRevision | TagsDeltaResponse> {
  return method === 'revision' ? subject.tagRevision() : subject.tagsDelta(4);
}

function gateway(send: FetchLike) {
  const nearby = vi.fn<FetchLike>().mockRejectedValue(new Error('no authority read goes to KV'));
  const subject = new Gateway({
    scopeId: 'scope_tag_deadline',
    gatewayUrl: 'https://authority.invalid',
    readGatewayUrl: 'https://nearby.invalid',
    token: 'scope-token',
    naming: { copyCache: 'tag-deadline-copies', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: send,
    readFetchImpl: nearby,
  });
  return { subject, nearby };
}

/** Observe rejection immediately, before advancing a fake deadline. */
async function observed(pending: Promise<unknown>, state: { done: boolean }): Promise<unknown> {
  try {
    return await pending;
  } catch (error) {
    return error;
  } finally {
    state.done = true;
  }
}

/** Model Fetch's response-stream error when its request signal aborts. */
function signalAwareBody(request: Request, status: number) {
  const aborted = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      request.signal.addEventListener(
        'abort',
        () => {
          aborted();
          controller.error(request.signal.reason);
        },
        { once: true },
      );
    },
  });
  return { response: new Response(body, { status }), aborted };
}

function requiredRequest(send: ReturnType<typeof vi.fn<FetchLike>>): Request {
  const request = send.mock.calls[0]?.[0];
  if (request === undefined) {
    throw new Error('the authority was never asked');
  }
  return request;
}

describe.each(METHODS)('the authority %s read deadline', (method) => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects a stalled send, releases late headers and permits a fresh retry', async () => {
    vi.useFakeTimers();
    const headers = Promise.withResolvers<Response>();
    const send = vi.fn<FetchLike>().mockReturnValue(headers.promise);
    const { subject, nearby } = gateway(send);
    const reading = read(subject, method);
    const state = { done: false };
    const finished = observed(reading, state);
    const request = requiredRequest(send);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const late = new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }));
    try {
      await vi.advanceTimersByTimeAsync(999);

      expect({
        done: state.done,
        aborted: request.signal.aborted,
        origin: new URL(request.url).origin,
        nearbyCalls: nearby.mock.calls.length,
      }).toStrictEqual({
        done: false,
        aborted: false,
        origin: 'https://authority.invalid',
        nearbyCalls: 0,
      });

      await vi.advanceTimersByTimeAsync(1);

      await expect(reading).rejects.toSatisfy(isDeadlineError);
      expect(state.done).toBe(true);
      expect(request.signal.aborted).toBe(true);

      headers.resolve(late);
      await vi.advanceTimersByTimeAsync(0);

      expect(cancel).toHaveBeenCalledTimes(1);

      send.mockResolvedValueOnce(Response.json({ ok: true, result: resultOf(method) }));

      await expect(read(subject, method)).resolves.toStrictEqual(resultOf(method));
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      headers.resolve(late);
      await vi.advanceTimersByTimeAsync(1000);
      await finished;
    }
  });

  it.each([200, 503])(
    'includes a stalled %i response body in the same total budget',
    async (status) => {
      vi.useFakeTimers();
      const headers = Promise.withResolvers<Response>();
      const send = vi.fn<FetchLike>().mockReturnValue(headers.promise);
      const { subject } = gateway(send);
      const reading = read(subject, method);
      const state = { done: false };
      const finished = observed(reading, state);
      const request = requiredRequest(send);
      const source = signalAwareBody(request, status);
      try {
        await vi.advanceTimersByTimeAsync(600);
        headers.resolve(source.response);
        await vi.advanceTimersByTimeAsync(399);

        expect(state.done).toBe(false);
        expect(source.aborted).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(reading).rejects.toSatisfy(isDeadlineError);
        expect(state.done).toBe(true);
        expect(request.signal.aborted).toBe(true);
        expect(source.aborted).toHaveBeenCalledTimes(1);
      } finally {
        headers.resolve(source.response);
        await vi.advanceTimersByTimeAsync(1000);
        await finished;
      }
    },
  );

  it('retains a timely valid answer and clears its deadline without aborting the request', async () => {
    vi.useFakeTimers();
    const headers = Promise.withResolvers<Response>();
    const send = vi.fn<FetchLike>().mockReturnValue(headers.promise);
    const { subject, nearby } = gateway(send);
    const reading = read(subject, method);
    const finished = observed(reading, { done: false });
    const request = requiredRequest(send);
    try {
      await vi.advanceTimersByTimeAsync(999);
      headers.resolve(Response.json({ ok: true, result: resultOf(method) }));

      await expect(reading).resolves.toStrictEqual(resultOf(method));

      await vi.advanceTimersByTimeAsync(5000);

      expect(request.signal.aborted).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(nearby).not.toHaveBeenCalled();
    } finally {
      headers.resolve(Response.json({ ok: true, result: resultOf(method) }));
      await vi.advanceTimersByTimeAsync(1000);
      await finished;
    }
  });

  it('preserves a timely gateway refusal rather than replacing it with an empty answer', async () => {
    const response = Response.json(
      { ok: false, error: { code: 'internal', message: 'authority refused' } },
      { status: 503 },
    );
    const send = vi.fn<FetchLike>().mockResolvedValue(response);
    const { subject } = gateway(send);

    await expect(read(subject, method)).rejects.toMatchObject({
      code: 'internal',
      status: 503,
      message: 'authority refused',
    });
    expect(requiredRequest(send).signal.aborted).toBe(false);
  });
});

describe('an authority delta cursor', () => {
  it('still rejects a non-advancing truncated delta with the original response status', async () => {
    const delta: TagsDeltaResponse = {
      revision: 4,
      floor: 0,
      truncated: true,
      tags: [
        {
          tagId: 'tag',
          kind: tagKindOf('tag'),
          value: 'tag',
          revision: 4,
          staleAt: 123,
          hardExpireAt: null,
          meaning: 'immediate',
        },
      ],
    };
    const send = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ ok: true, result: delta }, { status: 201 }));
    const { subject } = gateway(send);

    await expect(subject.tagsDelta(4)).rejects.toMatchObject({
      code: 'internal',
      status: 201,
      message: 'the delta from revision 4 does not move past it',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
