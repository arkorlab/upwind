import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

import { uuid4 } from '@sentry/core';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { installRandomSafeContext } from '../src/random-safe-context.ts';
import {
  installRequestContext,
  type VercelRequestContext,
  withRequestContext,
} from '../src/request-context.ts';
import { bundleInlineWorker } from './inline-worker.ts';

// The time each test had where this suite ran before: it starts workerd and Miniflare, which a
// loaded machine can take longer than the default to have ready (Sentry).
vi.setConfig({ testTimeout: 60_000 });

/**
 * The runner the runtime answers Sentry's global symbol with (`random-safe-context.ts`): what
 * `@sentry/core` reads `crypto.randomUUID()`, `Math.random()` and the clock through, so that a read
 * made while Next.js prerenders runs outside the prerender. The SDK's own runner enters one
 * snapshot for the whole isolate, which workerd refuses outside the request that took it, and its
 * fallback then reads inside whichever render is running — and Next.js aborts a prerender that
 * reads one of those (`cacheComponents`).
 *
 * Next.js's work-unit store is stood for by a store of our own, entered after the request: what a
 * read must not run in.
 */

const RUNNER = Symbol.for('__SENTRY_SAFE_RANDOM_ID_WRAPPER__');
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const RUNTIME_SOURCES = fileURLToPath(new URL('../src/', import.meta.url));
const REQUEST_TIMEOUT_MS = 10_000;

type Runner = <T>(read: () => T) => T;

function installedRunner(): Runner {
  const runner: unknown = Reflect.get(globalThis, RUNNER);
  if (typeof runner !== 'function') {
    throw new TypeError('no runner under the symbol');
  }
  return runner as Runner;
}

function requestContextNow(): VercelRequestContext | undefined {
  const holder = Reflect.get(globalThis, REQUEST_CONTEXT) as
    | { get: () => VercelRequestContext | undefined }
    | undefined;
  return holder?.get();
}

function contextFor(url: string): VercelRequestContext {
  return {
    headers: {},
    url,
    waitUntil: () => {
      // Nothing these requests start outlives them.
    },
  };
}

function turn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
}

describe('the runner Sentry reads its random values in, under Node.js', () => {
  /** What the stand-in for Next.js's store held, at each `crypto.randomUUID()` the SDK made. */
  const render = new AsyncLocalStorage<string>();
  const readsInRender: string[] = [];
  const nativeRandomUUID = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  const sdkReads: unknown[] = [];

  beforeAll(() => {
    installRequestContext();
    installRandomSafeContext();
    const randomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        const store = render.getStore();
        if (store !== undefined) {
          readsInRender.push(store);
        }
        return randomUUID();
      },
    });
    // What `@sentry/nextjs` assigns as it is set up: a runner of its own, kept as the fallback.
    Reflect.set(globalThis, RUNNER, <T>(read: () => T): T => {
      sdkReads.push(read);
      return read();
    });
  });

  afterAll(() => {
    // Node.js has `randomUUID` on `Crypto.prototype`, not on the instance: then the property this
    // suite defined is removed, and the prototype's shows through again.
    if (nativeRandomUUID === undefined) {
      Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
    } else {
      Object.defineProperty(globalThis.crypto, 'randomUUID', nativeRandomUUID);
    }
    Reflect.deleteProperty(globalThis, RUNNER);
    Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
  });

  it('is a function under the symbol whatever the SDK assigned there', () => {
    expect(Reflect.has(globalThis, RUNNER)).toBe(true);
    expect(installedRunner()).toBeTypeOf('function');

    const before = sdkReads.length;
    installedRunner()(() => 1);

    // Outside a request there is no context to enter, and the read goes through the SDK's own.
    expect(sdkReads).toHaveLength(before + 1);
  });

  it('runs the IDs `@sentry/core` makes during a render outside it, within the request', async () => {
    readsInRender.length = 0;
    const context = contextFor('https://fixture.test/a');
    const seen = await withRequestContext(context, () => {
      return render.run('prerender of /a', async () => {
        await turn();

        expect(uuid4()).toMatch(/^[\da-f]{32}$/u);

        return installedRunner()(() => {
          return {
            render: render.getStore(),
            request: requestContextNow(),
          };
        });
      });
    });

    expect(readsInRender).toStrictEqual([]);
    expect(seen.render).toBeUndefined();
    // Still the request it was made for: what the runtime keeps for it is there.
    expect(seen.request).toBe(context);
  });

  it("runs each request's reads in that request's own entry, however they interleave", async () => {
    readsInRender.length = 0;
    const each = (path: string): Promise<(string | undefined)[]> => {
      const context = contextFor(`https://fixture.test${path}`);
      return withRequestContext(context, () => {
        return render.run(`prerender of ${path}`, async () => {
          const urls: (string | undefined)[] = [];
          for (let step = 0; step < 4; step += 1) {
            uuid4();
            urls.push(installedRunner()(() => requestContextNow()?.url));
            await turn();
          }
          return urls;
        });
      });
    };

    const [first, second] = await Promise.all([each('/one'), each('/two')]);

    expect(readsInRender).toStrictEqual([]);
    expect(new Set(first)).toStrictEqual(new Set(['https://fixture.test/one']));
    expect(new Set(second)).toStrictEqual(new Set(['https://fixture.test/two']));
  });

  it('hands back what the read threw, having run it once', async () => {
    const before = sdkReads.length;
    let runs = 0;

    await withRequestContext(contextFor('https://fixture.test/throws'), () => {
      expect(() => {
        return installedRunner()(() => {
          runs += 1;
          throw new RangeError('the read failed');
        });
      }).toThrow(RangeError);

      return Promise.resolve();
    });

    expect(runs).toBe(1);
    expect(sdkReads).toHaveLength(before);
  });
});

