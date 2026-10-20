import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import {
  cacheablePrerenders,
  partialFallbackUpgradeOf,
  type Prerender,
} from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  encodeGenerationPack,
  KEY_SCHEMA_VERSION,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  runtimeCacheOf,
} from '@stayingupwind/host/delivery';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { routeVerdict } from '../src/documents.ts';
import { recordedOf, recordEntriesOf, regenerationFailure } from '../src/recorded.ts';
import { GenerationEvidence } from '../src/workers/generation-evidence.ts';
import type { RecordedGeneration, Regeneration } from '../src/workers/protocol.ts';

const SCOPE = 'scope_completion';
const AT = '2026-10-20T00:00:00.000Z';
const HTML = encodeUtf8('<html><body>completed shell</body></html>');
const DIGEST = createHash('sha256').update(HTML).digest('hex');
const RECORDED = { 'content-type': 'text/html', 'x-completed': 'captured runtime generation' };

interface Completion {
  readonly label: string;
  readonly source: string;
  readonly query: readonly string[];
  readonly pathname: string;
  readonly completed: string;
  readonly regenerationMember: boolean;
}

const COMPLETIONS: readonly Completion[] = [
  {
    label: 'a concrete member',
    source: '/posts/[id]',
    query: ['nxtPid'],
    pathname: '/posts/one',
    completed: '/posts/one',
    regenerationMember: true,
  },
  {
    label: 'a concrete member with a trailing slash',
    source: '/posts/[id]',
    query: ['nxtPid'],
    pathname: '/posts/one/',
    completed: '/posts/one',
    regenerationMember: true,
  },
  {
    label: 'a shell shared by unkeyed parameters',
    source: '/[lang]/posts/[id]',
    query: ['nxtPlang'],
    pathname: '/en/posts/one',
    completed: '/en/posts/[id]',
    regenerationMember: false,
  },
  {
    label: 'a shared shell with a trailing slash',
    source: '/[lang]/posts/[id]',
    query: ['nxtPlang'],
    pathname: '/en/posts/two/',
    completed: '/en/posts/[id]',
    regenerationMember: false,
  },
];

/** Capture a controlled encoded record through the Worker observation code. */
function captured(scopeId: string, entryId: string, seq: number, example: Completion) {
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: `gen_${String(seq)}`,
      seq,
      revision: seq,
      source: 'runtime',
      kind: 'app-page',
      route: example.source,
      pathname: example.completed,
      cacheTimestamp: 100,
      producedAt: 100,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: RECORDED,
      tags: [],
      htmlSha256: DIGEST,
      htmlLength: HTML.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    HTML,
    undefined,
  );
  const evidence = new GenerationEvidence(256);
  evidence.begin('completion');
  evidence.observe('completion', kvGenerationKey(scopeId, entryId), new Uint8Array(bytes).buffer);
  const snapshot = evidence.snapshot('completion');
  evidence.forget('completion');
  return new Map(Object.entries(snapshot));
}

async function fixture(example: Completion) {
  const blob = { sha256: DIGEST, byteLength: HTML.byteLength, contentType: 'text/html' };
  const prerender: Prerender = {
    id: 'partial',
    pathname: example.source,
    route: example.source,
    parentOutputId: 'page',
    groupId: 0,
    body: blob,
    postponed: blob,
    renderingMode: 'PARTIALLY_STATIC',
    partialFallback: true,
    allowQuery: [...example.query],
  };
  const bundle: CheckedStack['bundle'] = {
    v: 1,
    deploymentId: SCOPE,
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: AT,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      poweredByHeader: false,
      cacheComponents: true,
      partialPrefetching: true,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [{ id: 'page', kind: 'app-page', pathname: example.source }],
    prerenders: [prerender],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-10-20',
        compatibilityFlags: [],
      },
    },
  };
  const partialFallback = partialFallbackUpgradeOf(bundle, prerender);
  assert(partialFallback !== undefined, 'the ordinary producer declares the completion');
  const route: RouteEntry = {
    pathname: example.source,
    status: 200,
    shell: { ...blob, encoding: 'identity' },
    headers: { 'x-completed': 'build shell' },
    prerenderId: prerender.id,
    partialFallback,
  };
  const entry = await deriveEntry(SCOPE, {
    kind: 'app-page',
    route: example.source,
    pathname: example.completed,
  });
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run_completion',
    generatedAt: AT,
    originHost: 'localhost',
    deployment: { assetSetHash: DIGEST, observedAt: AT },
    app: { deploymentId: SCOPE, scriptName: 'app' },
    routes: [route],
    staticFiles: {},
    cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: SCOPE },
  });
  const stack: CheckedStack = {
    url: new URL('http://localhost/'),
    site: new URL('https://localhost/'),
    backstage: new URL('http://localhost/_backstage/'),
    functions: [],
    bundleDir: '.',
    bundle,
    deploymentId: SCOPE,
    manifest,
    app: manifest.app,
    policy: {
      ...DEFAULT_DELIVERY_POLICY,
      runtimeCache: {
        ...DEFAULT_RUNTIME_CACHE_SETTINGS,
        generations: 'on',
        concreteUpgrade: false,
      },
    },
    cspNonce: undefined,
    dispose: () => Promise.resolve(),
    generationEvidence: captured(SCOPE, entry.entryId, 1, example),
  };
  return { stack, route, entryId: entry.entryId, example };
}

