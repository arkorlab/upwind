import { fileURLToPath } from 'node:url';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundleInlineWorker } from './inline-worker.ts';

const REQUEST_TIMEOUT_MS = 5000;
const SCHEDULER = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));

/** A real request owns its timers and request body, even when its response starts early. */
const WORKER = `
import { installTaskScheduler, runWithTaskScheduler } from ${JSON.stringify(SCHEDULER)};
const scheduler = installTaskScheduler();
let immediateRan = false;
let retained;

function readInTask(request, delay) {
  return new Promise((resolve, reject) => {
    scheduler.taskTimer(() => {
      request.text().then(resolve, reject);
    }, delay);
  });
}

export default {
  fetch(request) {
    return runWithTaskScheduler(async () => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/orphan') {
        retained = setImmediate(() => { immediateRan = true; });
        return Response.json({ pending: scheduler.pendingImmediates() });
      }
      if (pathname === '/clear') {
        clearImmediate(retained);
        return new Response('cleared');
      }
      if (pathname === '/stream') {
        const tail = readInTask(request, 1000);
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('SHELL'));
            tail.then((body) => {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            }, (error) => controller.error(error));
          },
        }));
      }
      const pending = scheduler.pendingImmediates();
      const body = await readInTask(request, 0);
      return Response.json({ body, pending, immediateRan });
    });
  },
};
`;

describe('task scheduling across Worker requests', () => {
  let runtime: Miniflare | undefined;
  let origin: URL;

  beforeEach(async () => {
    const bundled = await bundleInlineWorker({
      stdin: {
        contents: WORKER,
        sourcefile: 'task-context.mjs',
        resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
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
            name: 'task-context',
            modulesRoot: '/task-context',
            modules: [
              {
                type: 'ESModule',
                path: '/task-context/index.mjs',
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
    origin = await runtime.unsafeGetDirectURL('task-context');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  function request(path: string, body?: string): Promise<Response> {
    return fetch(new URL(path, origin), {
      ...(body !== undefined && { method: 'POST', body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  it('does not let an immediate abandoned by a completed request block the next render', async () => {
    const orphan = await request('/orphan');

    await expect(orphan.json()).resolves.toStrictEqual({ pending: 1 });

    const next = await request('/task', 'next request');

    await expect(next.json()).resolves.toStrictEqual({
      body: 'next request',
      pending: 0,
      immediateRan: false,
    });

    // Next.js can retain a shared import signal's handle after its request has finished.
    const cleared = await request('/clear');

    await expect(cleared.text()).resolves.toBe('cleared');
  });

  it('keeps overlapping renders in the I/O context that owns their request body', async () => {
    const first = await request('/stream', 'first request');
    const reader = first.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe('SHELL');

    const second = await request('/task', 'second request');

    await expect(second.json()).resolves.toMatchObject({ body: 'second request', pending: 0 });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first request');
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});
