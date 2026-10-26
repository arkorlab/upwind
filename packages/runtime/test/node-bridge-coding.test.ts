import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bundleInlineWorker } from './inline-worker.ts';

// It starts workerd and Miniflare, which a loaded machine can take longer than the default to have
// ready, as the other suites that do (`task-pump-latch.test.ts`).
vi.setConfig({ testTimeout: 60_000 });

/**
 * A Node.js handler's answer as it goes out of workerd. workerd's `node:http` server makes the
 * `Response` with `encodeBody: 'automatic'`, and workerd encodes such a body to the
 * `content-encoding` it goes out with: a route that gzips its own answer and says so reached its
 * client compressed twice, so a client that decoded it once read gzip. And its `ServerResponse`
 * starts at the reason `unknown`, which an answer made from the response itself keeps.
 *
 * Only the wire shows either, so the Worker below is served by workerd and asked over HTTP.
 */

const REQUEST_TIMEOUT_MS = 5000;
const BRIDGE = fileURLToPath(new URL('../src/node-bridge.ts', import.meta.url));
const REFRAME = fileURLToPath(new URL('../src/reframe.ts', import.meta.url));
const TEXT = 'compressed by the route itself';

const WORKER = `
import { gzipSync } from 'node:zlib';
import { invokeNodeHandler } from ${JSON.stringify(BRIDGE)};
import { withHeadersChanged, withStatus } from ${JSON.stringify(REFRAME)};

const handlers = {
  // A route that compresses its own answer and says so, as Node.js's server sends it as written.
  '/coded': (_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.setHeader('content-encoding', 'gzip');
    res.end(gzipSync(${JSON.stringify(TEXT)}));
    return Promise.resolve();
  },
  // One that names no status, so the reason is the one its response starts at.
  '/plain': (_req, res) => {
    res.end('plain');
    return Promise.resolve();
  },
};

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const handler = handlers[url.pathname];
    const response = await invokeNodeHandler({
      handler,
      request,
      requestMeta: {},
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
    // As the runtime's answers are made again on the way out, each with a header of its own, and
    // under the status a rewrite names.
    const changed = url.searchParams.has('changed')
      ? withHeadersChanged(response, (headers) => { headers.set('x-changed', '1'); })
      : response;
    return url.searchParams.has('restated') ? withStatus(changed, 404, changed.body) : changed;
  },
};
`;

describe('a Node.js answer as workerd sends it', () => {
  let runtime: Miniflare | undefined;
  let origin: URL;

  beforeAll(async () => {
    const bundled = await bundleInlineWorker({
      stdin: {
        contents: WORKER,
        sourcefile: 'node-bridge-coding.mjs',
        resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2024',
      external: ['node:*', 'cloudflare:*'],
    });
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({
        workers: [
          {
            name: 'node-bridge-coding',
            modulesRoot: '/node-bridge-coding',
            modules: [
              {
                type: 'ESModule',
                path: '/node-bridge-coding/index.mjs',
                contents: bundled.outputFiles[0]!.text,
              },
            ],
            compatibilityDate: '2026-09-15',
            compatibilityFlags: ['nodejs_compat'],
            unsafeDirectSockets: [{ proxy: false }],
          },
        ],
      }),
      log: new Log(LogLevel.NONE),
    });
    await runtime.ready;
    origin = await runtime.unsafeGetDirectURL('node-bridge-coding');
  });

  afterAll(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  /** The answer's coding, and its body decoded once, as a client that asked for gzip decodes it. */
  async function decodedOnce(path: string): Promise<{ coding: string | null; text: string }> {
    const response = await fetch(new URL(path, origin), {
      headers: { 'accept-encoding': 'gzip' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    // Node.js's Fetch decodes a coded body before it hands it over: what it hands is what a client
    // reads, and gzip still, where it went out compressed twice.
    const text =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? `gzip: ${gunzipSync(bytes).toString()}`
        : bytes.toString();
    return { coding: response.headers.get('content-encoding'), text };
  }

  it.each(['/coded', '/coded?changed', '/coded?restated', '/coded?changed&restated'])(
    'sends a body the route compressed itself once, under its own coding (%s)',
    async (path) => {
      await expect(decodedOnce(path)).resolves.toStrictEqual({ coding: 'gzip', text: TEXT });
    },
  );

  it.each(['/plain', '/plain?changed'])(
    'names the status’s own reason where the handler named none (%s)',
    async (path) => {
      const response = await fetch(new URL(path, origin), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      expect(response.statusText).toBe('OK');
      await expect(response.text()).resolves.toBe('plain');
    },
  );
});
