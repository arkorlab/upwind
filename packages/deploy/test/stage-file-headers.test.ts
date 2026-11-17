import { sha256Hex } from '@stayingupwind/core/artifact';
import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { type DeployTarget, stageDeployment } from '../src/deploy.ts';

/**
 * What staging a deployment hands back says of the headers the rules of `next.config` set on its
 * files (`StagedDeployment.fileHeaders`), as the assembly says it: what a deployer tells its user,
 * since a deployment they were left out of is staged all the same.
 */

/** 2026-11-17T00:00:00.000Z, as the clock a staging reads gives it. */
const AT = 1_794_873_600_000;
const GENERATED_AT = '2026-11-17T00:00:00.000Z';
const ROBOTS = encodeUtf8('User-agent: *\n');

/** A target holding nothing but the build's blobs, and keeping whatever is written to it. */
function targetOf(blobs: ReadonlyMap<string, Uint8Array>): DeployTarget {
  const written = new Map<string, Uint8Array | string>();
  const read = (key: string): Promise<Uint8Array | undefined> => {
    const value = written.get(key);
    return Promise.resolve(typeof value === 'string' ? encodeUtf8(value) : value);
  };
  const put = (key: string, value: Uint8Array | string): Promise<void> => {
    written.set(key, value);
    return Promise.resolve();
  };
  return {
    blobs: { uploaded: true, read: (sha256) => Promise.resolve(blobs.get(sha256)) },
    bucket: { get: read, put },
    edgeState: { get: read, put },
  };
}

/** A build of one `public/` file and one rule over every path, with `i18n` or without. */
async function bundleOf(i18n: boolean): Promise<DeploymentBundle> {
  const sha256 = await sha256Hex(ROBOTS);
  return {
    v: 1,
    deploymentId: 'dpl_stage',
    nextVersion: '16.4.6',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
      ...(i18n && { i18n: { defaultLocale: 'en', locales: ['en', 'fr'] } }),
    },
    routing: {
      beforeMiddleware: [
        {
          source: '/:path*',
          sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`,
          headers: { 'X-Content-Type-Options': 'nosniff' },
        },
      ],
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
    entrypoints: [],
    prerenders: [],
    staticFiles: [
      {
        pathname: '/robots.txt',
        blob: { sha256, byteLength: ROBOTS.byteLength, contentType: 'text/plain' },
        immutable: false,
      },
    ],
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

async function staged(i18n: boolean) {
  const bundle = await bundleOf(i18n);
  const target = targetOf(new Map([[bundle.staticFiles[0]?.blob.sha256 ?? '', ROBOTS]]));
  return stageDeployment(target, {
    bundle,
    json: JSON.stringify(bundle),
    projectId: 'stage',
    runId: 'run_stage',
    originHost: 'stage.example',
    environment: 'production',
    owner: 'owner',
    app: { deploymentId: bundle.deploymentId, scriptName: 'stage-app' },
    recoverySource: "'sha256-recovery'",
    now: () => AT,
  });
}

describe('a staged deployment', () => {
  it('says its files store the headers its rules set on them', async () => {
    const result = await staged(true);

    expect(result.fileHeaders).toStrictEqual({ kind: 'stored', files: 1 });
    expect(result.manifest.staticFiles?.['/robots.txt']?.headers).toStrictEqual({
      'x-content-type-options': 'nosniff',
    });
  });

  it('says nothing applies where the edge judges its rules itself', async () => {
    const result = await staged(false);

    expect(result.fileHeaders).toStrictEqual({ kind: 'not-applicable' });
  });
});
