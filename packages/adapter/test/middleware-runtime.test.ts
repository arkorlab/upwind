import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { rolldown } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bundleRuntimeModule, runtimeEntry } from '../src/runtime-bundle.ts';

const APP = `module.exports = {
  entries: {
    '/_middleware': () => ({
      handler(request, invocation) {
        const context = globalThis[Symbol.for('@vercel/request-context')].get();
        const env = globalThis[Symbol.for('arkor.function-env')];
        invocation.waitUntil(Promise.resolve());
        return new Response(null, {headers: {
          'x-middleware-rewrite': new URL('/en', request.url).href,
          'x-context-url': context.url,
          'x-binding': env.EXAMPLE,
          'x-page-manifest': String(globalThis.__BUILD_MANIFEST),
          'x-data-request': request.headers.get('x-nextjs-data') ?? 'absent',
          'x-platform-request': request.headers.get('x-arkor-middleware') ?? 'absent',
        }});
      },
    }),
  },
};`;

const FILE_SYSTEM = `export function readFileSync(file) {
  if (file !== '/bundle/runtime.json') throw new Error('unexpected file: ' + file);
  return new TextEncoder().encode(JSON.stringify({config: globalThis.fixtureConfig ?? {basePath: ''}}));
}`;

const STUBS: Readonly<Record<string, string>> = {
  'node:fs': FILE_SYSTEM,
  'cloudflare:workers': 'export const env = {};',
  'cloudflare:node':
    'export function handleAsNodeRequest() { throw new Error("unexpected render"); }',
};

interface MiddlewareWorker {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    context: { waitUntil(pending: Promise<unknown>): void; props?: unknown },
  ): Promise<Response>;
}

async function emit(
  dir: string,
  kind: string,
  has: { edge?: boolean; wasm?: boolean } = {},
): Promise<{ file: string; code: string }> {
  const file = path.join(dir, `${kind}.mjs`);
  await bundleRuntimeModule({
    entry: runtimeEntry(kind),
    outFile: file,
    moduleName: 'index.mjs',
    kind,
    name: kind,
    workflowSdk: false,
    modules: { app: 'app.cjs', edge: 'edge.cjs' },
    edge: has.edge === true,
    wasm: has.wasm === true,
    cacheHostModule: undefined,
  });
  return { file, code: await readFile(file, 'utf8') };
}

/** Run the emitted Worker with virtual bundle files and platform imports, without a listening server. */
async function workerFor(
  file: string,
  globals: Readonly<Record<string, unknown>> = {},
): Promise<MiddlewareWorker> {
  await using bundle = await rolldown({
    input: file,
    platform: 'node',
    external: (specifier) => specifier.startsWith('node:') && !Object.hasOwn(STUBS, specifier),
    plugins: [
      {
        name: 'test-platform',
        resolveId: (specifier) => (Object.hasOwn(STUBS, specifier) ? `\0${specifier}` : undefined),
        load: (id) => STUBS[id.slice(1)],
      },
    ],
  });
  const { output } = await bundle.generate({ format: 'cjs', exports: 'named' });
  const module = { exports: {} };
  // eslint-disable-next-line sonarjs/code-eval -- Only this repository's bundled runtime and the fixed fixture above run in the isolated test context.
  runInNewContext(output[0].code, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    fetch,
    crypto,
    performance,
    console,
    process: { env: { NODE_ENV: 'production' } },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    __BUILD_MANIFEST: { page: true },
    ...globals,
  });
  return (module.exports as { default: MiddlewareWorker }).default;
}

function request(): Request {
  return new Request('https://internal.test/', {
    headers: {
      'x-arkor-middleware': '1',
      'x-forwarded-host': 'site.test',
      'x-forwarded-proto': 'https',
    },
  });
}

