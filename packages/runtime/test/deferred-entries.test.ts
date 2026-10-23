import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { withDeadline } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeHandler, WebHandler } from '../src/app-module.ts';
import {
  deferredEntryFor,
  type EntryTables,
  middlewareHandler,
  nodeHandlerOf,
} from '../src/entries.ts';

const PAGE = '/page';
const MIDDLEWARE = '/_middleware';
const GIVEN_UP = 'was still evaluating 30 s after a request began it';
const PENDING = Symbol('pending');
const request = {} as IncomingMessage;
const response = {} as ServerResponse;

type WaitUntil = NonNullable<EntryTables['waitUntil']>;

function tables(load: EntryTables['app']['entries'][string]): EntryTables {
  return { app: { entries: { [PAGE]: load } }, edge: { entries: {} } };
}

async function handlerOf(asked: EntryTables): Promise<NodeHandler> {
  const entry = await deferredEntryFor(asked, PAGE);
  if (entry?.kind !== 'node') throw new Error('the page has no Node.js entry');
  return entry.handler;
}

/** What `promise` has come to once what is queued ahead of it has run: `PENDING` while nothing. */
function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([promise, Promise.resolve(PENDING)]);
}

/**
 * What `promise` fails with, as a message, and `undefined` if it does not fail: what a test lets
 * fail while its clock runs is read after.
 */
async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'a failure other than an Error';
  }
}

/** A module whose top-level read, bounded by a deadline of the module's own, runs out of time. */
async function outOfTime(): Promise<{ handler: NodeHandler }> {
  await withDeadline(Promise.withResolvers<never>().promise, 0, 'a configuration read');
  return { handler: () => Promise.resolve('rendered') };
}

/** A Node.js middleware's table, as the request looking it up with `waitUntil` hands it over. */
function middlewareTables(
  load: () => Promise<{ handler: WebHandler }>,
  waitUntil: WaitUntil,
): EntryTables {
  return { app: { entries: { [MIDDLEWARE]: load } }, edge: { entries: {} }, waitUntil };
}

describe('a Node.js page loaded only when rendered', () => {
  it('shares a pending top-level await, then returns the loaded handler for warm requests', async () => {
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    const render = vi.fn(() => Promise.resolve('rendered'));
    const load = vi.fn(() => module.promise);
    const asked = tables(load);
    const first = await handlerOf(asked);
    const second = await handlerOf(asked);

    expect(load).not.toHaveBeenCalled();

    const rendered = [first(request, response, {}), second(request, response, {})];
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledExactlyOnceWith();
    });

    expect(render).not.toHaveBeenCalled();

    module.resolve({ handler: render });

    await expect(Promise.all(rendered)).resolves.toStrictEqual(['rendered', 'rendered']);

    const warm = await handlerOf(asked);

    expect(warm).not.toBe(first);
    await expect(warm(request, response, {})).resolves.toBe('rendered');
    expect(load).toHaveBeenCalledExactlyOnceWith();
    expect(render).toHaveBeenCalledTimes(3);
  });

  it.each(['throw', 'reject'])(
    'propagates a load that %ss, allowing the next render to retry',
    async (failure) => {
      const error = new Error('module failed');
      const render = vi.fn(() => Promise.resolve('retried'));
      const load = vi.fn(() => {
        if (load.mock.calls.length === 1) {
          if (failure === 'throw') throw error;
          return Promise.reject(error);
        }
        return Promise.resolve({ handler: render });
      });
      const handler = await handlerOf(tables(load));

      expect(load).not.toHaveBeenCalled();

      await expect(handler(request, response, {})).rejects.toBe(error);
      expect(render).not.toHaveBeenCalled();
      await expect(handler(request, response, {})).resolves.toBe('retried');
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps each request context and graph admission when two renders share a module load', async () => {
    const contexts = new AsyncLocalStorage<string>();
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    const asked = tables(() => module.promise);
    const first = await handlerOf(asked);
    const second = await handlerOf(asked);
    const rendered = [
      contexts.run('first', () => first(request, response, {})),
      contexts.run('second', () => second(request, response, {})),
    ];
    module.resolve({
      handler: () => {
        return Promise.resolve({
          context: contexts.getStore(),
          patched: Reflect.get(globalThis, Symbol.for('next-patch')) === true,
        });
      },
    });

    await expect(Promise.all(rendered)).resolves.toStrictEqual([
      { context: 'first', patched: false },
      { context: 'second', patched: false },
    ]);
  });

  it('keeps edge-runtime lookups eager and leaves missing entries missing', async () => {
    const load = vi.fn(() => ({ handler: () => Promise.resolve(new Response('edge')) }));
    const asked = { app: { entries: {} }, edge: { entries: { [PAGE]: load } } };

    await expect(deferredEntryFor(asked, PAGE)).resolves.toHaveProperty('kind', 'edge');
    expect(load).toHaveBeenCalledExactlyOnceWith();
    await expect(deferredEntryFor(asked, '/missing')).resolves.toBeUndefined();
  });

  it('holds its evaluation with the waitUntil of the render that begins it', async () => {
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    const handler = await handlerOf(tables(() => module.promise));
    const waitUntil = vi.fn<WaitUntil>();
    const rendered = handler(request, response, { waitUntil });

    await vi.waitFor(() => {
      expect(waitUntil).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
    });

    module.resolve({ handler: () => Promise.resolve('rendered') });

    await expect(rendered).resolves.toBe('rendered');
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });
});

