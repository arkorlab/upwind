import { fileURLToPath } from 'node:url';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bundleInlineWorker } from './inline-worker.ts';

vi.setConfig({ testTimeout: 60_000 });

const REQUEST_CONTEXT_SOURCE = fileURLToPath(new URL('../src/request-context.ts', import.meta.url));
const REQUEST_TIMEOUT_MS = 10_000;
const WORKER = `
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterResponse, installRequestContext, withRequestContext } from ${JSON.stringify(REQUEST_CONTEXT_SOURCE)};

installRequestContext();
const render = new AsyncLocalStorage();
// Only plain observations cross requests; promises and I/O remain owned by their originating request.
const states = new Map();
const turn = () => new Promise(resolve => setTimeout(resolve, 1));
const current = () => globalThis[Symbol.for('@vercel/request-context')].get();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (url.pathname === '/release') {
      states.get(id).released = true;
      return new Response('released');
    }
    if (url.pathname === '/states') {
      const selected = () => id === null ? [...states.values()] : [states.get(id)];
      const until = url.searchParams.get('until');
      for (let attempt = 0; until !== null && !selected().every(state => state[until]); attempt += 1) {
        if (attempt >= 1000) throw new Error('background work did not reach ' + until);
        await turn();
      }
      return Response.json(selected());
    }
    const state = {
      id, settled: false, retained: 0, started: false, finished: false, released: false,
      settledAtStart: false, contextUrl: null, render: null, echoed: null, error: null,
    };
    states.set(id, state);
    const context = {
      headers: {}, url: request.url, afterResponse,
      waitUntil(pending) { state.retained += 1; ctx.waitUntil(pending); },
    };
    const answer = withRequestContext(context, () => render.run(id, async () => {
      await turn();
      current().afterResponse(async () => {
        state.started = true;
        state.settledAtStart = state.settled;
        try {
          while (!state.released) await turn();
          state.contextUrl = current()?.url ?? null;
          state.render = render.getStore() ?? null;
          const response = await env.ECHO.fetch('https://echo.test/', {
            method: 'POST', body: current()?.url ?? 'missing request context',
          });
          state.echoed = await response.text();
          state.contextUrl = current()?.url ?? null;
        } catch (error) {
          state.error = String(error);
        } finally {
          state.finished = true;
        }
      });
      if (url.pathname === '/reject') throw new Error('handler rejected');
      return new Response(id);
    }));
    return answer.then(
      response => { state.settled = true; return response; },
      () => { state.settled = true; return new Response('handler rejected', { status: 503 }); },
    );
  },
};
`;

interface BackgroundState {
  readonly id: string;
  readonly retained: number;
  readonly started: boolean;
  readonly finished: boolean;
  readonly settledAtStart: boolean;
  readonly contextUrl: string | null;
  readonly render: string | null;
  readonly echoed: string | null;
  readonly error: string | null;
}

describe('after-response work across real Worker request lifetimes', () => {
  let runtime: Miniflare | undefined;
  let origin: URL;

  beforeAll(async () => {
    const output = await bundleInlineWorker({
      stdin: {
        contents: WORKER,
        sourcefile: 'after-response-worker.mjs',
        resolveDir: import.meta.dirname,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2024',
      external: ['node:*'],
    });
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({
        workers: [
          {
            name: 'after-response',
            modulesRoot: '/after-response',
            modules: [
              {
                type: 'ESModule',
                path: '/after-response/index.mjs',
                contents: output.outputFiles[0]!.text,
              },
            ],
            compatibilityDate: '2026-09-15',
            compatibilityFlags: ['nodejs_compat'],
            serviceBindings: { ECHO: 'after-response-echo' },
            unsafeDirectSockets: [{ proxy: false }],
          },
          {
            name: 'after-response-echo',
            modulesRoot: '/after-response-echo',
            modules: [
              {
                type: 'ESModule',
                path: '/after-response-echo/index.mjs',
                contents:
                  'export default { async fetch(request) { return new Response(await request.text()); } };',
              },
            ],
            compatibilityDate: '2026-09-15',
          },
        ],
      }),
      log: new Log(LogLevel.NONE),
    });
    await runtime.ready;
    origin = await runtime.unsafeGetDirectURL('after-response');
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  /** Read the complete response, releasing the fetch handler while its actual waitUntil stays live. */
  async function complete(path: string, expectedStatus = 200): Promise<string> {
    const response = await fetch(new URL(path, origin), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    expect(response.status).toBe(expectedStatus);

    return response.text();
  }

  /** Observe plain Worker state, optionally waiting there for one background lifecycle stage. */
  async function states(query: string): Promise<BackgroundState[]> {
    const response = await fetch(new URL(`/states?${query}`, origin), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    expect(response.status).toBe(200);

    return (await response.json()) as BackgroundState[];
  }

  it('retains overlapping tasks after both responses and keeps their I/O in the correct request', async () => {
    await expect(
      Promise.all([complete('/capture?id=first'), complete('/capture?id=second')]),
    ).resolves.toStrictEqual(['first', 'second']);

    const pending = await states('until=started');

    expect(pending).toHaveLength(2);

    for (const state of pending) {
      expect(state).toMatchObject({
        retained: 1,
        finished: false,
        settledAtStart: true,
        error: null,
      });
    }

    await complete('/release?id=second');
    const [second] = await states('id=second&until=finished');
    const [firstPending] = await states('id=first');

    expect(second).toMatchObject({
      contextUrl: new URL('/capture?id=second', origin).href,
      render: null,
      echoed: new URL('/capture?id=second', origin).href,
      error: null,
    });
    expect(firstPending?.finished).toBe(false);

    await complete('/release?id=first');
    const [first] = await states('id=first&until=finished');

    expect(first).toMatchObject({
      contextUrl: new URL('/capture?id=first', origin).href,
      render: null,
      echoed: new URL('/capture?id=first', origin).href,
      error: null,
    });
  });

  it('releases retained background work after a handler rejection', async () => {
    await expect(complete('/reject?id=rejected', 503)).resolves.toBe('handler rejected');

    const [pending] = await states('id=rejected&until=started');

    expect(pending).toMatchObject({ retained: 1, finished: false, settledAtStart: true });

    await complete('/release?id=rejected');
    const [finished] = await states('id=rejected&until=finished');

    expect(finished).toMatchObject({
      contextUrl: new URL('/reject?id=rejected', origin).href,
      render: null,
      echoed: new URL('/reject?id=rejected', origin).href,
      error: null,
    });
  });
});
