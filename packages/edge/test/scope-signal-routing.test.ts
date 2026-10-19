import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type EdgePointer,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

async function fixture() {
  const document = pprDocument();
  const site = await seedSite({ document });
  const scopeId = crypto.randomUUID();
  const signalCache = `routing-signals-${scopeId}`;
  const manifest: ProjectManifest = {
    ...site.manifest,
    cache: { keySchemaVersion: 1, scopeId },
    routes: {
      '/': {
        ...site.manifest.routes['/']!,
        cache: { entryId: 'entry-routing', kind: 'app-page', delivery: 'resume' },
      },
    },
  };
  const release = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const scopeSignals = vi.fn(async () => {
    entered.resolve(undefined);
    await release.promise;
    return { revision: 0, invalidatedAt: null, tags: [], truncated: false, announced: false };
  });
  const base = standaloneHost(env);
  const host: EdgeHost = {
    ...base,
    names: { ...base.names, signalCache },
    scopeSignals: { scopeSignals, cacheTagOf: (scope) => `routing-${scope}` },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () => Promise.resolve(htmlResponse(document.suffix)),
  });
  const shell = manifest.routes['/']!.shell;
  runtime.memory.shells.set(shell.sha256, document.shell, document.shell.byteLength);
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend: 'passthrough' as const },
    runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' as const },
  };
  const ctx = createExecutionContext();
  const opened = vi.spyOn(caches, 'open');
  const serve = ({
    pathname = '/',
    method = 'GET',
    mode = 'edge',
    generations = true,
  }: {
    readonly pathname?: string;
    readonly method?: string;
    readonly mode?: EdgePointer['mode'];
    readonly generations?: boolean;
  } = {}) => {
    const request = navigation(pathname, { method });
    return serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
        host,
        pointer: { ...site.pointer, mode },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: {
            ...policy,
            runtimeCache: { ...policy.runtimeCache, generations: generations ? 'on' : 'off' },
          },
        }),
      },
    );
  };
  return { ctx, serve, scopeSignals, entered, release, opened, signalCache, document };
}

describe('only generation deliveries look at scope signals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { pathname: '/_next/static/chunks/main.js' },
    { pathname: '/_next/static/chunks/main.js', method: 'HEAD' },
    { pathname: '/', mode: 'passthrough' as const },
    { pathname: '/', generations: false },
    { pathname: '/', method: 'POST' },
    { pathname: '/unknown' },
  ])('leaves the signal cache and authority untouched for %j', async (request) => {
    const subject = await fixture();
    try {
      const response = await subject.serve(request);
      await response.body?.cancel();
      subject.release.resolve(undefined);
      await waitOnExecutionContext(subject.ctx);

      expect(subject.opened).not.toHaveBeenCalledWith(subject.signalCache);
      expect(subject.scopeSignals).not.toHaveBeenCalled();
    } finally {
      subject.release.resolve(undefined);
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it('keeps a generation scope refresh behind the public document response', async () => {
    const subject = await fixture();
    try {
      const response = await subject.serve();

      await expect(response.text()).resolves.toBe(
        subject.document.shellText + subject.document.suffixText,
      );

      await subject.entered.promise;

      expect(subject.opened).toHaveBeenCalledWith(subject.signalCache);
      expect(subject.scopeSignals).toHaveBeenCalledTimes(1);
    } finally {
      subject.release.resolve(undefined);
      await waitOnExecutionContext(subject.ctx);
    }
  });
});
