import {
  FUNCTION_HEADER,
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  MISDIRECTED_STATUS,
} from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DETACHED_ACTION_LIMIT_MS } from '../src/handlers/passthrough-lifetime.ts';
import { mutationLifetimeFixture, SCOPE } from './mutation-lifetime-fixture.ts';

function invalidatedResponse(): Response {
  return new Response('updated', {
    headers: { [INVALIDATED_TAGS_HEADER]: 'posts', [INVALIDATED_REVISION_HEADER]: '7' },
  });
}

describe('action passthrough lifetime through invalidation receipt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains delayed receipt ingestion after a dispatched Action loses its client', async () => {
    const test = await mutationLifetimeFixture();
    const canceled = new AbortController();
    const headers = Promise.withResolvers<Response>();
    const accepted = Promise.withResolvers<undefined>();

    test.dispatch.mockImplementation(async (_script, request) => {
      await request.text();
      accepted.resolve(undefined);
      return headers.promise;
    });

    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        body: 'complete mutation body',
        headers: { 'next-action': 'fixture-action' },
        signal: canceled.signal,
      }),
    );
    await accepted.promise;
    canceled.abort();

    // A reload that already selected its record before the ACK can still serve the old value.
    expect({
      kind: test.selection().kind,
      held: test.memory.generations.get(test.recordKey) !== undefined,
    }).toStrictEqual({ kind: 'serve', held: true });
    expect(test.held).toHaveLength(1);

    headers.resolve(invalidatedResponse());
    await Promise.all(test.held);

    expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);
    expect(test.memory.generations.get(test.recordKey)).toBeUndefined();
    expect(test.selection().kind).toBe('regenerate');
    expect(test.unrelated()).toStrictEqual([
      { decision: 'serve', unchanged: true },
      { decision: 'serve', unchanged: true },
    ]);
    expect((await response).headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'application/x-www-form-urlencoded', body: '%24ACTION_ID_fixture-action=&title=new' },
    {
      type: 'multipart/form-data; boundary=fixture',
      body: '--fixture\r\nContent-Disposition: form-data; name="title"\r\n\r\nnew\r\n--fixture--\r\n',
    },
  ])(
    'retains a form navigation without next-action after it loses its client ($type)',
    async ({ type, body }) => {
      const test = await mutationLifetimeFixture();
      const canceled = new AbortController();
      const headers = Promise.withResolvers<Response>();
      const accepted = Promise.withResolvers<undefined>();
      let upstream: Request | undefined;

      test.dispatch.mockImplementation(async (_script, request) => {
        upstream = request;
        await request.text();
        accepted.resolve(undefined);
        return headers.promise;
      });

      const response = test.serve(
        new Request('https://app.test/', {
          method: 'POST',
          body,
          headers: { 'content-type': type, 'sec-fetch-mode': 'navigate' },
          signal: canceled.signal,
        }),
      );
      await accepted.promise;
      canceled.abort();

      expect(upstream?.signal.aborted).toBe(false);
      expect(test.held).toHaveLength(1);

      headers.resolve(invalidatedResponse());
      await Promise.all(test.held);

      expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);
      expect(test.selection().kind).toBe('regenerate');
      expect((await response).headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an accepted Action dispatch signal independent of a later client abort', async () => {
    const test = await mutationLifetimeFixture();
    const canceled = new AbortController();
    const headers = Promise.withResolvers<Response>();
    let upstream: Request | undefined;

    test.dispatch.mockImplementation((_script, request) => {
      upstream = request;
      request.signal.addEventListener('abort', () => {
        headers.reject(request.signal.reason);
      });
      return headers.promise;
    });

    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
        signal: canceled.signal,
      }),
    );
    canceled.abort();

    expect(upstream?.signal.aborted).toBe(false);

    headers.resolve(invalidatedResponse());
    await response;
    await Promise.all(test.held);

    expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'keeps %s cancelable without mutation retention',
    async (method) => {
      const test = await mutationLifetimeFixture();
      const canceled = new AbortController();
      const headers = Promise.withResolvers<Response>();

      test.dispatch.mockImplementation((_script, request) => {
        request.signal.addEventListener('abort', () => {
          headers.reject(request.signal.reason);
        });
        return headers.promise;
      });

      const response = test.serve(
        new Request('https://app.test/', { method, signal: canceled.signal }),
      );
      canceled.abort();
      const answer = await response;

      expect(answer.status).toBe(502);
      expect(test.held).toHaveLength(0);
      expect(test.selection().kind).toBe('serve');
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('retains one Action dispatch without waiting for its response body to end', async () => {
    const test = await mutationLifetimeFixture();
    const headers = Promise.withResolvers<Response>();
    const cancelBody = Promise.withResolvers<undefined>();
    const cancel = () => cancelBody.promise;
    const body = new ReadableStream({ cancel });

    test.dispatch.mockReturnValue(headers.promise);

    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
      }),
    );

    expect(test.held).toHaveLength(1);

    headers.resolve(new Response(body));
    await response;
    await Promise.all(test.held);

    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);

    cancelBody.resolve(undefined);
    await body.cancel();
  });

  it.each([
    { method: 'POST', actionHeader: false, type: undefined },
    { method: 'POST', actionHeader: false, type: 'application/json' },
    { method: 'POST', actionHeader: false, type: 'application/x-www-form-urlencoded' },
    { method: 'POST', actionHeader: false, type: 'multipart/form-data; boundary=fixture' },
    { method: 'PUT', actionHeader: false, type: undefined },
    { method: 'PUT', actionHeader: false, type: 'multipart/form-data; boundary=fixture' },
    { method: 'PATCH', actionHeader: false, type: undefined },
    { method: 'DELETE', actionHeader: false, type: undefined },
    { method: 'GET', actionHeader: true, type: undefined },
    { method: 'PUT', actionHeader: true, type: undefined },
  ])(
    'keeps a streaming $method response cancelable (Action header: $actionHeader, type: $type)',
    async ({ method, actionHeader, type }) => {
      const test = await mutationLifetimeFixture();
      const canceled = new AbortController();
      let upstream: Request | undefined;
      let stopped = false;

      test.dispatch.mockImplementation((_script, request) => {
        upstream = request;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                request.signal.addEventListener('abort', () => {
                  stopped = true;
                  controller.close();
                });
              },
            }),
          ),
        );
      });

      const response = await test.serve(
        new Request('https://app.test/', {
          method,
          headers: {
            ...(actionHeader && { 'next-action': 'fixture-action' }),
            ...(type !== undefined && { 'content-type': type }),
          },
          signal: canceled.signal,
        }),
      );
      canceled.abort();
      const signaled = upstream?.signal.aborted;
      // Release the old implementation's detached stream too, without a timer or hanging reader.
      await response.body?.cancel();

      expect(signaled).toBe(true);
      expect(stopped).toBe(true);
      expect(test.held).toHaveLength(0);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'still ingests a connected ordinary %s receipt without detaching its lifetime',
    async (method) => {
      const test = await mutationLifetimeFixture();

      test.dispatch.mockResolvedValue(invalidatedResponse());

      const response = await test.serve(new Request('https://app.test/', { method }));

      expect(response.status).toBe(200);
      expect(test.held).toHaveLength(0);
      expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);
      expect(test.selection().kind).toBe('regenerate');
      expect(test.unrelated()).toStrictEqual([
        { decision: 'serve', unchanged: true },
        { decision: 'serve', unchanged: true },
      ]);
      expect(response.headers.has(INVALIDATED_TAGS_HEADER)).toBe(false);
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an already-aborted signal without reviving a new mutation', async () => {
    const test = await mutationLifetimeFixture();
    const canceled = new AbortController();
    let accepted = 0;
    canceled.abort();

    test.dispatch.mockImplementation((_script, request) => {
      request.signal.throwIfAborted();
      accepted += 1;
      return Promise.resolve(invalidatedResponse());
    });

    const answer = await test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
        signal: canceled.signal,
      }),
    );

    expect(answer.status).toBe(502);
    expect(accepted).toBe(0);
    expect(test.held).toHaveLength(0);
    expect(test.selection().kind).toBe('serve');
  });

  it('does not reconstruct or replay an incomplete upload', async () => {
    const test = await mutationLifetimeFixture();
    let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
    const began = Promise.withResolvers<undefined>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upload = controller;
      },
    });
    let mutated = false;

    test.dispatch.mockImplementation(async (_script, request) => {
      began.resolve(undefined);
      await request.text();
      mutated = true;
      return invalidatedResponse();
    });

    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'next-action': 'fixture-action' },
      body,
      duplex: 'half',
    };
    const response = test.serve(new Request('https://app.test/', init));
    await began.promise;

    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.held).toHaveLength(1);

    upload?.error(new Error('upload ended before complete'));

    expect((await response).status).toBe(502);

    await Promise.all(test.held);

    expect(mutated).toBe(false);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.selection().kind).toBe('serve');
  });

  it('keeps the original rejected answer while its retained continuation fulfills', async () => {
    const test = await mutationLifetimeFixture();
    const failure = new Error('original response failure');

    test.now.mockImplementationOnce(() => {
      throw failure;
    });

    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
      }),
    );

    await expect(response).rejects.toBe(failure);
    await expect(Promise.all(test.held)).resolves.toStrictEqual([undefined]);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the existing split-worker handoff independent after dispatch, without replay', async () => {
    const test = await mutationLifetimeFixture();
    const canceled = new AbortController();
    const first = Promise.withResolvers<Response>();
    const headers = Promise.withResolvers<Response>();
    const requests: Request[] = [];

    test.dispatch.mockImplementation((script, request) => {
      requests.push(request);
      return script === 'function' ? first.promise : headers.promise;
    });

    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
        signal: canceled.signal,
      }),
      { fn_1: 'second-function' },
    );
    canceled.abort();
    first.resolve(
      new Response(null, { status: MISDIRECTED_STATUS, headers: { [FUNCTION_HEADER]: 'fn_1' } }),
    );
    // Wait only for the real asynchronous handoff to enter the second mocked dispatcher.
    await first.promise;
    await Promise.resolve();

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.signal.aborted)).toStrictEqual([false, false]);

    headers.resolve(invalidatedResponse());
    await response;
    await Promise.all(test.held);

    expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);
    expect(test.dispatch).toHaveBeenCalledTimes(2);
    expect(test.held).toHaveLength(1);
  });

  it('stops a detached Action that has not answered by its limit after the client left', async () => {
    const test = await mutationLifetimeFixture();
    const canceled = new AbortController();
    const headers = Promise.withResolvers<Response>();
    const accepted = Promise.withResolvers<undefined>();
    let upstream: Request | undefined;

    test.dispatch.mockImplementation(async (_script, request) => {
      upstream = request;
      request.signal.addEventListener('abort', () => {
        headers.reject(request.signal.reason);
      });
      await request.text();
      accepted.resolve(undefined);
      return headers.promise;
    });

    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        body: 'mutation body',
        headers: { 'next-action': 'fixture-action' },
        signal: canceled.signal,
      }),
    );
    await accepted.promise;
    vi.useFakeTimers();
    canceled.abort();

    await vi.advanceTimersByTimeAsync(DETACHED_ACTION_LIMIT_MS - 1);

    expect(upstream?.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(upstream?.signal.aborted).toBe(true);
    expect((upstream?.signal.reason as Error | undefined)?.name).toBe('TimeoutError');

    await Promise.all(test.held);
    await response;

    expect(test.memory.invalidations.of(SCOPE)).toBeUndefined();
    expect(test.dispatch).toHaveBeenCalledTimes(1);
  });

  it('bounds a detached Action only after its client has gone', async () => {
    const test = await mutationLifetimeFixture();
    const headers = Promise.withResolvers<Response>();
    let upstream: Request | undefined;

    test.dispatch.mockImplementation((_script, request) => {
      upstream = request;
      return headers.promise;
    });

    vi.useFakeTimers();
    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
      }),
    );
    await vi.advanceTimersByTimeAsync(DETACHED_ACTION_LIMIT_MS * 2);

    expect(upstream?.signal.aborted).toBe(false);

    headers.resolve(invalidatedResponse());
    await response;
    await Promise.all(test.held);

    expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);
  });

  it('lets go of the bound once a detached Action answers within it', async () => {
    const test = await mutationLifetimeFixture();
    const canceled = new AbortController();
    const headers = Promise.withResolvers<Response>();
    let upstream: Request | undefined;

    test.dispatch.mockImplementation((_script, request) => {
      upstream = request;
      return headers.promise;
    });

    vi.useFakeTimers();
    const response = test.serve(
      new Request('https://app.test/', {
        method: 'POST',
        headers: { 'next-action': 'fixture-action' },
        signal: canceled.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    canceled.abort();
    await vi.advanceTimersByTimeAsync(DETACHED_ACTION_LIMIT_MS / 2);

    headers.resolve(invalidatedResponse());
    await Promise.all(test.held);
    await vi.advanceTimersByTimeAsync(DETACHED_ACTION_LIMIT_MS);

    expect(upstream?.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(test.memory.invalidations.of(SCOPE)?.tags.get('posts')).toBe(7);

    await response;
  });
});
