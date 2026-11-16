import { AsyncLocalStorage } from 'node:async_hooks';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  afterResponse,
  installRequestContext,
  type VercelRequestContext,
  withRequestContext,
} from '../src/request-context.ts';

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** The context a library finds while the runtime serves the current request. */
function currentContext(): VercelRequestContext | undefined {
  const holder = Reflect.get(globalThis, REQUEST_CONTEXT) as {
    get: () => VercelRequestContext | undefined;
  };
  return holder.get();
}

/** One request and the background promises its execution context retains. */
function request(url = 'https://fixture.test/'): {
  context: VercelRequestContext;
  kept: Promise<unknown>[];
} {
  const kept: Promise<unknown>[] = [];
  return {
    context: {
      headers: {},
      url,
      afterResponse,
      waitUntil: (promise) => {
        kept.push(promise);
        // The platform observes background rejections independently of the response.
        void promise.catch(() => {
          // Observed separately through the kept promise below.
        });
      },
    },
    kept,
  };
}

describe('background work registered after the response', () => {
  beforeAll(() => {
    installRequestContext();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
  });

  it('returns the original promise without observing it or scheduling unused work', async () => {
    const { context, kept } = request();
    const answer = Promise.withResolvers<string>();
    const then = vi.spyOn(answer.promise, 'then');

    const response = withRequestContext(context, () => answer.promise);

    expect(response).toBe(answer.promise);
    expect(then).not.toHaveBeenCalled();
    expect(kept).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    answer.resolve('answered');

    await expect(response).resolves.toBe('answered');
  });

  it('starts after settlement and its handoff turn, without holding the response', async () => {
    const { context, kept } = request();
    const answer = Promise.withResolvers<Response>();
    const task = Promise.withResolvers<undefined>();
    const order: string[] = [];
    const response = withRequestContext(context, () => {
      currentContext()?.afterResponse?.(() => {
        order.push('task');
        return task.promise;
      });
      return answer.promise;
    });

    expect(response).toBe(answer.promise);
    expect(kept).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    const expected = new Response('ready');
    answer.resolve(expected);

    await expect(response).resolves.toBe(expected);

    order.push('response');

    expect(order).toStrictEqual(['response']);

    await vi.runAllTimersAsync();

    expect(order).toStrictEqual(['response', 'task']);

    task.resolve(undefined);
    await Promise.all(kept);
  });

  it('does not wait for an open streaming response body', async () => {
    const { context, kept } = request();
    const task = vi.fn();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const expected = new Response(body);
    const response = withRequestContext(context, () => {
      afterResponse(task);
      return Promise.resolve(expected);
    });

    await expect(response).resolves.toBe(expected);

    await vi.runAllTimersAsync();
    await Promise.all(kept);

    expect(task).toHaveBeenCalledTimes(1);
    expect(expected.bodyUsed).toBe(false);

    controller?.close();
  });

  it('keeps concurrent registrations in their request entry across awaits', async () => {
    const render = new AsyncLocalStorage<string>();
    const first = request('https://fixture.test/first');
    const second = request('https://fixture.test/second');
    const register = Promise.withResolvers<undefined>();
    const firstAnswer = Promise.withResolvers<string>();
    const secondAnswer = Promise.withResolvers<string>();
    const seen: { url: string | undefined; render: string | undefined }[] = [];
    const run = (context: VercelRequestContext, answer: Promise<string>): Promise<string> => {
      return withRequestContext(context, () => {
        return render.run(context.url, async () => {
          await register.promise;
          currentContext()?.afterResponse?.(async () => {
            await Promise.resolve();
            seen.push({ url: currentContext()?.url, render: render.getStore() });
          });
          return answer;
        });
      });
    };
    const one = run(first.context, firstAnswer.promise);
    const two = run(second.context, secondAnswer.promise);

    register.resolve(undefined);
    secondAnswer.resolve('second');

    await expect(two).resolves.toBe('second');

    await vi.runAllTimersAsync();

    expect(seen).toStrictEqual([{ url: second.context.url, render: undefined }]);

    firstAnswer.resolve('first');

    await expect(one).resolves.toBe('first');

    await vi.runAllTimersAsync();
    // eslint-disable-next-line unicorn/prefer-iterator-concat -- This suite's ES2024 declarations do not expose Iterator.concat.
    await Promise.all([...first.kept, ...second.kept]);

    expect(seen).toStrictEqual([
      { url: second.context.url, render: undefined },
      { url: first.context.url, render: undefined },
    ]);
  });

  it('accepts registration from retained work after its handler has answered', async () => {
    const { context, kept } = request();
    const late = Promise.withResolvers<undefined>();
    const task = vi.fn();
    const response = withRequestContext(context, () => {
      context.waitUntil(
        (async () => {
          await late.promise;
          currentContext()?.afterResponse?.(task);
        })(),
      );
      return Promise.resolve('answered');
    });

    await expect(response).resolves.toBe('answered');

    late.resolve(undefined);
    await vi.runAllTimersAsync();
    await Promise.all(kept);

    expect(task).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(2);
  });

  it('runs registered work when its handler throws before returning a promise', async () => {
    const { context, kept } = request();
    const failure = new Error('handler failed');
    const task = vi.fn();

    expect(() => {
      return withRequestContext(context, () => {
        afterResponse(task);
        throw failure;
      });
    }).toThrow(failure);

    await vi.runAllTimersAsync();
    await Promise.all(kept);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs registered work when its handler promise rejects', async () => {
    const { context, kept } = request();
    const failure = new Error('handler failed');
    const task = vi.fn();
    const response = withRequestContext(context, () => {
      afterResponse(task);
      return Promise.reject(failure);
    });

    await expect(response).rejects.toBe(failure);

    await vi.runAllTimersAsync();
    await Promise.all(kept);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('reports task failures through waitUntil without changing the handler result', async () => {
    const { context, kept } = request();
    const synchronous = new Error('synchronous background failure');
    const asynchronous = new Error('asynchronous background failure');
    const response = withRequestContext(context, () => {
      afterResponse(() => {
        throw synchronous;
      });
      afterResponse(() => Promise.reject(asynchronous));
      return Promise.resolve('answered');
    });

    await expect(response).resolves.toBe('answered');

    await vi.runAllTimersAsync();

    await expect(Promise.allSettled(kept)).resolves.toStrictEqual([
      { status: 'rejected', reason: synchronous },
      { status: 'rejected', reason: asynchronous },
    ]);
  });

  it('does not change the response when its background lifetime has expired', async () => {
    const { context } = request();
    const task = vi.fn(() => {
      throw new Error('background failed');
    });
    const expired = {
      ...context,
      waitUntil: () => {
        throw new Error('lifetime expired');
      },
    };

    const response = withRequestContext(expired, () => {
      afterResponse(task);
      return Promise.resolve('answered');
    });

    await expect(response).resolves.toBe('answered');

    await vi.runAllTimersAsync();

    expect(task).toHaveBeenCalledTimes(1);
  });
});
