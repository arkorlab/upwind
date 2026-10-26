import { BuildPatternBudget, type DeploymentBundle } from '@stayingupwind/core/bundle';
import { describe, expect, it, vi } from 'vitest';

import { fixtureBundle, rootPrerender } from '../../core/test/fixtures/bundle.ts';
import { assembleManifest } from '../src/manifest.ts';

function assemble(bundle: DeploymentBundle) {
  return assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'pattern-budget',
    runId: 'run',
    originHost: 'patterns.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      dplId: bundle.deploymentId,
      assetSetHash: 'assets',
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'patterns-app' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-recovery'",
    runtimeCache: false,
    nextVersionJudged: true,
  });
}

function expensiveBundle(kind: 'middleware' | 'policy'): DeploymentBundle {
  const pathname = `/${'a'.repeat(200)}b`;
  const bundle = fixtureBundle();
  bundle.entrypoints = [{ id: pathname, pathname, kind: 'app-page' }];
  bundle.prerenders = [
    { ...rootPrerender(), id: pathname, pathname, route: pathname, parentOutputId: pathname },
  ];
  const rule = { sourceRegex: '^/a*a*a*a*!$' };
  if (kind === 'middleware') bundle.middleware = { matchers: [rule] };
  else
    bundle.routing.beforeMiddleware = [
      {
        ...rule,
        has: [{ type: 'header', key: 'x-policy' }],
        headers: { 'content-security-policy': "script-src 'none'" },
      },
    ];

  return bundle;
}

describe('manifest assembly pattern refusals', () => {
  it.each(['middleware', 'policy'] as const)('refuses an expensive %s expression', async (kind) => {
    const bundle = expensiveBundle(kind);

    await expect(assemble(bundle)).resolves.toStrictEqual({
      kind: 'refused',
      reason: 'the build exceeds the routing pattern execution budget',
    });
  });

  it('passes one context through header, rewrite and routing assembly', async () => {
    const test = vi.spyOn(BuildPatternBudget.prototype, 'test');
    const exec = vi.spyOn(BuildPatternBudget.prototype, 'exec');
    try {
      expect((await assemble(fixtureBundle())).kind).toBe('assembled');

      const contexts = [...test.mock.contexts, ...exec.mock.contexts];

      expect(contexts.length).toBeGreaterThan(1);
      expect(new Set(contexts).size).toBe(1);
    } finally {
      test.mockRestore();

      exec.mockRestore();
    }
  });
});