describe('the emitted middleware runtime', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'upwind-middleware-runtime-'));
    await writeFile(path.join(dir, 'app.cjs'), APP);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves page regeneration, full routing and the Node HTTP bridge out of middleware', async () => {
    const middleware = await emit(dir, 'middleware');
    const app = await emit(dir, 'app');

    expect(middleware.code).not.toContain('function warmResourceRoute(');
    expect(middleware.code).not.toContain('function regenerate(');
    expect(middleware.code).not.toMatch(
      /responseToMiddlewareResult|resolveRoutes|node:http|cloudflare:node/u,
    );
    expect(app.code).toContain('function warmResourceRoute(');
    expect(app.code).toContain('function regenerate(');
    expect(app.code).toContain('node:http');
  });

  it('keeps WebAssembly before generated modules and platform hooks before entrypoint initialization', async () => {
    await writeFile(path.join(dir, 'wasm.mjs'), 'globalThis.fixtureWasm = true;');
    await writeFile(
      path.join(dir, 'app.cjs'),
      `if (globalThis.fixtureWasm !== true) throw new Error('WebAssembly not published');
      globalThis.fixtureApp = true;
      function fixtureHooks() {
        if (typeof globalThis[Symbol.for('arkor.fetch-cache-write')] !== 'function') {
          throw new Error('platform hooks not installed before entrypoint initialization');
        }
      }
      ${APP.replace("'/_middleware': () => ({", "'/_middleware': () => (fixtureHooks(), {")}`,
    );
    await writeFile(
      path.join(dir, 'edge.cjs'),
      `if (globalThis.fixtureApp !== true) throw new Error('application module not evaluated');
      module.exports = {entries: {}};`,
    );
    const { file } = await emit(dir, 'middleware', { edge: true, wasm: true });
    const worker = await workerFor(file);
    const response = await worker.fetch(request(), {}, { waitUntil: vi.fn() });

    expect(response.headers.get('x-middleware-rewrite')).toBe('https://internal.test/en');
  });

  it.each(['app', 'edge'])(
    'awaits a %s middleware module without losing its invocation context',
    async (graph) => {
      const ready = Promise.withResolvers<undefined>();
      const invoked: string[] = [];
      const filename = graph === 'app' ? 'app.cjs' : 'edge.cjs';
      await writeFile(path.join(dir, 'app.cjs'), 'module.exports = {entries: {}};');
      await writeFile(
        path.join(dir, filename),
        `module.exports = {entries: {'/_middleware': async () => {
        await globalThis.fixtureReady;
        return {handler: async (request) => {
          const context = globalThis[Symbol.for('@vercel/request-context')].get();
          globalThis.fixtureInvoked.push(context.url);
          return new Response(String(globalThis.__BUILD_MANIFEST));
        }};
      }}};`,
      );
      const { file } = await emit(dir, 'middleware', { edge: graph === 'edge' });
      const worker = await workerFor(file, {
        fixtureReady: ready.promise,
        fixtureInvoked: invoked,
      });
      const response = worker.fetch(request(), {}, { waitUntil: vi.fn() });

      expect(invoked).toStrictEqual([]);

      ready.resolve(undefined);

      await expect((await response).text()).resolves.toBe('undefined');
      expect(invoked).toStrictEqual(['https://site.test/']);
    },
  );

  it('sets the data marker from the path under the base path and strips platform request headers', async () => {
    const { file } = await emit(dir, 'middleware');
    const worker = await workerFor(file, { fixtureConfig: { basePath: '/docs' } });
    const data = await worker.fetch(
      new Request('https://internal.test/docs/_next/data/build/page.json', {
        headers: { 'x-arkor-middleware': '1' },
      }),
      {},
      { waitUntil: vi.fn() },
    );
    const plain = await worker.fetch(
      new Request('https://internal.test/docs/page', {
        headers: { 'x-arkor-middleware': '1', 'x-nextjs-data': 'forged' },
      }),
      {},
      { waitUntil: vi.fn() },
    );

    expect(data.headers.get('x-data-request')).toBe('1');
    expect(plain.headers.get('x-data-request')).toBe('absent');
    expect(data.headers.get('x-platform-request')).toBe('absent');
  });

  it('keeps non-middleware dispatches at 404 and an absent middleware at next', async () => {
    await writeFile(path.join(dir, 'app.cjs'), 'module.exports = {entries: {}};');
    const { file } = await emit(dir, 'middleware');
    const worker = await workerFor(file);
    const ordinary = await worker.fetch(
      new Request('https://site.test/'),
      {},
      { waitUntil: vi.fn() },
    );
    const absent = await worker.fetch(request(), {}, { waitUntil: vi.fn() });

    expect(ordinary.status).toBe(404);
    await expect(ordinary.text()).resolves.toBe('middleware function');
    expect(absent.status).toBe(200);
    expect(absent.headers.get('x-middleware-next')).toBe('1');
  });

  it('preserves the raw middleware response status, cookies and body', async () => {
    await writeFile(
      path.join(dir, 'app.cjs'),
      `module.exports = {entries: {'/_middleware': () => ({handler: async () => {
        const headers = new Headers({location: 'https://site.test/login'});
        headers.append('set-cookie', 'first=1; Path=/');
        headers.append('set-cookie', 'second=2; Path=/');
        return new Response('redirect body', {status: 307, headers});
      }})}};`,
    );
    const { file } = await emit(dir, 'middleware');
    const worker = await workerFor(file);
    const response = await worker.fetch(request(), {}, { waitUntil: vi.fn() });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://site.test/login');
    expect(response.headers.getSetCookie()).toStrictEqual(['first=1; Path=/', 'second=2; Path=/']);
    await expect(response.text()).resolves.toBe('redirect body');
  });

  it('answers a rejected middleware module load and lets the next request retry it', async () => {
    await writeFile(
      path.join(dir, 'app.cjs'),
      `let loads = 0;
      module.exports = {entries: {'/_middleware': async () => {
        if (loads++ === 0) throw new Error('middleware initialization failed');
        return {handler: async () => new Response('retried')};
      }}};`,
    );
    const { file } = await emit(dir, 'middleware');
    const failed = vi.fn();
    const worker = await workerFor(file, { console: { ...console, error: failed } });
    const first = await worker.fetch(request(), {}, { waitUntil: vi.fn() });
    const second = await worker.fetch(request(), {}, { waitUntil: vi.fn() });

    expect(first.status).toBe(500);
    await expect(first.text()).resolves.toBe(
      'Internal Server Error: middleware initialization failed',
    );
    await expect(second.text()).resolves.toBe('retried');
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('preserves middleware bindings, request context and waitUntil with unrelated execution props', async () => {
    const { file } = await emit(dir, 'middleware');
    const worker = await workerFor(file);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(
      request(),
      { EXAMPLE: 'bound' },
      {
        props: { resourceWarm: { v: 2 } },
        waitUntil: (work) => {
          pending.push(work);
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toBe('https://internal.test/en');
    expect(response.headers.get('x-context-url')).toBe('https://site.test/');
    expect(response.headers.get('x-binding')).toBe('bound');
    expect(response.headers.get('x-page-manifest')).toBe('undefined');
    expect(pending).toHaveLength(1);

    await Promise.all(pending);
  });

  it('still rejects a trusted page-warm request without invoking middleware', async () => {
    const { file } = await emit(dir, 'middleware');
    const worker = await workerFor(file);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(
      request(),
      {},
      {
        props: {
          resourceWarm: {
            v: 1,
            scopeId: 'deployment',
            entry: { kind: 'app-page', route: '/', pathname: '/' },
          },
        },
        waitUntil: (work) => {
          pending.push(work);
        },
      },
    );

    expect(response.headers.has('x-middleware-rewrite')).toBe(false);
    await expect(response.json()).resolves.toStrictEqual({ v: 1, kind: 'unsupported' });
    expect(pending).toHaveLength(1);

    await Promise.all(pending);
  });
});