describe('captured completions of an unseeded partial fallback', () => {
  it.each(COMPLETIONS)('finds $label independently of concreteUpgrade', async (example) => {
    const { stack, route, entryId } = await fixture(example);
    const result = await recordedOf(stack, {
      route,
      pathname: example.pathname,
      generation: { seq: 1, member: true, whole: true },
    });
    const entries = await recordEntriesOf(stack, route, example.pathname);

    expect(cacheablePrerenders(stack.bundle)).toStrictEqual([]);
    expect(route.cache).toBeUndefined();
    expect(runtimeCacheOf(stack.policy).concreteUpgrade).toBe(false);
    expect(result).toStrictEqual({ headers: RECORDED });
    expect(entries).toStrictEqual([entryId]);
  });

  it.each([
    { label: 'another scope', scope: 'scope_other', entry: undefined, seq: 1 },
    { label: 'another entry', scope: SCOPE, entry: 'ent_other', seq: 1 },
    { label: 'another sequence', scope: SCOPE, entry: undefined, seq: 2 },
  ])('does not substitute captured evidence from $label', async ({ scope, entry, seq }) => {
    const example = COMPLETIONS[2]!;
    const { stack, route, entryId } = await fixture(example);
    const observed = captured(scope, entry ?? entryId, seq, example);
    const result = await recordedOf(
      { ...stack, generationEvidence: observed },
      { route, pathname: example.pathname, generation: { seq: 1, member: true, whole: true } },
    );

    expect(result).toStrictEqual({
      failure: "served from generation 1 of its record, which the stack's edge never read",
    });
  });

  it('requires its own captured generation even though the completion identity is derivable', async () => {
    const example = COMPLETIONS[0]!;
    const { stack, route } = await fixture(example);
    const result = await recordedOf(
      { ...stack, generationEvidence: new Map<string, RecordedGeneration>() },
      { route, pathname: example.pathname, generation: { seq: 1, member: true, whole: true } },
    );

    expect(result).toStrictEqual({
      failure: "served from generation 1 of its record, which the stack's edge never read",
    });
  });

  it('does not use a captured completion filed under another source route', async () => {
    const example = COMPLETIONS[2]!;
    const { stack, route } = await fixture(example);
    const foreign = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: '/different/[lang]/posts/[id]',
      pathname: example.completed,
    });
    const result = await recordedOf(
      { ...stack, generationEvidence: captured(SCOPE, foreign.entryId, 1, example) },
      { route, pathname: example.pathname, generation: { seq: 1, member: true, whole: true } },
    );

    expect(result).toStrictEqual({
      failure: "served from generation 1 of its record, which the stack's edge never read",
    });
  });

  it('does not invent a seeded class record from an observed completion', async () => {
    const example = COMPLETIONS[0]!;
    const { stack, route } = await fixture(example);
    const result = await recordedOf(stack, {
      route,
      pathname: example.pathname,
      generation: { seq: 1, member: false, whole: true },
    });

    expect(result).toStrictEqual({
      failure: 'said to be served from generation 1 of a record, where the route has none',
    });
  });

  it('does not turn the unchanged fallback template into a completion record', async () => {
    const example = COMPLETIONS[0]!;
    const { stack, route } = await fixture(example);
    const entries = await recordEntriesOf(stack, route, route.pathname);

    expect(entries).toStrictEqual([]);
  });

  it('keeps a plain cacheless route outside completion lookup', async () => {
    const example = COMPLETIONS[0]!;
    const { stack, route } = await fixture(example);
    const ordinary: RouteEntry = {
      pathname: route.pathname,
      status: route.status,
      shell: route.shell,
      headers: route.headers,
    };
    const entries = await recordEntriesOf(stack, ordinary, example.pathname);
    const result = await recordedOf(stack, {
      route: ordinary,
      pathname: example.pathname,
      generation: { seq: 1, member: true, whole: true },
    });

    expect(entries).toStrictEqual([]);
    expect(result).toStrictEqual({
      failure: 'said to be served from generation 1 of a record, where the route has none',
    });
  });
});

