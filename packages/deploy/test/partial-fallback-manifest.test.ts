import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { fixtureBundle, rootPrerender } from '../../core/test/fixtures/bundle.ts';
import { type ManifestContext, routeEntryOf } from '../src/routes.ts';

const ROUTE = '/[slug]';
const shell: Prerender = {
  ...rootPrerender(),
  id: ROUTE,
  route: ROUTE,
  pathname: ROUTE,
  routeType: 'fallback',
  partialFallback: true,
  allowQuery: ['nxtPslug'],
};

function deployment(): DeploymentBundle {
  const built = fixtureBundle();
  return {
    ...built,
    config: { ...built.config, cacheComponents: true, partialPrefetching: true },
    entrypoints: [{ id: ROUTE, pathname: ROUTE, kind: 'app-page' }],
    prerenders: [shell],
  };
}

function context(bundle = deployment()): ManifestContext {
  return {
    bundle,
    placed: new Map(),
    encodings: new Map(),
    preloads: {},
    caches: new Map(),
    matchers: [],
    policyRules: [],
    recoverySource: "'sha256-recovery'",
    resumable: new Set([shell.id]),
    segments: new Map(),
    payloads: new Map(),
    pagesData: new Map(),
  };
}

function documentEntry(prerender: Prerender, input: ManifestContext): RouteEntry {
  const entry = routeEntryOf(prerender, input);
  if (entry === undefined) throw new Error('the fixture has a document shell');
  return entry;
}

describe('a deployment manifest for a partial fallback shell', () => {
  it('carries the upgrade route without inventing a seeded cache entry', () => {
    const entry = documentEntry(shell, context());

    expect(entry.partialFallback).toStrictEqual({ route: ROUTE });
    expect(entry).not.toHaveProperty('cache');

    const manifest = buildProjectManifest({
      projectId: 'project',
      runId: 'run',
      originHost: 'app.test',
      generatedAt: '2026-10-18T00:00:00.000Z',
      deployment: { assetSetHash: 'assets', observedAt: '2026-10-18T00:00:00.000Z' },
      app: { deploymentId: 'deployment', scriptName: 'application' },
      cache: { keySchemaVersion: 1, scopeId: 'deployment' },
      routes: [entry],
    });

    expect(
      parseProjectManifest(serializeManifest(manifest)).routes[ROUTE]?.partialFallback,
    ).toStrictEqual({
      route: ROUTE,
    });
  });

  it('projects the completion parameters shared by the runtime and the edge', () => {
    const route = '/[category]/[slug]';
    const prerender = { ...shell, route, pathname: route, allowQuery: ['nxtPcategory'] };
    const bundle = {
      ...deployment(),
      entrypoints: [{ id: route, pathname: route, kind: 'app-page' as const }],
    };

    expect(routeEntryOf(prerender, context(bundle))?.partialFallback).toStrictEqual({
      route,
      keyedBy: ['category'],
    });
  });

  it('does not change an ordinary shell or opt one in when prefetching is disabled', () => {
    const ordinary = { ...shell, partialFallback: undefined };
    const unmarked = routeEntryOf(ordinary, context());
    const bundle = deployment();
    const disabled = context({
      ...bundle,
      config: { ...bundle.config, partialPrefetching: false },
    });

    expect(unmarked).not.toHaveProperty('partialFallback');
    expect(routeEntryOf(shell, disabled)).toStrictEqual(unmarked);
  });
});
