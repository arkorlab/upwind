import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  deriveEntry,
  encodeGenerationPack,
  kvGenerationKey,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type ShellRead,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { kvShellStrategy } from '../src/strategies/shell-kv.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const SCOPE = 'scope_document_preload';
const FILE = '/manual.txt';
const NOW = 1_800_000_000_000;
type Answer =
  | 'response'
  | 'redirect'
  | 'external'
  | 'failed'
  | 'file'
  | 'file-status'
  | 'document'
  | 'budget'
  | 'bypass'
  | 'continue';
type Generation = 'none' | 'absent' | 'fresh' | 'stale' | 'partial';
type Csp = 'no-middleware' | 'middleware';

async function generation(
  document: ReturnType<typeof pprDocument>,
  mode: 'fresh' | 'stale' | 'partial',
) {
  const partial = mode === 'partial';
  const postponed = partial ? encodeUtf8('postponed') : undefined;
  const { entryId } = await deriveEntry(SCOPE, { kind: 'app-page', route: '/', pathname: '/' });
  const html = partial ? document.shell : encodeUtf8(document.shellText + document.suffixText);
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      entryId,
      generationId: 'gen_document_preload',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: mode === 'stale' ? NOW - 2000 : NOW,
      producedAt: NOW,
      policy: policyFromBuild({
        initialRevalidate: mode === 'stale' ? 1 : 60,
        initialExpiration: 600,
      }),
      status: 200,
      headers: {
        'content-type': 'text/html',
        ...(partial && { 'content-security-policy': 'sandbox' }),
      },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: postponed === undefined ? null : await sha256Hex(postponed),
      postponedLength: postponed?.byteLength ?? 0,
      artifacts: [],
    },
    html,
    postponed,
  );
  await env.CACHE_STATE.put(kvGenerationKey(SCOPE, entryId), bytes);
}

function middlewareAnswer(answer: Answer, sandboxed: boolean): Response {
  switch (answer) {
    case 'response': {
      return new Response('middleware answer', { status: 401 });
    }
    case 'redirect': {
      return new Response(null, {
        status: 307,
        headers: { location: 'https://site.example/login' },
      });
    }
    case 'external': {
      return new Response(null, {
        headers: { 'x-middleware-rewrite': 'https://elsewhere.example/page' },
      });
    }
    case 'file':
    case 'file-status': {
      return new Response(null, {
        status: answer === 'file-status' ? 404 : 200,
        headers: { 'x-middleware-rewrite': `https://site.example${FILE}` },
      });
    }
    case 'document':
    case 'budget': {
      return new Response(null, {
        headers: { 'x-middleware-rewrite': 'https://site.example/target' },
      });
    }
    case 'bypass': {
      return new Response(null, {
        headers: {
          'x-middleware-next': '1',
          'x-middleware-override-headers': 'x-skip',
          'x-middleware-request-x-skip': '1',
        },
      });
    }
    case 'failed': {
      throw new Error('middleware failed');
    }
    case 'continue': {
      return new Response(null, {
        headers: {
          'x-middleware-next': '1',
          ...(sandboxed && { 'content-security-policy': 'sandbox' }),
        },
      });
    }
  }
}