/**
 * The same under workerd, which is where the SDK's own runner fails: one Worker with the runtime's
 * runner installed and one without, each making IDs with `@sentry/core` in two requests at once.
 * `setUpSdk` is `prepareSafeIdGeneratorContext` of `@sentry/nextjs` (10.74 to 11.4.0), as it sets
 * its runner up: one snapshot for the isolate, replaced by a snapshot of wherever a read is made
 * once the one it has cannot be entered.
 */
const WORKER = `
import { AsyncLocalStorage } from 'node:async_hooks';
import { uuid4 } from '@sentry/core';
import { installRandomSafeContext } from ${JSON.stringify(`${RUNTIME_SOURCES}random-safe-context.ts`)};
import { withRequestContext } from ${JSON.stringify(`${RUNTIME_SOURCES}request-context.ts`)};

if (INSTALL_RUNNER) {
  installRandomSafeContext();
}

const render = new AsyncLocalStorage();
const readsInRender = [];
const randomUUID = crypto.randomUUID.bind(crypto);
crypto.randomUUID = () => {
  const store = render.getStore();
  if (store !== undefined) {
    readsInRender.push(store);
  }
  return randomUUID();
};

function isAsyncLocalStorageError(error) {
  return error instanceof Error && error.message.includes('AsyncLocalStorage');
}

function setUpSdk() {
  let snapshot = AsyncLocalStorage.snapshot();
  globalThis[Symbol.for('__SENTRY_SAFE_RANDOM_ID_WRAPPER__')] = (callback) => {
    try {
      return snapshot(callback);
    } catch (error) {
      if (!isAsyncLocalStorageError(error)) throw error;
      snapshot = AsyncLocalStorage.snapshot();
      try {
        return snapshot(callback);
      } catch (retry) {
        if (!isAsyncLocalStorageError(retry)) throw retry;
        return callback();
      }
    }
  };
}

function turn(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderFor(pathname) {
  await render.run(pathname, async () => {
    for (let step = 0; step < 6; step += 1) {
      uuid4();
      await turn(1);
    }
  });
}

// Read across requests, never awaited across them: workerd holds a promise to the request that made it.
let sdkSetUp = false;
const encoder = new TextEncoder();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/reads-in-render') {
      return Response.json(readsInRender);
    }
    const context = { headers: {}, url: request.url, waitUntil() {} };
    if (url.pathname === '/early') {
      // A request that entered the Function before the SDK was set up: it says so in its first line,
      // and renders once another request has set the SDK up.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      withRequestContext(context, async () => {
        await writer.write(encoder.encode('entered\\n'));
        for (let waited = 0; !sdkSetUp; waited += 1) {
          if (waited > 1000) {
            throw new Error('the SDK was never set up');
          }
          await turn(1);
        }
        await renderFor(url.pathname);
        await writer.write(encoder.encode('rendered\\n'));
      }).then(
        () => writer.close(),
        (error) => writer.abort(error),
      );
      return new Response(readable);
    }
    return withRequestContext(context, async () => {
      if (url.searchParams.has('set-up')) {
        // Where an application sets the SDK up in \`register()\`: inside its isolate's first request.
        setUpSdk();
        sdkSetUp = true;
        uuid4();
      }
      await renderFor(url.pathname);
      return new Response('rendered');
    });
  },
};
`;