describe('a module evaluation one request begins and others join', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is held with the waitUntil of the request that begins it, and of no other', async () => {
    const module = Promise.withResolvers<{ handler: WebHandler }>();
    const load = vi.fn(() => module.promise);
    const [beginning, joining, warm] = [vi.fn<WaitUntil>(), vi.fn<WaitUntil>(), vi.fn<WaitUntil>()];
    const lookups = [
      middlewareHandler(middlewareTables(load, beginning), MIDDLEWARE),
      middlewareHandler(middlewareTables(load, joining), MIDDLEWARE),
    ];

    expect(beginning).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
    expect(joining).not.toHaveBeenCalled();

    const [held] = beginning.mock.calls[0]!;

    await expect(outcomeOf(held)).resolves.toBe(PENDING);

    module.resolve({ handler: () => Promise.resolve(new Response('next')) });

    await expect(held).resolves.toBeUndefined();

    const handlers = await Promise.all([
      ...lookups,
      middlewareHandler(middlewareTables(load, warm), MIDDLEWARE),
    ]);
    const answers = await Promise.all(
      handlers.map(async (handler) =>
        (await handler!(new Request('https://app.test/'), {})).text(),
      ),
    );

    expect(answers).toStrictEqual(['next', 'next', 'next']);
    expect(warm).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledExactlyOnceWith();
  });

  it('fails a request that joined it once 30 s have passed since it began, and lets the next begin afresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stranded = Promise.withResolvers<{ handler: NodeHandler }>();
    const render = vi.fn(() => Promise.resolve('rendered'));
    const load = vi.fn(() =>
      load.mock.calls.length === 1 ? stranded.promise : Promise.resolve({ handler: render }),
    );
    const asked = tables(load);
    const begun = nodeHandlerOf(asked, PAGE);
    await vi.advanceTimersByTimeAsync(10_000);
    const joined = failureOf(nodeHandlerOf(asked, PAGE));
    await vi.advanceTimersByTimeAsync(19_999);

    await expect(outcomeOf(joined)).resolves.toBe(PENDING);

    await vi.advanceTimersByTimeAsync(1);

    await expect(joined).resolves.toContain(GIVEN_UP);
    // The request that began it waits on its own, as it would under Node.js.
    await expect(outcomeOf(begun)).resolves.toBe(PENDING);

    const next = await nodeHandlerOf(asked, PAGE);

    expect(load).toHaveBeenCalledTimes(2);
    await expect(next!(request, response, {})).resolves.toBe('rendered');
  });

  it('fails at once a request handed it back after it was given up on, and serves its module once it settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    // A bundle's registry evaluates a module once: asked again, it hands back the same promise.
    const load = vi.fn(() => module.promise);
    const asked = tables(load);
    const begun = nodeHandlerOf(asked, PAGE);
    const joined = failureOf(nodeHandlerOf(asked, PAGE));
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(joined).resolves.toContain(GIVEN_UP);
    // With no time passing: a request that waited would never be answered here.
    await expect(nodeHandlerOf(asked, PAGE)).rejects.toThrow(GIVEN_UP);
    expect(load).toHaveBeenCalledTimes(2);

    module.resolve({ handler: () => Promise.resolve('rendered') });

    await expect(begun).resolves.toBeTypeOf('function');

    const warm = await nodeHandlerOf(asked, PAGE);

    await expect(warm!(request, response, {})).resolves.toBe('rendered');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fails a request that joined it with what it failed with, a deadline of its own included', async () => {
    // A bundle's registry evaluates a module once: asked again, it hands back the same promise.
    const evaluation = outOfTime();
    const load = vi.fn(() => evaluation);
    const asked = tables(load);
    const failures = await Promise.all([
      failureOf(nodeHandlerOf(asked, PAGE)),
      failureOf(nodeHandlerOf(asked, PAGE)),
    ]);

    expect(failures).toStrictEqual([
      'a configuration read timed out',
      'a configuration read timed out',
    ]);
    // Failed, and not given up on: the next request is answered with the failure, as an eager
    // lookup retrying it always was.
    await expect(nodeHandlerOf(asked, PAGE)).rejects.toThrow('a configuration read timed out');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps no late module of an evaluation given up on once a later evaluation has begun', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = Promise.withResolvers<{ handler: NodeHandler }>();
    const second = Promise.withResolvers<{ handler: NodeHandler }>();
    const third = Promise.resolve({ handler: () => Promise.resolve('third') });
    const load = vi.fn(() => [first.promise, second.promise, third][load.mock.calls.length - 1]!);
    const asked = tables(load);
    const begun = failureOf(nodeHandlerOf(asked, PAGE));
    const joined = failureOf(nodeHandlerOf(asked, PAGE));
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(joined).resolves.toContain(GIVEN_UP);

    const retried = failureOf(nodeHandlerOf(asked, PAGE));
    second.reject(new Error('the second evaluation failed'));

    await expect(retried).resolves.toBe('the second evaluation failed');

    first.resolve({ handler: () => Promise.resolve('first') });

    // The request that began the first evaluation is answered with its module all the same.
    await expect(begun).resolves.toBeUndefined();

    const next = await nodeHandlerOf(asked, PAGE);

    expect(load).toHaveBeenCalledTimes(3);
    await expect(next!(request, response, {})).resolves.toBe('third');
  });

  it('keeps for a deferred page the handler of the evaluation that stands, not of one given up on that settles late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = Promise.withResolvers<{ handler: NodeHandler }>();
    const second = Promise.resolve({ handler: () => Promise.resolve('second') });
    const load = vi.fn(() => (load.mock.calls.length === 1 ? first.promise : second));
    const asked = tables(load);
    const begun = (await handlerOf(asked))(request, response, {});
    const joined = failureOf((await handlerOf(asked))(request, response, {}));
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(joined).resolves.toContain(GIVEN_UP);
    await expect((await handlerOf(asked))(request, response, {})).resolves.toBe('second');

    first.resolve({ handler: () => Promise.resolve('first') });

    // The render that began the first evaluation is answered with its module all the same.
    await expect(begun).resolves.toBe('first');
    await expect((await handlerOf(asked))(request, response, {})).resolves.toBe('second');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps no late module of an evaluation given up on once its thunk hands one over as it is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = Promise.withResolvers<{ handler: NodeHandler }>();
    const ready = { handler: () => Promise.resolve('ready') };
    const load = vi.fn(() => (load.mock.calls.length === 1 ? first.promise : ready));
    const asked = tables(load);
    const begun = failureOf(nodeHandlerOf(asked, PAGE));
    const joined = failureOf(nodeHandlerOf(asked, PAGE));
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(joined).resolves.toContain(GIVEN_UP);

    const retried = await nodeHandlerOf(asked, PAGE);

    await expect(retried!(request, response, {})).resolves.toBe('ready');

    first.resolve({ handler: () => Promise.resolve('first') });

    // The request that began the first evaluation is answered with its module all the same.
    await expect(begun).resolves.toBeUndefined();

    const next = await nodeHandlerOf(asked, PAGE);

    await expect(next!(request, response, {})).resolves.toBe('ready');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('publishes no evaluation the host will not hold, and lets the request that began it await its module', async () => {
    const module = Promise.withResolvers<{ handler: NodeHandler }>();
    // A bundle's registry evaluates a module once: asked again, it hands back the same promise.
    const load = vi.fn(() => module.promise);
    const refused = vi.fn<WaitUntil>(() => {
      throw new Error('waitUntil() called after the invocation ended');
    });
    const holding = vi.fn<WaitUntil>();
    const begun = nodeHandlerOf({ ...tables(load), waitUntil: refused }, PAGE);
    const next = nodeHandlerOf({ ...tables(load), waitUntil: holding }, PAGE);

    // Joined to nothing the host holds: the next request begins it again, and holds it.
    expect(refused).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
    expect(holding).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));

    module.resolve({ handler: () => Promise.resolve('rendered') });

    await expect(begun).resolves.toBeTypeOf('function');
    await expect(next).resolves.toBeTypeOf('function');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
