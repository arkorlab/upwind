import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { fixtureBundle, rootPrerender } from '../../core/test/fixtures/bundle.ts';
import { stageDeployment } from '../src/deploy.ts';
import { fitBuildTags } from '../src/manifest.ts';
import { publicationFields, unsupportedPublication } from '../src/publication.ts';

const SOURCE = '/items/[id]';
const GRANT = `upwind:publication:v1:${'a'.repeat(64)}:1800000060000`;
const WITNESS = `upwind:resource-snapshot:v1:${'a'.repeat(64)}:4`;

function protectedManifest(cached: boolean, count = 1) {
  const bundle: DeploymentBundle = {
    ...fixtureBundle(),
    prerenders: [
      {
        ...rootPrerender(),
        id: 'source',
        route: SOURCE,
        initialHeaders: { 'x-next-cache-tags': [GRANT, WITNESS] },
      },
    ],
  };
  const tags = Array.from({ length: 128 }, (_, index) => {
    return {
      kind: 'next-explicit' as const,
      value: `resource:${String(index)}:${'x'.repeat(200)}`,
    };
  });
  const entries = Array.from({ length: count }, (_, index) => {
    return {
      pathname: `/items/${String(index)}`,
      status: 200 as const,
      shell: {
        sha256: 'b'.repeat(64),
        byteLength: 1,
        contentType: 'text/html',
        encoding: 'identity' as const,
      },
      headers: {},
      prerenderId: 'source',
      ...(cached && {
        cache: {
          entryId: `entry${String(index)}`,
          kind: 'app-page' as const,
          delivery: 'complete' as const,
          buildTags: tags,
        },
      }),
    };
  });
  return buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    originHost: 'site.test',
    generatedAt: '2026-11-05T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-11-05T00:00:00.000Z' },
    app: { deploymentId: 'deployment', scriptName: 'app' },
    ...publicationFields(
      {
        version: 3,
        valueObservers: true,
        resourceSnapshots: true,
        identities: ['a'.repeat(64)],
        routes: [SOURCE],
      },
      bundle,
      entries,
    ),
  });
}

describe('publication runtime capability', () => {
  const publication = { version: 1 as const, identities: ['a'.repeat(64)], routes: ['/'] };

  it.each([false, true])(
    'carries publication through high-level staging (supported=%s)',
    async (supported) => {
      const bundle: DeploymentBundle = {
        ...fixtureBundle(),
        prerenders: [],
        staticFiles: [],
        entrypoints: [],
        ...(supported && { publicationGrants: 1 }),
      };
      const target = {
        blobs: { uploaded: true, read: () => Promise.resolve(undefined) },
        bucket: { get: () => Promise.resolve(undefined), put: () => Promise.resolve() },
        edgeState: { get: () => Promise.resolve(undefined), put: () => Promise.resolve() },
      };
      const input = {
        bundle,
        json: JSON.stringify(bundle),
        publication,
        projectId: 'project',
        runId: 'run',
        originHost: 'site.test',
        environment: 'production' as const,
        owner: 'owner',
        app: { deploymentId: bundle.deploymentId, scriptName: 'app' },
        recoverySource: "'sha256-recovery'",
        now: () => 1_800_000_000_000,
      };

      let result: unknown;
      try {
        const staged = await stageDeployment(target, input);
        result = parseProjectManifest(staged.serialized).publication;
      } catch (error) {
        result = String(error);
      }

      expect(result).toStrictEqual(
        supported
          ? publication
          : 'DeployRefusalError: Publication grants require a bundle with an enforcing Function runtime.',
      );
    },
  );

  it('refuses protected deployment through an unaware runtime', () => {
    expect(unsupportedPublication({ publication, bundle: {} })).toContain('enforcing Function');
    expect(
      unsupportedPublication({ publication, bundle: { publicationGrants: 1 } }),
    ).toBeUndefined();
  });

  it('keeps unprotected deployments compatible with older bundles', () => {
    expect(unsupportedPublication({ bundle: {} })).toBeUndefined();
  });

  it('seals source identity and original proof without inventing a cache descriptor', () => {
    const manifest = parseProjectManifest(serializeManifest(protectedManifest(false)));

    expect(manifest.routes['/items/0']?.publication).toStrictEqual({
      route: SOURCE,
      tags: [GRANT, WITNESS],
    });
    expect(manifest.routes['/items/0']).not.toHaveProperty('cache');
  });

  it('retains essential proof when the optional build membership exceeds its budget', () => {
    const { manifest } = fitBuildTags(protectedManifest(true, 50));

    expect(
      Object.values(manifest.routes).some((entry) => entry.cache?.buildTags === undefined),
    ).toBe(true);

    for (const entry of Object.values(manifest.routes)) {
      expect(entry.publication).toStrictEqual({ route: SOURCE, tags: [GRANT, WITNESS] });
    }
  });
});