/** The Worker above, with the runtime's runner installed or not. */
async function bundled(installRunner: boolean): Promise<string> {
  const output = await bundleInlineWorker({
    stdin: {
      contents: WORKER,
      sourcefile: 'random-safe-context.mjs',
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    external: ['node:*'],
    define: { INSTALL_RUNNER: JSON.stringify(installRunner) },
  });
  return output.outputFiles[0]!.text;
}

/** A pull source that hands on what `reader` has left to read. */
function pump<T>(
  reader: ReadableStreamDefaultReader<T>,
): (controller: ReadableStreamDefaultController<T>) => Promise<void> {
  return async (controller) => {
    const { done, value } = await reader.read();
    if (done) {
      controller.close();
    } else {
      controller.enqueue(value);
    }
  };
}

const WORKERS = { withRunner: 'with-runner', withoutRunner: 'without-runner' } as const;

describe('the runner Sentry reads its random values in, under workerd', () => {
  let runtime: Miniflare | undefined;
  const origins = new Map<string, URL>();

  async function start(): Promise<void> {
    await runtime?.dispose();
    const workers = await Promise.all(
      [
        { name: WORKERS.withRunner, installRunner: true },
        { name: WORKERS.withoutRunner, installRunner: false },
      ].map(async ({ name, installRunner }) => {
        return {
          name,
          modulesRoot: `/${name}`,
          modules: [
            {
              type: 'ESModule' as const,
              path: `/${name}/index.mjs`,
              contents: await bundled(installRunner),
            },
          ],
          compatibilityDate: '2026-09-15',
          compatibilityFlags: ['nodejs_compat'],
          unsafeDirectSockets: [{ proxy: false }],
        };
      }),
    );
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({ workers }),
      log: new Log(LogLevel.NONE),
    });
    await runtime.ready;
    for (const name of Object.values(WORKERS)) {
      origins.set(name, await runtime.unsafeGetDirectURL(name));
    }
  }

  async function request(worker: string, path: string): Promise<Response> {
    const response = await fetch(new URL(path, origins.get(worker)), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    expect(response.status).toBe(200);

    return response;
  }

  async function readsInRender(worker: string): Promise<string[]> {
    const response = await request(worker, '/reads-in-render');
    return (await response.json()) as string[];
  }

  afterAll(async () => {
    await runtime?.dispose();
  });

  it('keeps the reads of two requests at once out of their renders', async () => {
    await start();
    for (const worker of Object.values(WORKERS)) {
      await request(worker, '/first?set-up');
      await Promise.all([request(worker, '/one'), request(worker, '/two')]);
    }

    await expect(readsInRender(WORKERS.withRunner)).resolves.toStrictEqual([]);
    // What the runner is for: without it, the SDK's own reads inside the renders.
    await expect(readsInRender(WORKERS.withoutRunner)).resolves.not.toStrictEqual([]);
  });

  it('keeps them out for a request that entered before the SDK was set up', async () => {
    await start();
    for (const worker of Object.values(WORKERS)) {
      const early = await request(worker, '/early');
      const reader = early.body!.getReader();

      const first = await reader.read();

      // In the Function before the SDK is set up, and holding its render until it is.
      expect(new TextDecoder().decode(first.value)).toBe('entered\n');

      await request(worker, '/first?set-up');

      const rest = new Response(new ReadableStream({ pull: pump(reader) })).text();

      await expect(rest).resolves.toBe('rendered\n');
    }

    await expect(readsInRender(WORKERS.withRunner)).resolves.toStrictEqual([]);
    await expect(readsInRender(WORKERS.withoutRunner)).resolves.toContain('/early');
  });
});
