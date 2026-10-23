import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { RouteEntry } from '@stayingupwind/core/manifest';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  resolvePolicy,
  type ShellRead,
} from '@stayingupwind/host/delivery';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeHostedDocument, type HostedDocumentInput } from '../src/handlers/hosted-document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { edgeStrategyRegistry } from '../src/strategies/registry.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const SCOPE = 'scope_partial_preload';
const ROUTE = '/[slug]';
const PATHNAME = '/member';
const NOW = 100;

async function record(pathname: string) {
  const { entryId } = await deriveEntry(SCOPE, { kind: 'app-page', route: ROUTE, pathname });
  const html = new TextEncoder().encode(`generation for ${pathname}`);
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: 'gen_partial_preload',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route: ROUTE,
      pathname,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new TypeError('owned record buffer required');
  return { entryId, key: kvGenerationKey(SCOPE, entryId), bytes: bytes.buffer, html };
}

async function fixture(kind: 'shell' | 'generation', concreteUpgrade = false) {
  const document = pprDocument();
  const site = await seedSite({ document, pathname: ROUTE });
  const original = await record(ROUTE);
  const member = await record(PATHNAME);
  const entry: RouteEntry = {
    ...site.manifest.routes[ROUTE]!,
    partialFallback: { route: ROUTE },
    ...(kind === 'generation' && {
      cache: { entryId: original.entryId, kind: 'app-page', delivery: 'resume' } as const,
    }),
  };
  const manifest = {
    ...site.manifest,
    cache: { scopeId: SCOPE, keySchemaVersion: 1 as const },
    routes: { [ROUTE]: entry },
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
  };
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    shell: { backend: 'kv' as const, memoryLru: true, cacheApiLayer: false },
    runtimeCache: {
      ...DEFAULT_RUNTIME_CACHE_SETTINGS,
      generations: 'on' as const,
      concreteUpgrade,
      holdMs: 5000,
      cacheApiMaxAgeMs: 0,
    },
  };
  const background: Promise<unknown>[] = [];
  const ctx = createExecutionContext();
  vi.spyOn(ctx, 'waitUntil').mockImplementation((work) => {
    background.push(work);
  });
  const app = { ...site.pointer.app!, middlewareScriptName: 'site-middleware' };
  const dispatched: string[] = [];
  const runtime = standaloneRuntime(env, {
    now: () => NOW,
    memory: createEdgeMemory(() => NOW),
    dispatchApp: (script) => {
      dispatched.push(script);
      return Promise.resolve(
        script === 'site-middleware'
          ? new Response(null, { headers: { 'x-middleware-next': '1' } })
          : htmlResponse(document.suffix),
      );
    },
  });
  const currentRecord = vi.fn().mockResolvedValue(undefined);
  const edge: EdgeContext = {
    env,
    ctx,
    runtime,
    host: { ...standaloneHost(env), currentRecord },
    forwarding: { previewDomain: 'example.test', previewHost: 'site.example', clientIp: undefined },
    app,
    originalUrl: undefined,
    policy,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: site.manifestId,
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
  };
  const shell: ShellRead = { bytes: document.shell, source: 'kv', latencyMs: 0 };
  const shellGate = Promise.withResolvers<ShellRead>();
  const getShell = vi.fn<() => Promise<ShellRead>>().mockResolvedValue(shell);
  if (kind === 'generation' && !concreteUpgrade)
    getShell.mockImplementationOnce(() => shellGate.promise);
  const resolved = {
    ...resolvePolicy(edgeStrategyRegistry, policy),
    shell: { id: 'kv' as const, getShell },
  };
  const request = navigation(PATHNAME);
  const input: HostedDocumentInput = {
    request,
    url: new URL(request.url),
    edge,
    manifest,
    resolved,
    classification: { kind: 'document', entry },
    classifiedHeaders: request.headers,
    passthrough: () => Promise.reject(new Error('the build shell must answer')),
  };
  const gates = new Map(
    [original, member].map((value) => [value.key, Promise.withResolvers<ArrayBuffer | null>()]),
  );
  const reads: string[] = [];
  const records: {
    get(
      key: string,
      options: { type: 'arrayBuffer'; cacheTtl?: number },
    ): Promise<ArrayBuffer | null>;
  } = env.CACHE_STATE;
  vi.spyOn(records, 'get').mockImplementation((key) => {
    reads.push(key);
    return gates.get(key)?.promise ?? Promise.resolve(null);
  });
  return {
    input,
    document,
    background,
    getShell,
    dispatched,
    reads,
    original,
    member,
    shellSha256: entry.shell.sha256,
    release: () => {
      shellGate.resolve(shell);
      for (const value of [original, member]) gates.get(value.key)?.resolve(value.bytes);
    },
  };
}

describe('a partial fallback keeps useful preloads behind its response', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'owns the generation and its shell or member with concreteUpgrade=%s',
    async (upgrade) => {
      const test = await fixture('generation', upgrade);
      try {
        const response = await routeHostedDocument(test.input);

        await expect(response.text()).resolves.toBe(
          test.document.shellText + test.document.suffixText,
        );

        await vi.waitFor(() => {
          expect(test.reads).toHaveLength(upgrade ? 2 : 1);
        });

        let settled = false;
        const background = (async () => {
          const values = await Promise.all(test.background);
          settled = true;
          return values;
        })();
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });

        expect(settled).toBe(false);
        expect(test.getShell).toHaveBeenCalledTimes(upgrade ? 1 : 2);
        expect(test.dispatched).toStrictEqual(['site-middleware', 'site-app']);

        test.release();

        const values = await background;

        expect(values).toContainEqual(expect.objectContaining({ kind: 'generation' }));

        const expectedPeer = upgrade
          ? { key: { scopeId: SCOPE, entryId: test.member.entryId } }
          : { kind: 'ok' };

        expect(values).toContainEqual(expect.objectContaining(expectedPeer));
        expect({
          generation: test.input.edge.runtime.memory.generations.get(test.original.key)?.pack.html,
          peer: upgrade
            ? test.input.edge.runtime.memory.generations.get(test.member.key)?.pack.html
            : test.input.edge.runtime.memory.shells.get(test.shellSha256),
        }).toStrictEqual({
          generation: test.original.html,
          peer: upgrade ? test.member.html : test.document.shell,
        });
      } finally {
        test.release();

        await Promise.all(test.background);
      }
    },
  );

  it('continues to consume a shell preload once instead of assigning it a second owner', async () => {
    const test = await fixture('shell');
    try {
      const response = await routeHostedDocument(test.input);

      await expect(response.text()).resolves.toBe(
        test.document.shellText + test.document.suffixText,
      );
      expect(test.getShell).toHaveBeenCalledTimes(1);
      expect(test.reads).toHaveLength(0);
      await expect(Promise.all(test.background)).resolves.not.toContainEqual(
        expect.objectContaining({ kind: 'ok' }),
      );
    } finally {
      test.release();

      await Promise.all(test.background);
    }
  });
});
