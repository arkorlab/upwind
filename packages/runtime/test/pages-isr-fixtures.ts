import { createHash } from 'node:crypto';

import type { Prerender } from '@stayingupwind/core/bundle';
import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { TtlCache } from '@stayingupwind/core/util';

import type { CacheHost, CommitRequest } from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import type { StaticPagesManifest } from '../src/cache/static-pages.ts';
import { TagState } from '../src/cache/tags.ts';
import type { Store } from '../src/store.ts';

export const SCOPE = 'dpl_static_isr';
export const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
export const DESCRIPTOR: RouteEntryDescriptor = {
  kind: 'pages',
  route: '/something',
  pathname: '/something',
};
const PAGE: Prerender = {
  id: 'html',
  pathname: '/something',
  route: '/something',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  initialRevalidate: 2,
  body: { sha256: 'a'.repeat(64), byteLength: 8, contentType: 'text/html' },
};
export function manifestOf(extra: Partial<StaticPagesManifest> = {}): Store['manifest'] {
  return {
    v: 1,
    deploymentId: SCOPE,
    nextVersion: '16.4.2',
    buildId: 'build',
    staticPagesPrivacy: 2,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
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
    entrypoints: [{ id: 'page', kind: 'pages', pathname: '/something' }],
    prerenders: [PAGE],
    staticFiles: [],
    ...extra,
  };
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by this static Pages render'));
}

function frozen(): number {
  return NOW;
}

export function runtimeOf(commits: CommitRequest[], scopeId = SCOPE): CacheRuntime {
  const host: CacheHost = {
    startAttempt: () => {
      return Promise.resolve({
        kind: 'leased',
        attemptId: 'attempt',
        entryId: 'entry',
        fencingToken: 1,
        leaseExpiresAt: NOW + 60_000,
        current: null,
      });
    },
    uploadArtifact: ({ bytes }) => {
      return Promise.resolve({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
      });
    },
    heartbeat: () => Promise.resolve(),
    commit: (_attempt, request) => {
      commits.push(request);
      return Promise.resolve({ kind: 'published', generationId: 'generation' });
    },
    fail: () => Promise.resolve(),
    readRecord: () => Promise.resolve(undefined),
    readArtifact: () => Promise.resolve(undefined),
    getData: unasked,
    setData: unasked,
    getTags: () => Promise.resolve({ tags: [] }),
    tagsDelta: () => Promise.resolve({ revision: 0, truncated: false, tags: [] }),
    invalidate: unasked,
  };
  return {
    scopeId,
    host,
    tags: new TagState({ holdMs: HOLD_MS }),
    holdMs: HOLD_MS,
    clockOf: frozen,
    dataMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    dataStates: new TtlCache(Infinity, ENTRIES, frozen),
    dataWrites: new Map(),
    entryIds: new TtlCache(Infinity, ENTRIES, frozen),
    recordMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    publishing: new TtlCache(HOLD_MS, ENTRIES, frozen),
    letGo: new WeakSet(),
    givenBack: new TtlCache(HOLD_MS, ENTRIES, frozen),
    artifactMemo: new TtlCache(Infinity, ENTRIES, frozen),
    log: () => {
      // The in-memory host publishes synchronously; diagnostics are irrelevant to these cases.
    },
  };
}
