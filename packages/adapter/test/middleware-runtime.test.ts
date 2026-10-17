import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { rolldown } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundleRuntimeModule } from '../src/runtime-bundle.ts';

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
        }});
      },
    }),
  },
};`;

const FILE_SYSTEM = `export function readFileSync(file) {
  if (file !== '/bundle/runtime.json') throw new Error('unexpected file: ' + file);
  return new TextEncoder().encode(JSON.stringify({config: {basePath: ''}}));
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

async function emit(dir: string, kind: string): Promise<{ file: string; code: string }> {
  const file = path.join(dir, `${kind}.mjs`);
  await bundleRuntimeModule({
    entry: fileURLToPath(import.meta.resolve('@stayingupwind/runtime/function')),
    outFile: file,
    moduleName: 'index.mjs',
    kind,
    name: kind,
    workflowSdk: false,
    modules: { app: 'app.cjs', edge: 'edge.cjs' },
    edge: false,
    wasm: false,
    cacheHostModule: undefined,
  });
  return { file, code: await readFile(file, 'utf8') };
}

/** Run the emitted Worker with virtual bundle files and platform imports, without a listening server. */
async function workerFor(file: string): Promise<MiddlewareWorker> {
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

  it('leaves page regeneration out of middleware while keeping it in application Functions', async () => {
    const middleware = await emit(dir, 'middleware');
    const app = await emit(dir, 'app');

    expect(middleware.code).not.toContain('function warmResourceRoute(');
    expect(middleware.code).not.toContain('function regenerate(');
    expect(app.code).toContain('function warmResourceRoute(');
    expect(app.code).toContain('function regenerate(');
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
