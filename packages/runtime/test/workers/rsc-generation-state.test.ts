import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry, packBodyDigests, policyFromBuild } from '@stayingupwind/core/cache';
import { describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../../src/app-module.ts';
import { createCacheRuntime } from '../../src/cache/runtime.ts';
import { rscFromBuild } from '../../src/documents.ts';
import { serveFromGeneration } from '../../src/generations.ts';
import type { RoutedInput } from '../../src/serve.ts';
import type { Store } from '../../src/store.ts';

const encoder = new TextEncoder();
const HTML_STATE = 'build document postponed state';
const RSC_STATE = 'build RSC postponed state';
const RUNTIME_STATE = 'regenerated postponed state';
const descriptor = { kind: 'app-page' as const, route: '/page', pathname: '/page' };
const resolved = { route: '/page', pathname: '/page', url: '/page' };
const shell: Prerender = {
  id: '/page',
  route: '/page',
  pathname: '/page',
  parentOutputId: '/page',
  groupId: 1,
  body: { sha256: 'html', byteLength: 5, contentType: 'text/html' },
  postponed: { sha256: 'html-state', byteLength: HTML_STATE.length, contentType: 'text/plain' },
};
const twin: Prerender = {
  ...shell,
  id: '/page.rsc',
  pathname: '/page.rsc',
  body: undefined,
  postponed: { sha256: 'rsc-state', byteLength: RSC_STATE.length, contentType: 'text/plain' },
};

/** Build outputs carry independent opaque states, even when a fixture build emits equal ones. */
const store = {
  manifest: {
    entrypoints: [{ pathname: '/page', kind: 'app-page' }],
    routing: { rsc: { prefetchSegmentHeader: 'next-router-segment-prefetch' } },
  },
  shellsByRoute: new Map([['/page', { pages: new Map([['/page', shell]]), patterns: [] }]]),
  prerendersByPathname: new Map([
    ['/page', shell],
    ['/page.rsc', twin],
  ]),
  readBlob: (id: string) => {
    if (id === 'rsc-state') return encoder.encode(RSC_STATE);
    throw new Error(`RSC navigation read an unrelated build artifact: ${id}`);
  },
} as unknown as Store;

/** The record has the document's state; a build record has no RSC twin artifacts. */
async function inputWithGeneration(source: 'build' | 'runtime') {
  const scopeId = 'dpl_4Fixture2Minima1AppXy';
  const held: Promise<unknown>[] = [];
  const fetchImpl = vi.fn(() => {
    throw new Error('a held generation must not fetch an artifact before resuming RSC');
  });
  const cache = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: scopeId,
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.fixture.test',
      ARKOR_CACHE_TOKEN: 'test-token',
    },
    now: Date.now,
    fetchImpl,
  });
  if (cache === undefined) throw new Error('no cache runtime');
  const attempts = vi.spyOn(cache.host, 'startAttempt');
  const commits = vi.spyOn(cache.host, 'commit');
  const { entryId } = await deriveEntry(scopeId, descriptor);
  const html = encoder.encode('SHELL');
  const postponed = encoder.encode(source === 'build' ? HTML_STATE : RUNTIME_STATE);
  cache.recordMemo.set(entryId, {
    header: {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: 'gen_1',
      seq: 1,
      source,
      ...descriptor,
      cacheTimestamp: Date.now(),
      producedAt: Date.now(),
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: [],
      artifacts: [],
      revision: 1,
      ...(await packBodyDigests(html, postponed)),
    },
    html,
    postponed,
  });
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request: new Request('https://fixture.test/page', { headers: { rsc: '1' } }),
    initURL: 'https://fixture.test/page',
    run: (work) => work(),
    waitUntil: (work) => {
      held.push(work);
    },
    cache,
  };
  return { input, held, fetchImpl, attempts, commits };
}

// The actual Node bridge delivers the opaque state to an entrypoint; the test does not
// parse or assume the shape of Next.js's version-dependent serialization.
const handler: NodeHandler = (_request, reply, context) => {
  reply.setHeader('content-type', 'text/x-component');
  reply.end(String(context.requestMeta?.['postponed']));
  return Promise.resolve();
};

describe('an RSC navigation chooses the state of its own representation and generation', () => {
  it.each([
    { source: 'build' as const, state: RSC_STATE },
    { source: 'runtime' as const, state: RUNTIME_STATE },
  ])('resumes the $source generation with its RSC state', async ({ source, state }) => {
    const { input, held, fetchImpl, attempts, commits } = await inputWithGeneration(source);
    const current = await serveFromGeneration(
      input,
      store,
      { ...resolved, representation: 'rsc', onMiss: 'build' },
      handler,
    );
    const response =
      current ?? (await rscFromBuild(input, store, { kind: 'node', handler }, resolved));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/x-component');
    await expect(response.text()).resolves.toBe(state);

    // Normal Node handler completion is held independently of cache regeneration. Drain that
    // work, then prove this fresh record caused no lease, publish or gateway operation.
    await Promise.all(held);

    expect(attempts).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
