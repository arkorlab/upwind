import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  invalidatedTagsValue,
  parseScopeRevision,
  SCOPE_REVISION_HEADER,
} from '@stayingupwind/core/paas';
import type { ScopeSignals } from '@stayingupwind/host/cache';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type EdgePointer,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodedScopeId } from '../src/cache/scope-identity.ts';
import type { EdgeHost } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const POLICY = {
  ...DEFAULT_DELIVERY_POLICY,
  assets: { ...DEFAULT_DELIVERY_POLICY.assets, backend: 'passthrough' as const },
  runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' as const },
};

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
            ...POLICY,
            runtimeCache: { ...POLICY.runtimeCache, generations: generations ? 'on' : 'off' },
          },
        }),
      },
    );
  };
  return { ctx, serve, scopeSignals, entered, release, opened, signalCache, document };
}

describe('what looks at scope signals as it is routed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { pathname: '/_next/static/chunks/main.js' },
    { pathname: '/_next/static/chunks/main.js', method: 'HEAD' },
    { pathname: '/_next/data/build/index.json' },
    { pathname: '/', method: 'POST' },
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

  it.each([
    { pathname: '/unknown' },
    { pathname: '/', mode: 'passthrough' as const },
    { pathname: '/', generations: false },
  ])('looks at the scope behind a request it reads no record for, %j', async (request) => {
    const subject = await fixture();
    try {
      const response = await subject.serve(request);
      await response.body?.cancel();
      subject.release.resolve(undefined);
      await waitOnExecutionContext(subject.ctx);

      expect(subject.opened).toHaveBeenCalledWith(subject.signalCache);
      expect(subject.scopeSignals).toHaveBeenCalledTimes(1);
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

  it('looks once for a document whose record is read as well', async () => {
    const subject = await fixture();
    try {
      const response = await subject.serve();
      await response.body?.cancel();
      await subject.entered.promise;

      // The look read the data center's copy, found none, and claimed the question it then asked:
      // a second look would have read the copy too, before that question was out.
      const signalOpens = subject.opened.mock.calls.filter(
        ([name]) => name === subject.signalCache,
      );

      expect(signalOpens).toHaveLength(2);
    } finally {
      subject.release.resolve(undefined);
      await waitOnExecutionContext(subject.ctx);
    }
  });
});

/** The page behind a rewrite the edge leaves to the Function, as the tag `revalidatePath` names. */
const REWRITTEN_PAGE_TAG = '_N_T_/legacy/static';

/**
 * Isolates of one data center in front of one deployment: each a memory of its own, and the Cache
 * API and the authority theirs together. The Function answers `/api/revalidate` as a route handler
 * that calls `revalidatePath` does, with the invalidation at once on its response, and every other
 * request with a page; `/static` is a `next.config` rewrite, which the edge hands to it.
 */
async function dataCenter() {
  const document = pprDocument();
  const site = await seedSite({ document, reservedRoutes: [{ sourceRegex: '^/static$' }] });
  const scopeId = crypto.randomUUID();
  const manifest: ProjectManifest = { ...site.manifest, cache: { keySchemaVersion: 1, scopeId } };
  const base = standaloneHost(env);
  const signalCache = `routing-signals-${scopeId}`;
  const invalidatedAt = Date.now();
  // Where the authority stands once it has recorded what the route handler invalidated.
  const moved: ScopeSignals = {
    revision: 7,
    invalidatedAt,
    tags: [
      {
        tagId: 'tag-rewritten-page',
        kind: 'next-implicit',
        value: REWRITTEN_PAGE_TAG,
        revision: 7,
        staleAt: invalidatedAt,
        hardExpireAt: invalidatedAt,
        meaning: 'immediate',
      },
    ],
    truncated: false,
    announced: true,
  };
  const host: EdgeHost = {
    ...base,
    names: { ...base.names, signalCache },
    scopeSignals: {
      scopeSignals: () => Promise.resolve(moved),
      cacheTagOf: (scope) => `routing-${scope}`,
    },
  };
  const isolate = () => {
    // Where each request this isolate handed to the Function was told the scope stands.
    const told: (string | null)[] = [];
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (_script, request) => {
        told.push(request.headers.get(SCOPE_REVISION_HEADER));
        if (new URL(request.url).pathname !== '/api/revalidate') {
          return Promise.resolve(htmlResponse(document.suffix));
        }
        return Promise.resolve(
          Response.json(
            { revalidated: true },
            {
              headers: {
                [INVALIDATED_TAGS_HEADER]: invalidatedTagsValue([REWRITTEN_PAGE_TAG]),
                [INVALIDATED_REVISION_HEADER]: String(moved.revision),
              },
            },
          ),
        );
      },
    });
    // Every request with a context of its own, as the runtime gives each one.
    const serve = async (request: IncomingRequest): Promise<void> => {
      const ctx = createExecutionContext();
      const response = await serveFromPointer(
        {
          request,
          url: new URL(request.url),
          env,
          ctx,
          runtime,
          host,
          pointer: site.pointer,
          pointerMs: 0,
          privateDelivery: false,
          cspReportingPath: undefined,
        },
        {
          manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
          policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: POLICY }),
        },
      );
      await response.text();
      await waitOnExecutionContext(ctx);
    };
    return { serve, lastTold: () => parseScopeRevision(told.at(-1) ?? null) };
  };
  /** The host's purge of the scope as the invalidation is announced: the copy and its claim go. */
  const purge = async (): Promise<void> => {
    const copies = await caches.open(signalCache);
    const key = `https://${base.names.cacheKeyHost}/scope-signals/${encodedScopeId(scopeId)}`;
    await Promise.all([copies.delete(key), copies.delete(`${key}/claim`)]);
  };
  return { isolate, purge, moved };
}

describe('an invalidation another isolate of the data center relayed', () => {
  it('is told to the Function behind the next request this isolate hands on', async () => {
    const center = await dataCenter();
    const relaying = center.isolate();
    const browsing = center.isolate();

    // Fetched outside the browser, as Next.js's deploy suites revalidate: another connection,
    // which the data center may hand to another isolate than the browser's.
    await relaying.serve(
      navigation('/api/revalidate', {
        headers: { accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' },
      }),
    );
    await center.purge();
    await browsing.serve(navigation('/static'));
    await browsing.serve(navigation('/static'));
    await relaying.serve(navigation('/static'));

    expect(browsing.lastTold()).toStrictEqual({
      revision: center.moved.revision,
      invalidatedAt: center.moved.invalidatedAt,
    });
    expect(relaying.lastTold()?.revision).toBe(center.moved.revision);
  });
});
