import { deriveEntry, kvGenerationKey } from '@stayingupwind/core/cache';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory, rewriteSeenKey } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { kvShellStrategy } from '../src/strategies/shell-kv.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const TARGET = '/guide';
const SCOPE = 'scope_root_hint';
const REDIRECT = 'https://site.example/welcome';

async function fixture(record = true) {
  const document = pprDocument();
  const site = await seedSite({
    document,
    pathname: TARGET,
    files: { '/guide.txt': 'text guide' },
  });
  const { entryId } = await deriveEntry(SCOPE, {
    kind: 'app-page',
    route: TARGET,
    pathname: TARGET,
  });
  const entry = site.manifest.routes[TARGET]!;
  const manifest = {
    ...site.manifest,
    rootRewriteHint: TARGET,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    cache: { scopeId: SCOPE, keySchemaVersion: 1 as const },
    routes: {
      [TARGET]: {
        ...entry,
        ...(record && {
          cache: { entryId, kind: 'app-page' as const, delivery: 'resume' as const },
        }),
      },
    },
  };
  const middleware = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValue(Response.redirect(REDIRECT, 307));
  const memory = createEdgeMemory(Date.now);
  const runtime = standaloneRuntime(env, {
    memory,
    dispatchApp: (script) =>
      script === 'middleware' ? middleware() : Promise.resolve(htmlResponse(document.suffix)),
  });
  const host = standaloneHost(env);
  const ctx = createExecutionContext();
  function serve(path = '/', init: RequestInit = {}) {
    const request = navigation(path, init);
    return serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        runtime,
        ctx,
        host,
        pointer: {
          ...site.pointer,
          app: { ...site.pointer.app!, middlewareScriptName: 'middleware' },
        },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );
  }
  const kv: { get(key: string, options: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null> } =
    env.CACHE_STATE;
  const reads = vi.spyOn(kv, 'get').mockResolvedValue(null);
  const shell = vi.spyOn(kvShellStrategy, 'getShell');
  const key = kvGenerationKey(SCOPE, entryId);
  const memo = rewriteSeenKey(site.manifestId, '/');
  return { serve, ctx, document, reads, key, shell, middleware, memory, memo };
}

describe('a declared root rewrite can start a record read beside middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the record lookup when middleware confirms the target', async () => {
    const test = await fixture();
    const decision = Promise.withResolvers<Response>();

    test.middleware.mockReturnValue(decision.promise);

    const request = test.serve();
    try {
      await vi.waitFor(() => {
        expect(test.reads).toHaveBeenCalledWith(test.key, expect.anything());
      });

      expect(test.shell).not.toHaveBeenCalled();
    } finally {
      decision.resolve(new Response(null, { headers: { 'x-middleware-rewrite': TARGET } }));
    }
    const response = await request;

    await expect(response.text()).resolves.toBe(test.document.shellText + test.document.suffixText);
    expect(test.reads).toHaveBeenCalledTimes(1);
    expect(test.middleware).toHaveBeenCalledTimes(1);
    expect(test.memory.rewritesSeen.get(test.memo)).toMatchObject({
      kind: 'served',
      pathname: TARGET,
    });

    await waitOnExecutionContext(test.ctx);
  });

  it('returns redirects during a pending read and tries the hint only once', async () => {
    const test = await fixture();
    const pending = Promise.withResolvers<ArrayBuffer | null>();

    test.reads.mockReturnValue(pending.promise);

    try {
      const responses = await Promise.all([test.serve(), test.serve()]);

      expect(
        responses.map((response) => [response.status, response.headers.get('location')]),
      ).toStrictEqual([
        [307, REDIRECT],
        [307, REDIRECT],
      ]);
      expect(test.reads).toHaveBeenCalledTimes(1);
      expect(test.shell).not.toHaveBeenCalled();
      expect(test.memory.rewritesSeen.get(test.memo)).toStrictEqual({ kind: 'hint-attempted' });
    } finally {
      pending.resolve(null);
      await waitOnExecutionContext(test.ctx);
    }
  });

  it('serves a different file selected by middleware and remembers the outcome', async () => {
    const test = await fixture();

    test.middleware.mockResolvedValue(
      new Response(null, {
        headers: { 'x-middleware-rewrite': '/guide.txt', 'set-cookie': 'language=manual; Path=/' },
      }),
    );

    const response = await test.serve();

    await expect(response.text()).resolves.toBe('text guide');
    expect(response.headers.get('set-cookie')).toContain('language=manual');
    expect(test.reads).toHaveBeenCalledTimes(1);
    expect(test.shell).not.toHaveBeenCalled();
    expect(test.memory.rewritesSeen.get(test.memo)).toStrictEqual({ kind: 'unserved' });

    await waitOnExecutionContext(test.ctx);
  });

  it.each([
    { path: '/', init: { method: 'HEAD' } },
    { path: '/', init: { headers: { 'sec-purpose': 'prefetch;prerender' } } },
    { path: '/', init: { headers: { purpose: 'prefetch' } } },
    { path: '/', init: { headers: { 'x-moz': 'prefetch' } } },
    { path: '/other', init: {} },
  ] satisfies { path: string; init: RequestInit }[])(
    'leaves the hint for a root navigation after $path $init',
    async ({ path, init }) => {
      const test = await fixture();

      await test.serve(path, init);

      expect(test.reads).not.toHaveBeenCalled();
      expect(test.memory.rewritesSeen.get(test.memo)).toBeUndefined();

      await test.serve();

      expect(test.reads).toHaveBeenCalledTimes(1);

      await waitOnExecutionContext(test.ctx);
    },
  );

  it('starts no shell read for a target without a generation entry', async () => {
    const test = await fixture(false);

    await test.serve();

    expect(test.memory.rewritesSeen.get(test.memo)).toBeUndefined();
    expect(test.reads).not.toHaveBeenCalled();
    expect(test.shell).not.toHaveBeenCalled();

    await waitOnExecutionContext(test.ctx);
  });
});
