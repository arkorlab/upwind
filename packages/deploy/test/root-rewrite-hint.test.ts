import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';
import { parseProjectManifest } from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { fixtureBundle, rootPrerender } from '../../core/test/fixtures/bundle.ts';
import { assembleManifest } from '../src/manifest.ts';

const ROUTE = '/[language]';
const MEMBER = '/welcome';

/** The build emitted a concrete member as well as a complete static page. */
function build() {
  const bundle = fixtureBundle();
  return {
    ...bundle,
    entrypoints: [...bundle.entrypoints, { id: ROUTE, pathname: ROUTE, kind: 'app-page' as const }],
    prerenders: [
      ...bundle.prerenders,
      { ...rootPrerender(), id: MEMBER, pathname: MEMBER, route: ROUTE, parentOutputId: ROUTE },
    ],
  };
}

async function publish(bundle: DeploymentBundle) {
  const result = await assembleManifest({
    bundle: deploymentBundleSchema.parse(bundle),
    previous: undefined,
    projectId: 'rewrite',
    runId: 'run',
    originHost: 'app.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      dplId: bundle.deploymentId,
      assetSetHash: 'assets',
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'application' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-recovery'",
  });
  if (result.kind !== 'assembled') throw new Error(result.reason);
  return parseProjectManifest(result.serialized);
}

describe('publication of a root rewrite hint', () => {
  it('carries the exact resumable member even when its source route is dynamic', async () => {
    const manifest = await publish({ ...build(), rootRewriteHint: MEMBER });

    expect(manifest.rootRewriteHint).toBe(MEMBER);
    expect(manifest.routes[MEMBER]?.cache?.delivery).toBe('resume');
  });

  it.each([undefined, '/absent', '/static', '/items/unbuilt', '/welcome/'])(
    'omits %s when it does not name an exact resumable document in this publication',
    async (rootRewriteHint) => {
      const manifest = await publish({ ...build(), rootRewriteHint });

      expect(manifest).not.toHaveProperty('rootRewriteHint');
    },
  );
});