describe('regeneration identities of partial fallback completions', () => {
  it.each(COMPLETIONS)(
    'recognizes $label with the render mode kept by the trace',
    async (example) => {
      const { stack, route, entryId } = await fixture(example);
      const failure = await regenerationFailure(stack, route, {
        pathname: example.pathname,
        regenerated: {
          entry: entryId,
          route: example.source,
          member: example.regenerationMember,
        },
      });

      expect(failure).toBeUndefined();
    },
  );

  it.each([COMPLETIONS[2]!, COMPLETIONS[3]!])(
    'also recognizes $label when asked to render the member',
    async (example) => {
      const { stack, route, entryId } = await fixture(example);
      const failure = await regenerationFailure(stack, route, {
        pathname: example.pathname,
        regenerated: { entry: entryId, route: example.source, member: true },
      });

      expect(failure).toBeUndefined();
    },
  );

  it.each([COMPLETIONS[1]!, COMPLETIONS[3]!])(
    'rejects a foreign entry for $label',
    async (example) => {
      const { stack, route } = await fixture(example);
      const failure = await regenerationFailure(stack, route, {
        pathname: example.pathname,
        regenerated: {
          entry: 'ent_other',
          route: example.source,
          member: example.regenerationMember,
        },
      });

      expect(failure).toContain('regenerated as the entry ent_other, not');
    },
  );

  it.each([COMPLETIONS[1]!, COMPLETIONS[3]!])(
    'rejects a foreign source route for $label',
    async (example) => {
      const { stack, route, entryId } = await fixture(example);
      const failure = await regenerationFailure(stack, route, {
        pathname: example.pathname,
        regenerated: {
          entry: entryId,
          route: '/wrong/[id]',
          member: example.regenerationMember,
        },
      });

      expect(failure).toContain('regenerated as the route /wrong/[id]');
    },
  );

  it('does not infer an unkeyed completion from a trace that renders the class', async () => {
    const example = COMPLETIONS[1]!;
    const { stack, route, entryId } = await fixture(example);
    const failure = await regenerationFailure(stack, route, {
      pathname: example.pathname,
      regenerated: { entry: entryId, route: example.source, member: false },
    });

    expect(failure).toContain('not its own (none)');
  });

  it('requires an actual regeneration trace for a keyed completion', async () => {
    const example = COMPLETIONS[3]!;
    const { stack, route } = await fixture(example);
    const failure = await regenerationFailure(stack, route, {
      pathname: example.pathname,
      regenerated: undefined,
    });

    expect(failure).toBe(
      'said to be regenerated, where the edge had its Function regenerate nothing',
    );
  });
});

const FOREGROUND_HTML = '<!doctype html><html><body>foreground render</body></html>';
const transport = {
  origin: new URL('http://127.0.0.1'),
  regenerated: undefined as Regeneration | undefined,
  rewrite: undefined as string | undefined,
  body: FOREGROUND_HTML,
  type: 'text/html',
};
const foregroundServer = createServer((request, response) => {
  if (request.url?.startsWith('/_backstage/') === true) {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          decision:
            transport.rewrite === undefined
              ? null
              : { status: 200, headers: [['x-middleware-rewrite', transport.rewrite]] },
          regenerated: transport.regenerated ?? null,
          generations: {},
        }),
      );
      return;
    }
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, {
    'content-type': transport.type,
    'cache-control': 'private, no-store',
    'x-arkor-edge': `passthrough;reason=regenerate;m=0000;policy=${DEFAULT_DELIVERY_POLICY.id};scope=${SCOPE}${transport.rewrite === undefined ? '' : ';mw=hit'}`,
  });
  response.end(transport.body);
});

