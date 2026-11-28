import { sha256Hex } from '@stayingupwind/core/artifact';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { describe, expect, it, vi } from 'vitest';

import type {
  ContinuationHandle,
  ContinuationStart,
  ShellRead,
} from '../../host/src/delivery/strategy.ts';
import { handleDocument } from '../src/handlers/document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { buildPprDocument, htmlResponse } from './helpers/document.ts';

/**
 * Where a document's pre-compressed rendering is read from storage, against the resume: after the
 * resume is dispatched, since only a rendering the isolate holds can serve the response, and a read
 * of storage for one must take no place ahead of the resume among the requests the Worker has out.
 */

const { asked, startResume } = vi.hoisted(() => {
  const order: string[] = [];
  const start = vi.fn<(input: ContinuationStart<EdgeContext>) => ContinuationHandle>();
  return { asked: order, startResume: start };
});
vi.mock(import('../src/strategies/continuation-resume.ts'), () => {
  const resumeContinuation = { start: startResume };
  return { resumeContinuation };
});

function now(): number {
  return 1_800_000_000_000;
}

/** A gzip rendering's head as the edge sends it: bytes it does not look into. */
const RENDERING = encodeUtf8('the head of the shell, compressed ahead');

/**
 * A document of a route with a gzip rendering of its shell, whose identity shell is in hand, asked
 * for by a client that takes gzip: the response, and the reads and dispatch it made, in order.
 * `held` puts the rendering in the isolate's memory first.
 */
async function delivered(held: boolean) {
  asked.length = 0;
  const document = buildPprDocument();
  const rendering = {
    sha256: await sha256Hex(RENDERING),
    byteLength: RENDERING.byteLength,
    contentType: 'text/html',
    encoding: 'gzip' as const,
    crc32: 0,
  };
  const entry: RouteEntry = {
    pathname: '/',
    status: 200,
    headers: { 'content-type': 'text/html' },
    prerenderId: '/',
    shell: {
      sha256: await sha256Hex(document.shell),
      byteLength: document.shell.byteLength,
      contentType: 'text/html',
      encoding: 'identity',
    },
    shellEncodings: { gzip: rendering },
  };
  const manifest = buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    originHost: 'app.test',
    generatedAt: '2026-10-28T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-28T00:00:00.000Z' },
    app: { deploymentId: 'dpl_rendering', scriptName: 'app' },
    routes: [entry],
  });
  const suffix = Promise.withResolvers<Response>();
  startResume.mockImplementation(() => {
    asked.push('resume');
    return { response: suffix.promise, abort: vi.fn() };
  });
  // Storage holds the rendering back until the test lets it go: the response must not wait for it.
  const stored = Promise.withResolvers<ShellRead | undefined>();
  const getShell = vi.fn(() => {
    asked.push('rendering from storage');
    return stored.promise;
  });
  const memory = createEdgeMemory(now);
  if (held) {
    memory.shells.set(rendering.sha256, RENDERING, RENDERING.byteLength);
  }
  const tasks: Promise<unknown>[] = [];
  const edge = {
    runtime: { now, memory },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    // The rendering from the shell's own store alone, with no Cache API copy raced beside it.
    policy: {
      ...DEFAULT_DELIVERY_POLICY,
      shell: { backend: 'kv', memoryLru: true, cacheApiLayer: false },
    },
    host: { names: {}, credentials: {} },
    validated: false,
    privateDelivery: false,
    cspNonce: false,
    cacheApi: false,
    projectId: 'project',
    manifestId: 'manifest',
    timings: {},
    app: manifest.app,
  } as unknown as EdgeContext;
  const response = await handleDocument({
    request: new Request('https://app.test/', { headers: { 'accept-encoding': 'gzip' } }),
    entry,
    manifest,
    edge,
    middleware: undefined,
    generation: undefined,
    shellRead: Promise.resolve({
      kind: 'ok',
      read: { bytes: document.shell, source: 'memory', latencyMs: 0 },
    }),
    resolved: {
      policy: edge.policy,
      shell: { id: 'kv', getShell },
      assets: {
        id: 'passthrough',
        handle: () => Promise.reject(new Error('no asset is requested')),
      },
    },
    passthrough: () => Promise.reject(new Error('the shell must be served')),
  });
  const order = [...asked];
  const reader = response.body?.getReader();
  const first = (await reader?.read())?.value as Uint8Array | undefined;
  const finish = async (): Promise<void> => {
    stored.resolve(undefined);
    suffix.resolve(htmlResponse([document.suffix]));
    await reader?.cancel();
    await Promise.all(tasks);
  };
  return { response, order, first, getShell, finish };
}

describe('a document with a rendering of its shell', () => {
  it('dispatches its resume before it asks storage for the rendering, and waits for neither', async () => {
    const result = await delivered(false);
    try {
      expect(result.order).toStrictEqual(['resume', 'rendering from storage']);
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get('content-encoding')).toBe('gzip');
      // The identity shell, compressed on the way out: the rendering was still being read.
      expect(result.first).not.toStrictEqual(RENDERING);
    } finally {
      await result.finish();
    }
  });

  it('still sends the rendering the isolate holds, as its first bytes', async () => {
    const result = await delivered(true);
    try {
      expect(result.order).toStrictEqual(['resume']);
      expect(result.getShell).not.toHaveBeenCalled();
      expect(result.response.headers.get('content-encoding')).toBe('gzip');
      expect(result.first).toStrictEqual(RENDERING);
    } finally {
      await result.finish();
    }
  });
});
