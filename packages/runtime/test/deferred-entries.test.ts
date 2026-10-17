import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { deferredEntryFor, type EntryTables } from '../src/entries.ts';

const PAGE = '/page';
const request = {} as IncomingMessage;
const response = {} as ServerResponse;

function tables(load: EntryTables['app']['entries'][string]): EntryTables {
  return { app: { entries: { [PAGE]: load } }, edge: { entries: {} } };
}

async function handlerOf(asked: EntryTables): Promise<NodeHandler> {
  const entry = await deferredEntryFor(asked, PAGE);
  if (entry?.kind !== 'node') throw new Error('the page has no Node.js entry');
  return entry.handler;
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
});