async function fixture(answer: Answer, mode: Generation, warm = false, csp?: Csp) {
  const document = pprDocument();
  const site = await seedSite({ document, files: { [FILE]: 'the manual' } });
  const entry = site.manifest.routes['/'];
  if (entry === undefined) throw new Error('the fixture must have a root route');
  const targetText = document.shellText.replace('Loading', 'Target loading');
  const targetDocument = { ...document, shellText: targetText, shell: encodeUtf8(targetText) };
  const target = await seedSite({ document: targetDocument, pathname: '/target' });
  const targetEntry = target.manifest.routes['/target'];
  if (targetEntry === undefined) throw new Error('the fixture must have a target route');
  const budgetTrips = vi.fn((): never => {
    throw new PatternBudgetExceededError({ source: 'target bypass fixture', valueLength: 1 });
  });
  const rewritten = {
    ...targetEntry,
    get bypassFor() {
      return budgetTrips();
    },
  };
  const derived = await deriveEntry(SCOPE, { kind: 'app-page', route: '/', pathname: '/' });
  if (mode !== 'none' && mode !== 'absent') await generation(document, mode);
  const manifest = {
    ...site.manifest,
    routes: {
      ...site.manifest.routes,
      ...(answer === 'document' && target.manifest.routes),
      ...(answer === 'budget' && { '/target': rewritten }),
      '/': {
        ...entry,
        ...(csp !== undefined && {
          headers: {
            ...entry.headers,
            'content-security-policy': csp === 'no-middleware' ? 'sandbox' : "script-src 'self'",
          },
        }),
        ...(mode !== 'none' && {
          cache: {
            entryId: derived.entryId,
            kind: 'app-page' as const,
            delivery: 'resume' as const,
          },
        }),
        ...(answer === 'bypass' && {
          bypassFor: [{ type: 'header' as const, key: 'x-skip', value: '1' }],
        }),
      },
    },
    ...(mode !== 'none' && { cache: { scopeId: SCOPE, keySchemaVersion: 1 as const } }),
    middleware: { matchers: csp === 'no-middleware' ? [] : [{ sourceRegex: '^/$' }] },
  };
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    shell: { backend: 'kv' as const, memoryLru: true, cacheApiLayer: false },
    runtimeCache: {
      ...DEFAULT_RUNTIME_CACHE_SETTINGS,
      generations: 'on' as const,
      concreteUpgrade: false,
      cacheApiMaxAgeMs: 0,
      holdMs: 5000,
    },
  };
  const entered = Promise.withResolvers<true>();
  const shell = Promise.withResolvers<ShellRead | undefined>();
  const original = kvShellStrategy.getShell.bind(kvShellStrategy);
  const reads = vi.spyOn(kvShellStrategy, 'getShell').mockImplementation((ref, edge) => {
    if (ref.sha256 === entry.shell.sha256) {
      entered.resolve(true);
      return shell.promise;
    }
    return original(ref, edge);
  });
  const memory = createEdgeMemory(() => NOW);
  if (warm) memory.shells.set(entry.shell.sha256, document.shell, document.shell.byteLength);
  const points: EdgeMetric[] = [];
  const baseHost = standaloneHost(env);
  const host = {
    ...baseHost,
    observer: {
      ...baseHost.observer,
      metric(point: EdgeMetric) {
        points.push(point);
      },
    },
  };
  const dispatched: string[] = [];
  const runtime = standaloneRuntime(env, {
    now: () => NOW,
    memory,
    dispatchApp: (script) => {
      dispatched.push(script);
      if (script === 'site-middleware') {
        if (answer === 'failed') return Promise.reject(new Error('middleware failed'));
        return Promise.resolve(middlewareAnswer(answer, csp === 'middleware'));
      }
      const response =
        csp !== undefined || mode === 'partial'
          ? new Response('whole sandbox document', {
              headers: { 'content-type': 'text/html', 'content-security-policy': 'sandbox' },
            })
          : htmlResponse(document.suffix);
      return Promise.resolve(response);
    },
    fetchImpl: () => Promise.resolve(new Response('external answer')),
  });
  const ctx = createExecutionContext();
  const request = navigation('/');
  const loading = serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      runtime,
      ctx,
      host,
      pointer: {
        ...site.pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
      },
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy }),
    },
  );
  function finish() {
    shell.resolve({ bytes: document.shell, source: 'kv', latencyMs: 0 });
  }
  return { loading, entered, finish, ctx, points, dispatched, reads, budgetTrips };
}

