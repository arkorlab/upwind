import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY, type GenerationTag } from '@stayingupwind/core/cache';
import {
  buildProjectManifest,
  type DynamicRoute,
  MAX_MANIFEST_BYTES,
  parseProjectManifest,
  type RouteEntry,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { fitBuildTags, oversizedManifest } from '../../deploy/src/manifest.ts';
import { EDGE_ISOLATE_BUDGET_BYTES, manifestCharge } from '../src/delivery/manifest-charge.ts';

function taggedManifest(
  routes: number,
  buildTags: GenerationTag[],
  dynamicRoutes: DynamicRoute[] = [],
) {
  return buildProjectManifest({
    projectId: 'build-tag-budget',
    runId: 'run',
    generatedAt: '2026-10-21T00:00:00.000Z',
    originHost: 'app.example',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-21T00:00:00.000Z' },
    app: { deploymentId: 'deployment', scriptName: 'app' },
    routes: Array.from({ length: routes }, (_, index): RouteEntry => {
      return {
        pathname: `/route-${index}`,
        status: 200,
        headers: {},
        shell: {
          sha256: 'a'.repeat(64),
          byteLength: 1,
          contentType: 'text/html',
          encoding: 'identity',
        },
        cache: { entryId: `entry-${index}`, kind: 'app-page', delivery: 'complete', buildTags },
      };
    }),
    dynamicRoutes,
  });
}

function manyMemberRules(conditions: number): DynamicRoute[] {
  return Array.from({ length: 1000 }, () => {
    return {
      sourceRegex: '^/([^/]+)$',
      members: {
        route: '/[id]',
        kind: 'app-page',
        bypassFor: Array.from({ length: conditions }, () => ({ type: 'host' as const })),
      },
    };
  });
}

function shortTags(): GenerationTag[] {
  return Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) => {
    const value = String(index);
    return { kind: 'next-explicit', value };
  });
}

describe('optional build membership within the complete manifest budgets', () => {
  it('omits whole memberships when 30 individually valid large tag sets exceed the wire limit', () => {
    const tags: GenerationTag[] = Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) => {
      const value = String(index).padStart(MAX_TAG_LENGTH, 'a');
      return { kind: 'next-explicit', value };
    });
    const original = taggedManifest(30, tags);
    const originalBytes = encodeUtf8(serializeManifest(original)).byteLength;
    const fitted = fitBuildTags(original);
    const parsed = parseProjectManifest(fitted.serialized);

    expect(originalBytes).toBeGreaterThan(MAX_MANIFEST_BYTES);
    expect(encodeUtf8(fitted.serialized).byteLength).toBeLessThan(MAX_MANIFEST_BYTES);
    expect(oversizedManifest(fitted.manifest, fitted.serialized)).toBeUndefined();
    expect(
      Object.values(parsed.routes).every((route) => route.cache?.buildTags === undefined),
    ).toBe(true);
    expect(original.routes['/route-0']?.cache?.buildTags).toHaveLength(MAX_TAGS_PER_ENTRY);
    expect(parsed.routes['/route-0']?.cache).toStrictEqual({
      entryId: 'entry-0',
      kind: 'app-page',
      delivery: 'complete',
    });
    expect(parsed).toStrictEqual(fitted.manifest);
  });

  it('omits whole memberships when short tags push a valid rule-heavy baseline past the parsed budget', () => {
    const original = taggedManifest(100, shortTags(), manyMemberRules(400));
    const serialized = serializeManifest(original);
    const bytes = encodeUtf8(serialized).byteLength;
    const fitted = fitBuildTags(original);

    expect(bytes).toBeLessThan(MAX_MANIFEST_BYTES);
    expect(manifestCharge(original, bytes)).toBeGreaterThan(EDGE_ISOLATE_BUDGET_BYTES);
    expect(oversizedManifest(fitted.manifest, fitted.serialized)).toBeUndefined();
    expect(fitted.manifest.dynamicRoutes).toBe(original.dynamicRoutes);
    expect(
      Object.values(fitted.manifest.routes).every((route) => route.cache?.buildTags === undefined),
    ).toBe(true);
    expect(original.routes['/route-0']?.cache?.buildTags).toHaveLength(MAX_TAGS_PER_ENTRY);
  });

  it('keeps complete memberships when both budgets admit them', () => {
    const original = taggedManifest(2, shortTags());
    const fitted = fitBuildTags(original);

    expect(fitted.manifest).toBe(original);
    expect(fitted.serialized).toBe(serializeManifest(original));
    expect(fitted.manifest.routes['/route-0']?.cache?.buildTags).toHaveLength(MAX_TAGS_PER_ENTRY);
  });

  it('still refuses an oversized baseline after every optional membership was omitted', () => {
    const original = taggedManifest(1, shortTags(), manyMemberRules(600));
    const fitted = fitBuildTags(original);

    expect(oversizedManifest(fitted.manifest, fitted.serialized)).toBeDefined();
    expect(fitted.manifest.dynamicRoutes).toBe(original.dynamicRoutes);
    expect(fitted.manifest.routes['/route-0']?.cache).not.toHaveProperty('buildTags');
  });
});
