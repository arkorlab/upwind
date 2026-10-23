import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { assembleManifest } from '../src/manifest.ts';

/**
 * A manifest says the phase each of its header rules came from: Next.js judges a rule ahead of the
 * middleware on the request as the client sent it, and one that runs on a match on the request as
 * finally matched, so the edge hands a Function only the first as judged.
 */

const GENERATED_AT = '2026-10-23T00:00:00.000Z';
const RECOVERY_SOURCE = "'sha256-recovery'";

function bundleOf(routing: Partial<DeploymentBundle['routing']>): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
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
      ...routing,
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  };
}

describe("a deployment's header rules, as its manifest carries them", () => {
  it('say the phase each came from, a policy widened for documents included', async () => {
    const bundle = bundleOf({
      beforeMiddleware: [
        {
          source: '/:path*',
          sourceRegex: '^(?:/(.*))?$',
          headers: { 'content-security-policy': "script-src 'none'" },
        },
      ],
      onMatch: [
        {
          sourceRegex: '^/_next/static/(?:chunks|css|media|build)/.+',
          headers: { 'cache-control': 'public,max-age=31536000,immutable' },
        },
      ],
    });

    const assembled = await assembleManifest({
      bundle,
      previous: undefined,
      projectId: 'site',
      runId: createId('run'),
      originHost: 'site.example',
      deploymentId: bundle.deploymentId,
      fingerprint: { dplId: bundle.deploymentId, assetSetHash: 'h', observedAt: GENERATED_AT },
      app: { deploymentId: bundle.deploymentId, scriptName: 'site-app' },
      generatedAt: GENERATED_AT,
      encodings: new Map(),
      preloads: {},
      recoverySource: RECOVERY_SOURCE,
      runtimeCache: false,
      nextVersionJudged: true,
    });

    expect(assembled.kind).toBe('assembled');

    const { manifest } = assembled as Extract<typeof assembled, { readonly kind: 'assembled' }>;

    expect(
      manifest.headerRules?.map((rule) => [rule.phase, rule.documentHeaders !== undefined]),
    ).toStrictEqual([
      ['beforeMiddleware', true],
      ['onMatch', false],
    ]);
  });
});