/** A controlled edge response and trace over HTTP, through the real Local document verdict. */
async function foreground(example: Completion, rewritten = false) {
  const { stack, route, entryId } = await fixture(example);
  const original: RouteEntry = {
    pathname: '/before',
    status: route.status,
    shell: route.shell,
    headers: route.headers,
  };
  const asked = rewritten ? original : route;
  const app = { ...stack.app, middlewareScriptName: 'middleware' };
  const own: CheckedStack = {
    ...stack,
    app,
    url: transport.origin,
    backstage: new URL('/_backstage/', transport.origin),
    bundle: {
      ...stack.bundle,
      config: { ...stack.bundle.config, trailingSlash: true, skipTrailingSlashRedirect: true },
      middleware: { matchers: [{ sourceRegex: '^/before$' }] },
    },
    manifest: {
      ...stack.manifest,
      app,
      middleware: { matchers: [{ sourceRegex: '^/before$' }] },
      trailingSlash: true,
      routes: { ...stack.manifest.routes, '/before': original },
      dynamicRoutes: [
        {
          sourceRegex: example.source.startsWith('/posts/')
            ? '^/posts/([^/]+?)(?:/)?$'
            : '^/([^/]+?)/posts/([^/]+?)(?:/)?$',
          route: route.pathname,
        },
      ],
    },
  };
  transport.regenerated = {
    entry: entryId,
    route: example.source,
    member: example.regenerationMember,
  };
  transport.rewrite = rewritten ? new URL(example.pathname, own.site).href : undefined;
  transport.body = FOREGROUND_HTML;
  transport.type = 'text/html';
  return {
    route,
    entryId,
    ask: (selected: RouteEntry = asked) => {
      return routeVerdict(own, 4096, {
        key: selected.pathname,
        route: selected,
        requested: rewritten ? '/before' : example.pathname,
        headers: { 'accept-encoding': 'identity' },
        coding: undefined,
      });
    },
  };
}

describe('foreground completions through Local HTTP and trace reading', () => {
  beforeAll(async () => {
    foregroundServer.listen(0, '127.0.0.1');
    await once(foregroundServer, 'listening');
    const address = foregroundServer.address();
    assert(address !== null && typeof address !== 'string', 'the controlled edge has a socket');
    transport.origin = new URL(`http://127.0.0.1:${String(address.port)}`);
  });

  afterAll(async () => {
    foregroundServer.closeAllConnections();
    foregroundServer.close();
    await once(foregroundServer, 'close');
  });

  it.each(COMPLETIONS)('accepts the foreground render of $label', async (example) => {
    const { ask } = await foreground(example);

    await expect(ask()).resolves.toStrictEqual({ kind: 'ok' });
  });

  it.each([COMPLETIONS[1]!, COMPLETIONS[3]!])(
    'judges a middleware rewrite onto $label',
    async (example) => {
      const { ask, route } = await foreground(example, true);

      await expect(ask()).resolves.toStrictEqual({
        kind: 'skipped',
        reason: `the application's middleware rewrote it to ${example.pathname}, the route ${route.pathname}, regenerated`,
      });
    },
  );

  it('rejects a rewritten completion with a foreign entry', async () => {
    const example = COMPLETIONS[3]!;
    const { ask } = await foreground(example, true);
    transport.regenerated = { entry: 'ent_other', route: example.source, member: false };
    const verdict = await ask();
    assert(verdict.kind === 'failed', 'the foreign entry fails the foreground verdict');

    expect(verdict.reason).toContain('ent_other');
  });

  it('rejects a rewritten completion with a foreign source route', async () => {
    const { ask, entryId } = await foreground(COMPLETIONS[3]!, true);
    transport.regenerated = { entry: entryId, route: '/wrong/[id]', member: false };
    const verdict = await ask();
    assert(verdict.kind === 'failed', 'the foreign route fails the foreground verdict');

    expect(verdict.reason).toContain('regenerated as the route /wrong/[id]');
  });

  it('requires the actual regeneration trace', async () => {
    const { ask } = await foreground(COMPLETIONS[0]!);
    transport.regenerated = undefined;

    await expect(ask()).resolves.toStrictEqual({
      kind: 'failed',
      reason: 'said to be regenerated, where the edge had its Function regenerate nothing',
    });
  });

  it('still rejects an ordinary cacheless route with no completion', async () => {
    const { ask, route } = await foreground(COMPLETIONS[0]!);
    const ordinary: RouteEntry = {
      pathname: route.pathname,
      status: route.status,
      shell: route.shell,
      headers: route.headers,
    };

    await expect(ask(ordinary)).resolves.toStrictEqual({
      kind: 'failed',
      reason: 'regenerated in the foreground, though the route has no record to regenerate',
    });
  });

  it('still requires an HTML response for a completed foreground record', async () => {
    const { ask } = await foreground(COMPLETIONS[0]!);
    transport.type = 'text/plain';

    await expect(ask()).resolves.toStrictEqual({
      kind: 'failed',
      reason: 'answered as text/plain, not an HTML document',
    });
  });

  it('still requires a complete HTML document from the foreground render', async () => {
    const { ask } = await foreground(COMPLETIONS[0]!);
    transport.body = '<html><body>incomplete';

    await expect(ask()).resolves.toStrictEqual({
      kind: 'failed',
      reason: 'the document does not end with </body></html>',
    });
  });
});
