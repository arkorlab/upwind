import { describe, expect, it } from 'vitest';

import { type EntryTables, entryFor, middlewareHandler, nodeHandlerOf } from '../src/entries.ts';

/**
 * Looking up an entrypoint whose module has a top-level await.
 *
 * `app.cjs` hands out `() => require(<built entrypoint>)`, and `require` of a module whose source
 * awaits at the top level returns a promise of the module rather than the module. The `.handler`
 * read off that is `undefined`, which nothing reports: the request reaches `handler is not a
 * function` and answers 500. Next.js's own `middleware-general` fixture is built on exactly that
 * — a `middleware.js` with an awaited timeout — and all 68 of its Node.js-runtime cases failed
 * this way, against none once a thunk's result is awaited.
 */

const MIDDLEWARE = '/_middleware';
const PAGE = '/page';

const webHandler = (): Promise<Response> => Promise.resolve(new Response('from the middleware'));
const nodeHandler = (): Promise<unknown> => Promise.resolve(undefined);

function tables(app: Record<string, () => unknown>, edge: Record<string, () => unknown> = {}) {
  return { app: { entries: app }, edge: { entries: edge } } as unknown as EntryTables;
}

describe('an entrypoint whose module has a top-level await', () => {
  it('hands back the middleware the module resolves to, not the promise', async () => {
    const asked = tables({ [MIDDLEWARE]: () => Promise.resolve({ handler: webHandler }) });

    const handler = await middlewareHandler(asked, MIDDLEWARE);

    expect(handler).toBeTypeOf('function');

    const text = await (await handler?.(new Request('https://test.example/'), {}))?.text();

    expect(text).toBe('from the middleware');
  });

  it('hands back a Node.js entrypoint the same way', async () => {
    const asked = tables({ [PAGE]: () => Promise.resolve({ handler: nodeHandler }) });

    await expect(nodeHandlerOf(asked, PAGE)).resolves.toBeTypeOf('function');

    await expect(entryFor(asked, PAGE)).resolves.toHaveProperty('kind', 'node');
  });

  it('hands back an edge entrypoint the same way', async () => {
    const asked = tables({}, { [PAGE]: () => Promise.resolve({ handler: webHandler }) });

    const entry = await entryFor(asked, PAGE);

    expect(entry?.kind).toBe('edge');

    expect(entry?.handler).toBeTypeOf('function');
  });

  it('still takes a module that is not a promise, and still has no entry to hand back', async () => {
    const asked = tables({ [MIDDLEWARE]: () => ({ handler: webHandler }) });

    await expect(middlewareHandler(asked, MIDDLEWARE)).resolves.toBeTypeOf('function');

    await expect(entryFor(asked, '/absent')).resolves.toBeUndefined();
  });
});
