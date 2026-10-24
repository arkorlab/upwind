import { sha256Hex } from '@stayingupwind/core/artifact';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { describe, expect, it, vi } from 'vitest';

import type { ContinuationHandle, ContinuationStart } from '../../host/src/delivery/strategy.ts';
import { handleDocument } from '../src/handlers/document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { buildPprDocument, htmlResponse } from './helpers/document.ts';

const startResume = vi.hoisted(() => {
  const start = vi.fn<(input: ContinuationStart<EdgeContext>) => ContinuationHandle>();
  return start;
});
vi.mock(import('../src/strategies/continuation-resume.ts'), () => {
  const resumeContinuation = { start: startResume };
  return { resumeContinuation };
});

function decoded(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new TypeError('the shell must be a byte chunk');
  return new TextDecoder().decode(value);
}

function now(): number {
  return 1_800_000_000_000;
}

describe('the build shell’s resume', () => {
  it('forwards build-upgrade instructions beside a resume while flushing the existing shell first', async () => {
    const document = buildPprDocument({ dplId: 'dpl_partial', omitBuildId: true });
    const route = '/[slug]';
    const entry: RouteEntry = {
      pathname: route,
      status: 200,
      headers: { 'content-type': 'text/html' },
      prerenderId: route,
      shell: {
        sha256: await sha256Hex(document.shell),
        byteLength: document.shell.byteLength,
        contentType: 'text/html',
        encoding: 'identity',
      },
      partialFallback: { route },
    };
    const manifest = buildProjectManifest({
      projectId: 'project',
      runId: 'run',
      originHost: 'app.test',
      generatedAt: '2026-10-18T00:00:00.000Z',
      deployment: { assetSetHash: 'assets', observedAt: '2026-10-18T00:00:00.000Z' },
      app: { deploymentId: 'dpl_partial', scriptName: 'app' },
      routes: [entry],
    });
    const suffix = Promise.withResolvers<Response>();
    startResume.mockReturnValue({ response: suffix.promise, abort: vi.fn() });
    const tasks: Promise<unknown>[] = [];
    const edge = {
      runtime: { now, memory: createEdgeMemory(now) },
      ctx: {
        waitUntil: (task: Promise<unknown>) => {
          tasks.push(task);
        },
      },
      policy: DEFAULT_DELIVERY_POLICY,
      host: { names: {}, credentials: {} },
      validated: false,
      privateDelivery: false,
      cacheApi: false,
      projectId: 'project',
      manifestId: 'manifest',
      timings: {},
      app: manifest.app,
    } as unknown as EdgeContext;
    const headers = {
      'x-arkor-regenerate': 'background',
      'x-arkor-cache-route': route,
      'x-arkor-cache-upgrade': '1',
    };
    const onBuildServed = vi.fn();
    const response = await handleDocument({
      request: new Request('https://app.test/two', { headers: { 'accept-encoding': 'identity' } }),
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
        policy: DEFAULT_DELIVERY_POLICY,
        shell: { id: 'kv', getShell: () => Promise.resolve(undefined) },
        assets: {
          id: 'passthrough',
          handle: () => Promise.reject(new Error('no asset is requested')),
        },
      },
      buildRegeneration: headers,
      onBuildServed,
      passthrough: () => Promise.reject(new Error('the built shell must be served')),
    });

    expect(onBuildServed).toHaveBeenCalledTimes(1);

    const reader = response.body?.getReader();
    const first = await reader?.read();

    expect(decoded(first?.value)).toContain('Static header');
    expect(startResume).toHaveBeenCalledWith(expect.objectContaining({ headers }));

    suffix.resolve(htmlResponse([document.suffix]));
    await reader?.cancel();
    await Promise.all(tasks);
  });
});
