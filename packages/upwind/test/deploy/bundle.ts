import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DeploymentBundle, FunctionSpec } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';

/**
 * A project directory with a build in it: `.arkor/bundle.json` and the blobs its Functions'
 * modules are, as `upwind build` leaves them — small enough to read, whole enough for the
 * bundle's own schema.
 */

type FunctionModule = FunctionSpec['modules'][number];

/** What the runtime cache's Function host carries, which a Function built for a deploy has. */
export const CACHE_HOST_SOURCE = "const naming = { copyCache: 'upwind-cache-host-artifacts-v1' };";

export function projectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-deploy-project-'));
  mkdirSync(path.join(dir, '.arkor/blobs'), { recursive: true });
  return dir;
}

/** A module of the build: its bytes stored under their digest, as the adapter stores them. */
export function moduleOf(
  dir: string,
  name: string,
  type: FunctionModule['type'],
  text: string,
): FunctionModule {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(dir, '.arkor/blobs', sha256), bytes);
  return {
    name,
    type,
    blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript; charset=utf-8' },
  };
}

export function functionOf(modules: FunctionModule[]): FunctionSpec {
  return {
    mainModule: 'index.mjs',
    modules,
    compatibilityDate: '2026-09-15',
    compatibilityFlags: ['nodejs_compat'],
  };
}

/** A Function built for a deploy: a main module that carries the cache host. */
export function deployableFunction(dir: string): FunctionSpec {
  return functionOf([
    moduleOf(dir, 'index.mjs', 'esm', `${CACHE_HOST_SOURCE}\nexport default {};`),
  ]);
}

/** A build of one page, as its bundle reads, with whatever the test changes. */
export function bundleOf(
  app: FunctionSpec,
  extra: Partial<DeploymentBundle> = {},
): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-21T00:00:00.000Z',
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
    entrypoints: [{ id: '/', kind: 'app-page', pathname: '/' }],
    prerenders: [],
    staticFiles: [],
    functions: { app },
    ...extra,
  };
}

export function writeBundle(dir: string, bundle: DeploymentBundle): void {
  writeFileSync(path.join(dir, '.arkor/bundle.json'), JSON.stringify(bundle));
}