describe('discarded document shells in the single final delivery point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { answer: 'response', status: 401, requests: 2 },
    { answer: 'redirect', status: 307, requests: 2 },
    { answer: 'external', status: 200, requests: 3 },
    { answer: 'failed', status: 200, requests: 3 },
    { answer: 'file', status: 200, requests: 3 },
    { answer: 'file-status', status: 404, requests: 3 },
    { answer: 'document', status: 200, requests: 4 },
    { answer: 'bypass', status: 200, requests: 3 },
  ] satisfies readonly {
    readonly answer: Answer;
    readonly status: number;
    readonly requests: number;
  }[])(
    'returns $answer before the discarded shell settles and then records it once',
    async (example) => {
      const subject = await fixture(example.answer, 'none');
      try {
        await subject.entered.promise;
        const response = await subject.loading;
        await response.text();

        expect(response.status).toBe(example.status);
        expect(subject.points).toStrictEqual([]);

        subject.finish();
        await waitOnExecutionContext(subject.ctx);

        expect(subject.points).toHaveLength(1);
        expect(subject.points[0]?.subrequests).toBe(example.requests);
        expect(subject.reads).toHaveBeenCalledTimes(example.answer === 'document' ? 2 : 1);
      } finally {
        subject.finish();
        await subject.loading;
        await waitOnExecutionContext(subject.ctx);
      }
    },
  );

  it('counts the same discarded preload once when target routing and its catch both abandon it', async () => {
    // The target's bounded-rule failure is injected after route mismatch abandons the source.
    // The real serveFromPointer catch then abandons that same pending read a second time.
    const subject = await fixture('budget', 'none');
    try {
      await subject.entered.promise;
      const response = await subject.loading;
      await response.text();

      expect(response.status).toBe(200);
      expect(subject.budgetTrips).toHaveBeenCalledTimes(1);
      expect(subject.points).toStrictEqual([]);

      subject.finish();
      await waitOnExecutionContext(subject.ctx);

      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(3);
      expect(subject.reads).toHaveBeenCalledTimes(1);
    } finally {
      subject.finish();
      await subject.loading;
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it('does not charge a discarded shell already held in memory', async () => {
    const subject = await fixture('response', 'none', true);
    try {
      const response = await subject.loading;
      await response.text();
      await waitOnExecutionContext(subject.ctx);

      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(1);
      expect(subject.reads).not.toHaveBeenCalled();
    } finally {
      subject.finish();
      await subject.loading;
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it('keeps a shell used by the response counted once', async () => {
    const subject = await fixture('continue', 'none');
    try {
      await subject.entered.promise;
      subject.finish();
      const response = await subject.loading;
      await response.text();
      await waitOnExecutionContext(subject.ctx);

      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(3);
      expect(subject.reads).toHaveBeenCalledTimes(1);
    } finally {
      subject.finish();
      await subject.loading;
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it('counts the build shell beside an abandoned metadata record without charging the record KV read', async () => {
    const subject = await fixture('response', 'absent');
    try {
      await subject.entered.promise;
      const response = await subject.loading;
      await response.text();

      expect(subject.points).toStrictEqual([]);

      subject.finish();
      await waitOnExecutionContext(subject.ctx);

      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(2);
      expect(subject.reads).toHaveBeenCalledTimes(1);
    } finally {
      subject.finish();
      await subject.loading;
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it.each([
    { mode: 'fresh', requests: 2, app: 0 },
    { mode: 'stale', requests: 3, app: 1 },
  ] satisfies readonly {
    readonly mode: Generation;
    readonly requests: number;
    readonly app: number;
  }[])(
    'lets a $mode generation answer before its unused build shell and composes detached counts',
    async (example) => {
      const subject = await fixture('continue', example.mode);
      try {
        await subject.entered.promise;
        const response = await subject.loading;
        await response.text();

        expect(subject.points).toStrictEqual([]);

        subject.finish();
        await waitOnExecutionContext(subject.ctx);

        expect(subject.points).toHaveLength(1);
        expect(subject.points[0]?.subrequests).toBe(example.requests);
        expect(subject.dispatched.filter((script) => script === 'site-app')).toHaveLength(
          example.app,
        );
      } finally {
        subject.finish();
        await subject.loading;
        await waitOnExecutionContext(subject.ctx);
      }
    },
  );

  it.each([
    { label: 'cold without middleware', csp: 'no-middleware', mode: 'none', requests: 2 },
    { label: 'middleware policy override', csp: 'middleware', mode: 'none', requests: 3 },
    {
      label: 'partial record with parallel build shell',
      csp: undefined,
      mode: 'partial',
      requests: 3,
    },
  ] satisfies readonly {
    readonly label: string;
    readonly csp: Csp | undefined;
    readonly mode: Generation;
    readonly requests: number;
  }[])(
    'counts the CSP shell handoff for $label without charging record metadata',
    async (example) => {
      const subject = await fixture('continue', example.mode, false, example.csp);
      try {
        await subject.entered.promise;
        const response = await subject.loading;
        const body = await response.text();

        expect({
          status: response.status,
          csp: response.headers.get('content-security-policy'),
          edge: response.headers.get('x-arkor-edge')?.includes('reason=csp-sandbox'),
          body,
        }).toStrictEqual({
          status: 200,
          csp: 'sandbox',
          edge: true,
          body: 'whole sandbox document',
        });
        expect(subject.points).toStrictEqual([]);

        subject.finish();
        await waitOnExecutionContext(subject.ctx);

        expect(subject.points).toHaveLength(1);
        expect(subject.points[0]?.subrequests).toBe(example.requests);
        expect(subject.reads).toHaveBeenCalledTimes(1);
      } finally {
        subject.finish();
        await subject.loading;
        await waitOnExecutionContext(subject.ctx);
      }
    },
  );

  it('does not charge a memory shell discarded by CSP without middleware', async () => {
    const subject = await fixture('continue', 'none', true, 'no-middleware');
    try {
      const response = await subject.loading;
      await response.text();
      await waitOnExecutionContext(subject.ctx);

      expect(response.headers.get('x-arkor-edge')).toContain('reason=csp-sandbox');
      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(1);
      expect(subject.reads).not.toHaveBeenCalled();
    } finally {
      subject.finish();
      await subject.loading;
      await waitOnExecutionContext(subject.ctx);
    }
  });
});
