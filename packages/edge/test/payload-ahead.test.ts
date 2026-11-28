import { sha256Hex } from '@stayingupwind/core/artifact';
import { encodeGenerationPack, kvGenerationKey, policyFromBuild } from '@stayingupwind/core/cache';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import { RSC_HEADER } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  type DeliveryPolicy,
  type RuntimeCacheSettings,
} from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory, type EdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, type Site, seedSite } from './helpers/site.ts';

/**
 * A router's request for a page's whole payload that the edge could only hand on to the Function
 * once the middleware ran is handed on before it runs (`payload-ahead.ts`), for the Function to run
 * it itself: one dispatch, where running it here made two in series. Told apart by what the edge
 * dispatches, the middleware's ask marked as the edge marks it (`MIDDLEWARE_ONLY_HEADER`).
 */

const SITE = 'https://site.example';
const FLIGHT = 'the Function rendered Flight';
const STORED = 'the Flight a record holds';
const CLASS = '/items/[id]';
const MEMBER = '/items/one';
const AHEAD = 'passthrough;reason=rsc-payload-ahead';
const FRONT_ENTRY = 'entry-front';

interface Example {
  readonly site: Site;
  readonly manifest: ProjectManifest;
  readonly memory: EdgeMemory;
  readonly scopeId: string;
  readonly policy: DeliveryPolicy;
}

/**
 * A site under a middleware that covers every path: its front page a route whose build wrote no
 * payload (`delivery` saying what its prerender was), a class with a shell, and a class without one
 * whose members are served from their own records.
 */
async function siteOf(
  delivery: 'resume' | 'complete',
  settings: Partial<RuntimeCacheSettings> = {},
): Promise<Example> {
  const site = await seedSite({
    document: pprDocument(),
    pathname: CLASS,
    dynamicRoutes: [
      { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: CLASS },
      { sourceRegex: '^/member$', members: { route: '/[slug]', kind: 'app-page' } },
    ],
  });
  const scopeId = `ahead-${crypto.randomUUID()}`;
  const seeded = site.manifest.routes[CLASS];
  if (seeded === undefined) throw new Error('the class must be seeded');
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
    cache: { keySchemaVersion: 1, scopeId },
    routes: {
      '/': {
        ...seeded,
        pathname: '/',
        cache: { entryId: FRONT_ENTRY, kind: 'app-page', delivery },
      },
      [CLASS]: {
        ...seeded,
        cache: { entryId: 'entry-items', kind: 'app-page', delivery: 'resume' },
      },
    },
  };
  const policy: DeliveryPolicy = {
    ...DEFAULT_DELIVERY_POLICY,
    runtimeCache: {
      ...DEFAULT_RUNTIME_CACHE_SETTINGS,
      generations: 'on',
      cacheApiMaxAgeMs: 0,
      ...settings,
    },
  };
  return { site, manifest, memory: createEdgeMemory(() => Date.now()), scopeId, policy };
}

/** The front page's record, rendered since the build: whole, or holding a resume's state. */
async function keepFront(example: Example, partial: boolean): Promise<void> {
  const document = pprDocument();
  const html = encodeUtf8(partial ? document.shellText : document.shellText + document.suffixText);
  const postponed = partial ? encodeUtf8('the state a resume finishes') : undefined;
  const part = encodeUtf8(STORED);
  const storageRef = `payload-ahead/${crypto.randomUUID()}`;
  await env.ARTIFACTS.put(storageRef, part);
  const now = Date.now();
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: example.scopeId,
      entryId: FRONT_ENTRY,
      generationId: 'gen_front',
      seq: 1,
      revision: 1,
      source: 'runtime',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: now,
      producedAt: now,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: postponed === undefined ? null : await sha256Hex(postponed),
      postponedLength: postponed?.byteLength ?? 0,
      artifacts: [
        {
          artifactId: 'artifact_front_flight',
          role: 'rsc',
          representationKey: 'rsc',
          sha256: await sha256Hex(part),
          byteLength: part.byteLength,
          contentType: 'text/x-component',
          encoding: 'identity',
          storageRef,
        },
      ],
    },
    html,
    postponed,
  );
  await env.CACHE_STATE.put(kvGenerationKey(example.scopeId, FRONT_ENTRY), bytes);
}

