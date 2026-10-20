import { createHash } from 'node:crypto';

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
import { assert, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { recordedOf, recordEntriesOf, regenerationFailure } from '../src/recorded.ts';
import { GenerationEvidence } from '../src/workers/generation-evidence.ts';
import type { RecordedGeneration } from '../src/workers/protocol.ts';

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
