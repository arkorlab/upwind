import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BlobRef, DeploymentBundle } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { afterAll, assert, beforeAll, describe, expect, it, vi } from 'vitest';

import { bundleStackScripts, type LocalStack, startStack } from '../src/stack.ts';

/**
 * A stack given its Workers bundled ahead of time, as a command that ships them bundled gives them:
 * it runs what it is given, and bundles nothing of its own.
 */

const bundling = vi.hoisted(() => ({ allowed: true, calls: 0 }));

vi.mock(import('../src/bundle.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    bundleWorker: (...args: Parameters<typeof actual.bundleWorker>) => {
      bundling.calls += 1;
      if (!bundling.allowed) {
        throw new Error('the stack bundled a Worker it was given');
      }
      return actual.bundleWorker(...args);
    },
  };
});

const START_MS = 60_000;
const ANSWER = 'answered by the Function';
const APP = `export default { fetch() { return new Response(${JSON.stringify(ANSWER)}); } };`;

async function writeBundle(dir: string): Promise<string> {
  const blobs = path.join(dir, '.arkor/blobs');
  const bundleDir = path.dirname(blobs);
  await mkdir(blobs, { recursive: true });
  const bytes = Buffer.from(APP);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(blobs, sha256), bytes);
  const blob: BlobRef = { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' };
  const bundle: DeploymentBundle = {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'test',
    projectDir: '.',
    generatedAt: new Date().toISOString(),
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
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [{ name: 'index.mjs', type: 'esm', blob }],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  };
  await writeFile(path.join(bundleDir, 'bundle.json'), JSON.stringify(bundle));
  return bundleDir;
}

describe('a stack given its Workers', () => {
  const state: { dir?: string; stack?: LocalStack } = {};

  beforeAll(async () => {
    const scripts = await bundleStackScripts();
    bundling.allowed = false;
    bundling.calls = 0;
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-scripts-'));
    state.stack = await startStack({ bundleDir: await writeBundle(state.dir), scripts });
  }, START_MS);

  afterAll(async () => {
    await state.stack?.dispose();
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  it('serves the build with them, and bundles nothing', async () => {
    const { stack } = state;
    assert(stack !== undefined, 'the stack started');
    const response = await fetch(stack.url);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(ANSWER);
    expect(bundling.calls).toBe(0);
  });
});