/** A router's request for the payload at `pathname`, and what the edge dispatched to answer it. */
async function asked(example: Example, pathname: string, prefetch?: string) {
  const request = new Request<unknown, IncomingRequestCfProperties>(`${SITE}${pathname}`, {
    headers: {
      [RSC_HEADER]: '1',
      ...(prefetch !== undefined && { 'next-router-prefetch': prefetch }),
    },
  });
  // Whether each dispatch was the middleware's ask (`true`) or the Function's request (`false`).
  const dispatched: boolean[] = [];
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime: standaloneRuntime(env, {
        memory: example.memory,
        dispatchApp: (_script, handed) => {
          const middleware = handed.headers.get(MIDDLEWARE_ONLY_HEADER) === '1';
          dispatched.push(middleware);
          return Promise.resolve(
            middleware
              ? new Response(null, { headers: { 'x-middleware-next': '1' } })
              : new Response(FLIGHT, { headers: { 'content-type': 'text/x-component' } }),
          );
        },
      }),
      host: standaloneHost(env),
      pointer: {
        ...example.site.pointer,
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
      manifestLookup: Promise.resolve({ kind: 'found', value: example.manifest }),
      policyLookup: Promise.resolve({ kind: 'found', source: 'exact', policy: example.policy }),
    },
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { body, dispatched, account: response.headers.get('x-arkor-edge') ?? '' };
}

describe('a payload only the Function renders, under a middleware', () => {
  it('hands a member of a class with a shell on before the middleware, under a policy that reads no member’s own record', async () => {
    const example = await siteOf('resume');
    const result = await asked(example, MEMBER);

    expect(result.body).toBe(FLIGHT);
    expect(result.account).toBe(AHEAD);
    expect(result.dispatched).toStrictEqual([false]);
  });

  it('runs the middleware for a member the policy reads its own record of', async () => {
    const example = await siteOf('resume', { concreteUpgrade: true });
    const result = await asked(example, MEMBER);

    expect(result.body).toBe(FLIGHT);
    expect(result.dispatched).toStrictEqual([true, false]);
  });

  it('runs the middleware for a member of a class with no shell, served from its own record', async () => {
    const example = await siteOf('resume');
    const result = await asked(example, '/member');

    expect(result.body).toBe(FLIGHT);
    expect(result.dispatched).toStrictEqual([true, false]);
  });

  it.each([undefined, '2', '3'])(
    'hands a page whose held record holds a resume on before the middleware (prefetch: %s)',
    async (prefetch) => {
      // The build finished the page, so only the record this isolate comes to hold says otherwise.
      const example = await siteOf('complete');
      await keepFront(example, true);
      const first = await asked(example, '/', prefetch);
      const held = await asked(example, '/', prefetch);

      // Held nothing at first: the middleware ran, and the record the edge then read handed it on.
      expect(first.dispatched).toStrictEqual([true, false]);
      expect(first.account).toBe('passthrough;reason=rsc-payload');
      expect(held.body).toBe(FLIGHT);
      expect(held.account).toBe(AHEAD);
      expect(held.dispatched).toStrictEqual([false]);
    },
  );

  it('answers a static prefetch from the held record past the middleware', async () => {
    const example = await siteOf('resume');
    await keepFront(example, true);
    await asked(example, '/');
    const prefetched = await asked(example, '/', '1');

    expect(prefetched.body).toBe(STORED);
    expect(prefetched.account).toMatch(/^payload;.*;mw=hit$/u);
    expect(prefetched.dispatched).toStrictEqual([true]);
  });

  it('hands on a page the build left to a resume while it holds nothing, and answers the next from the whole record it read meanwhile', async () => {
    const example = await siteOf('resume');
    await keepFront(example, false);
    const first = await asked(example, '/');
    const next = await asked(example, '/');

    expect(first.body).toBe(FLIGHT);
    expect(first.account).toBe(AHEAD);
    expect(first.dispatched).toStrictEqual([false]);
    // The record read behind the first is whole: a navigation's payload is the edge's to answer.
    expect(next.body).toBe(STORED);
    expect(next.account).toMatch(/^payload;.*;mw=hit$/u);
    expect(next.dispatched).toStrictEqual([true]);
  });

  it('runs the middleware for a page the build finished while it holds nothing', async () => {
    const example = await siteOf('complete');
    await keepFront(example, false);
    const result = await asked(example, '/');

    expect(result.body).toBe(STORED);
    expect(result.dispatched).toStrictEqual([true]);
  });

  it('judges no record under a hold of zero, which reads each before the first byte', async () => {
    const example = await siteOf('resume', { holdMs: 0 });
    await keepFront(example, false);
    const result = await asked(example, '/');

    expect(result.body).toBe(STORED);
    expect(result.dispatched).toStrictEqual([true]);
  });
});
