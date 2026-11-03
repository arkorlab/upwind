import { type TagKind, tagKindOf } from '@stayingupwind/core/cache';
import { isDeadlineError } from '@stayingupwind/core/util';
import {
  MAX_DELTA_PAGE_TAGS,
  NO_SUCH_ENDPOINT,
  type TagRevision,
  type TagsDeltaResponse,
  type TagsRecentResponse,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheHostFor } from '../src/function/cache-host.ts';
import { Gateway } from '../src/function/gateway.ts';

type Method = 'revision' | 'delta' | 'recent';
const METHODS: readonly Method[] = ['revision', 'delta', 'recent'];
const REVISION: TagRevision = { revision: 5, invalidatedAt: 123 };
const DELTA: TagsDeltaResponse = {
  revision: 5,
  floor: 0,
  truncated: false,
  tags: [],
  latest: REVISION,
};
const RECENT: TagsRecentResponse = { revision: 5, truncated: false, tags: [] };
/** The moment a window of recent invalidations is asked from. */
const FROM = 1_800_000_000_000;

type Answer = TagRevision | TagsDeltaResponse | TagsRecentResponse;

function resultOf(method: Method): Answer {
  return { revision: REVISION, delta: DELTA, recent: RECENT }[method];
}

function read(subject: Gateway, method: Method): Promise<Answer> {
  if (method === 'revision') {
    return subject.tagRevision();
  }
  return method === 'delta' ? subject.tagsDelta(4) : subject.tagsRecent(4, FROM);
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

/** A tag's record as the authority answers it, of the kind its value names unless said. */
function recordOf(value: string, revision: number, kind: TagKind = tagKindOf(value)) {
  return {
    tagId: `tag-${value}`,
    kind,
    value,
    revision,
    staleAt: 123,
    hardExpireAt: null,
    meaning: 'immediate',
  } as const;
}

describe('what a Function asks of the authority’s tags', () => {
  /**
   * A fresh isolate pages through the scope's whole history, a round trip a page: it asks each for
   * as many tags as a page may hold, where the gateway's own default is half of it.
   */
  it('asks each page of the delta for as many tags as a page may hold', async () => {
    const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result: DELTA }));
    const { subject } = gateway(send);

    await subject.tagsDelta(4);

    const asked = new URL(requiredRequest(send).url);

    expect(asked.pathname.endsWith('/tags/delta')).toBe(true);
    expect(Object.fromEntries(asked.searchParams)).toStrictEqual({
      since: '4',
      limit: String(MAX_DELTA_PAGE_TAGS),
    });
  });

  it('asks a window of recent invalidations from a revision and a moment, as many as a page holds', async () => {
    const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result: RECENT }));
    const { subject } = gateway(send);

    await subject.tagsRecent(4, FROM);

    const asked = new URL(requiredRequest(send).url);

    expect(asked.origin).toBe('https://authority.invalid');
    expect(asked.pathname.endsWith('/tags/recent')).toBe(true);
    expect(Object.fromEntries(asked.searchParams)).toStrictEqual({
      since: '4',
      from: String(FROM),
      limit: String(MAX_DELTA_PAGE_TAGS),
    });
  });

  /**
   * A window cut at its oldest end stands at the scope's revision, past the newest invalidation it
   * holds: what no page of the delta may do, and what a window is.
   */
  it('takes a truncated window that stands past the newest invalidation it holds', async () => {
    const window = { revision: 9, truncated: true, tags: [recordOf('posts', 8)] };
    const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result: window }));
    const { subject } = gateway(send);

    await expect(subject.tagsRecent(4, FROM)).resolves.toStrictEqual(window);
  });

  /**
   * A gateway from before the window answers a route it does not have, or whatever stands in front
   * of it answers 404 with no envelope: the runtime is told the call is unsupported, and catches up
   * through the delta alone. A 404 of something else is that refusal.
   */
  it.each([
    {
      answer: { ok: false, error: { code: 'not_found', message: NO_SUCH_ENDPOINT } },
      code: 'unsupported',
    },
    { answer: 'no such route', code: 'unsupported' },
    {
      answer: { ok: false, error: { code: 'not_found', message: 'no such scope' } },
      code: 'not_found',
    },
  ])('says a window a gateway answers 404 to is $code', async ({ answer, code }) => {
    const response =
      typeof answer === 'string'
        ? new Response(answer, { status: 404 })
        : Response.json(answer, { status: 404 });
    const send = vi.fn<FetchLike>().mockResolvedValue(response);
    const { subject } = gateway(send);

    await expect(subject.tagsRecent(4, FROM)).rejects.toMatchObject({ code, status: 404 });
  });

  /** The runtime's tags are Next.js's: a platform-delivery tag sharing a value expires nothing. */
  it('leaves a platform tag out of the window a Function’s host answers', async () => {
    const window = {
      revision: 9,
      truncated: false,
      tags: [recordOf('products', 7, 'platform-delivery'), recordOf('products', 8)],
    };
    const send = vi.fn<FetchLike>().mockResolvedValue(Response.json({ ok: true, result: window }));
    const binding = cacheHostFor({
      copyCache: 'tag-window-copies',
      copyKeyOrigin: 'https://copies.invalid',
    })({
      env: {
        ARKOR_CACHE_GATEWAY_URL: 'https://authority.invalid',
        ARKOR_CACHE_TOKEN: 'scope-token',
        NEXT_DEPLOYMENT_ID: 'scope_tag_window',
      },
      fetchImpl: send,
    });

    const recent = await binding?.host.tagsRecent?.(0, FROM);

    expect(recent).toStrictEqual({ ...window, tags: [recordOf('products', 8)] });
  });
});
