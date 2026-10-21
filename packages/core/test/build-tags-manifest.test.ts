import { describe, expect, it } from 'vitest';

import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '../src/cache/keys.ts';
import {
  generationTagSchema as publicGenerationTagSchema,
  tagKindSchema as publicTagKindSchema,
} from '../src/cache/schema.ts';
import { generationTagSchema, tagKindSchema } from '../src/cache/tag-schema.ts';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import { MANIFEST_SCHEMA_VERSION, routeCacheSchema } from '../src/manifest/schema.ts';

const CACHE = { entryId: 'entry', kind: 'app-page' as const, delivery: 'complete' as const };
const BUILD_TAGS = [
  { kind: 'next-explicit' as const, value: 'posts' },
  { kind: 'next-implicit' as const, value: '_N_T_/posts' },
];

describe('immutable build tag membership in route manifests', () => {
  it('preserves the existing cache schema exports as the same tag validators', () => {
    expect(publicGenerationTagSchema).toBe(generationTagSchema);
    expect(publicTagKindSchema).toBe(tagKindSchema);
  });

  it('keeps older routes without inventing an empty tag list', () => {
    expect(routeCacheSchema.parse(CACHE)).toStrictEqual(CACHE);
    expect(routeCacheSchema.parse(CACHE)).not.toHaveProperty('buildTags');
    expect(routeCacheSchema.parse({ ...CACHE, buildTags: [] }).buildTags).toStrictEqual([]);
  });

  it('round-trips exact build tags through stored manifests without changing their version', () => {
    const cache = { ...CACHE, buildTags: BUILD_TAGS };
    const manifest = buildProjectManifest({
      projectId: 'project',
      runId: 'run',
      generatedAt: '2026-10-21T00:00:00.000Z',
      originHost: 'app.example',
      deployment: {
        dplId: 'deployment',
        assetSetHash: 'assets',
        observedAt: '2026-10-21T00:00:00.000Z',
      },
      app: { deploymentId: 'deployment', scriptName: 'app' },
      routes: [
        {
          pathname: '/posts',
          status: 200,
          headers: {},
          shell: {
            sha256: 'a'.repeat(64),
            byteLength: 10,
            contentType: 'text/html',
            encoding: 'identity',
          },
          cache,
        },
      ],
    });
    const parsed = parseProjectManifest(serializeManifest(manifest));

    expect(parsed.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(parsed.routes['/posts']?.cache).toStrictEqual(cache);
    expect(parsed).toStrictEqual(manifest);
  });

  it('accepts the existing per-generation tag count and length bounds', () => {
    const tag = { kind: 'next-explicit', value: 'a'.repeat(MAX_TAG_LENGTH) };
    const buildTags = Array.from({ length: MAX_TAGS_PER_ENTRY }, () => tag);

    expect(routeCacheSchema.safeParse({ ...CACHE, buildTags }).success).toBe(true);
    expect(
      routeCacheSchema.safeParse({ ...CACHE, buildTags: [...buildTags, BUILD_TAGS[0]] }).success,
    ).toBe(false);
  });

  it.each([
    { kind: 'next-explicit', value: '' },
    { kind: 'next-explicit', value: 'a'.repeat(MAX_TAG_LENGTH + 1) },
    { kind: 'untrusted-kind', value: 'posts' },
  ])('rejects an invalid tag $kind/$value', (tag) => {
    expect(routeCacheSchema.safeParse({ ...CACHE, buildTags: [tag] }).success).toBe(false);
  });
});
