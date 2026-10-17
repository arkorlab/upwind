import {
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  publishedFunctionEnv,
} from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { functionEntry } from '../src/function-entry.ts';
import { requestEntry, type VercelRequestContext } from '../src/request-context.ts';

describe('the shared Function entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes bindings before configuring the host and enters the public request context afterwards', async () => {
    const env = { EXAMPLE: { fetch: vi.fn() } };
    const work = Promise.resolve();
    const waitUntil = vi.fn();
    const entry = functionEntry({
      configure(bindings) {
        expect(bindings).toBe(env);
        expect(publishedFunctionEnv()).toBe(env);
        expect(requestEntry()).toBeUndefined();

        return 'configured';
      },
      async answer({ waitUntil: hold, props }, configured) {
        expect(configured).toBe('configured');
        expect(props).toStrictEqual({ unrelated: true });
        expect(requestEntry()).toBeTypeOf('function');

        await Promise.resolve();
        const installed = Reflect.get(globalThis, Symbol.for('@vercel/request-context')) as {
          get(): VercelRequestContext;
        };
        const context = installed.get();

        expect(context.url).toBe('https://site.test/path');
        expect(context.headers['x-example']).toBe('value');

        hold(work);
        return new Response('served');
      },
    });
    const response = await entry.fetch(
      new Request('https://internal.test/path', {
        headers: {
          'x-forwarded-host': 'site.test',
          'x-forwarded-proto': 'https',
          'x-example': 'value',
        },
      }),
      env,
      { props: { unrelated: true }, waitUntil },
    );

    await expect(response.text()).resolves.toBe('served');
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(work);
  });

  it.each([
    ['GET', false],
    ['HEAD', false],
    ['OPTIONS', false],
    ['TRACE', false],
    ['POST', true],
    ['PUT', true],
    ['PATCH', true],
    ['DELETE', true],
  ])('holds %s work to its answer when the method may change something', async (method, held) => {
    const waitUntil = vi.fn();
    const entry = functionEntry({
      configure: () => null,
      answer: () => Promise.resolve(new Response(null)),
    });
    // Fetch rejects TRACE as an outgoing method, but a server can receive one.
    const request = new Request('https://site.test/');
    Object.defineProperty(request, 'method', { value: method });
    const answer = entry.fetch(request, {}, { waitUntil });

    expect(waitUntil.mock.calls).toStrictEqual(held ? [[answer]] : []);

    await answer;
  });

  it('answers a host initialization failure without invoking the application', async () => {
    vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const answer = vi.fn(() => Promise.resolve(new Response('unreachable')));
    const entry = functionEntry({
      configure() {
        throw new Error('host unavailable');
      },
      answer,
    });
    const response = await entry.fetch(
      new Request('https://site.test/'),
      {},
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Internal Server Error: host unavailable');
    expect(answer).not.toHaveBeenCalled();
  });

  it('keeps completed invalidations on a bounded single-line failure response', async () => {
    vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const entry = functionEntry({
      configure: () => null,
      answer({ invalidated }) {
        invalidated.add(['changed'], 42);
        return Promise.reject(new Error(`first\nsecond\u{2028}${'x'.repeat(300)}`));
      },
    });
    const response = await entry.fetch(
      new Request('https://site.test/'),
      {},
      { waitUntil: vi.fn() },
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get(INVALIDATED_TAGS_HEADER)).toBe('changed');
    expect(response.headers.get(INVALIDATED_REVISION_HEADER)).toBe('42');
    expect(body).toBe(`Internal Server Error: first second ${'x'.repeat(187)}`);
  });
});
