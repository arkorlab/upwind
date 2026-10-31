import { describe, expect, it } from 'vitest';

import { admitPublication } from '../src/cache/publication-response.ts';
import { publicationTimeFor } from '../src/cache/publication.ts';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
  staticFileKey,
} from '../src/manifest/manifest.ts';
import { projectManifestSchema } from '../src/manifest/schema.ts';

const identity = 'a'.repeat(64);
const required = { version: 1 as const, identities: [identity], routes: ['/'] };
const tag = `upwind:publication:v1:${identity}:60000`;

describe('publication admission', () => {
  it('matches cache directives without treating extension names as no-store', () => {
    const response = admitPublication(
      new Response('valid', {
        headers: { 'cache-control': 'public, x-no-store-hint=1, no-transform' },
      }),
      [tag],
      1,
    );

    expect(response.headers.get('cache-control')).toBe(
      'private, no-cache, must-revalidate, no-transform',
    );
  });

  it.each(['public, max-age=3600, no-transform', 'private, no-store, no-transform'])(
    'preserves transform prohibition while narrowing %s',
    (control) => {
      const response = admitPublication(
        new Response('encoded', { headers: { 'cache-control': control } }),
        [tag],
        1,
      );

      expect(response.headers.get('cache-control')).toContain('no-transform');
      expect(response.headers.get('cache-control')).toContain('private');
    },
  );

  it.each([7, 9] as const)('retains request-key file lookup for schema %s', (schemaVersion) => {
    const manifest = {
      schemaVersion,
      staticFiles: {},
      staticFileRequestKeys: true as const,
      staticFileAssetPrefix: { basePath: '', assetPrefix: '/cdn' },
    };

    expect(staticFileKey(manifest, '/cdn/_next/static/missing.js')).toBeUndefined();
  });

  it('refuses expiry and 304 reuse and removes outer stale caches without changing Next cache profiles', () => {
    const original = new Response('public', {
      headers: { 'cdn-cache-control': 'public,max-age=3600,stale-if-error=9999' },
    });
    const admitted = admitPublication(original, [tag], 59_999);

    expect(admitted.headers.has('cdn-cache-control')).toBe(false);
    expect(admitted.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(admitPublication(new Response(null, { status: 304 }), [tag], 60_000).status).toBe(503);
    expect(admitPublication(new Response('old'), [], 1, required).status).toBe(503);
  });

  it('fails closed for a detected clock rollback and never reopens that clock', () => {
    const clock = {};

    expect(publicationTimeFor(clock, 100)).toBe(100);
    expect(publicationTimeFor(clock, 99)).toBeNaN();
    expect(publicationTimeFor(clock, 101)).toBeNaN();
  });

  it('requires the versioned capability and preserves it through manifest storage', () => {
    const base = {
      projectId: 'project',
      runId: 'run',
      generatedAt: '2026-10-30T00:00:00Z',
      originHost: 'example.test',
      deployment: {
        dplId: 'deployment',
        assetSetHash: 'assets',
        observedAt: '2026-10-30T00:00:00Z',
      },
      routes: [],
      app: { deploymentId: 'deployment', scriptName: 'app' },
    };
    const legacy = buildProjectManifest(base);
    const manifest = buildProjectManifest({ ...base, publication: required });

    expect(legacy.schemaVersion).toBe(6);
    expect(manifest.schemaVersion).toBe(9);
    expect(parseProjectManifest(serializeManifest(manifest)).publication).toStrictEqual(required);
    expect(projectManifestSchema.safeParse({ ...manifest, schemaVersion: 8 }).success).toBe(false);

    const absent = { ...manifest };
    delete absent.publication;

    expect(projectManifestSchema.safeParse(absent).success).toBe(false);
  });
});
