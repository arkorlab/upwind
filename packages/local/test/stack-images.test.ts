import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BlobRef, DeploymentBundle } from '@stayingupwind/core/bundle';
import type { ImagesConfig } from '@stayingupwind/core/images';
import { createId } from '@stayingupwind/core/util';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';

import { bundleStackScripts, type LocalStack, startStack } from '../src/stack.ts';

/**
 * A stack's edge with its Images binding and without: what `/_next/image` answers for a PNG the
 * build holds, transformed on this machine (Miniflare's binding, `sharp` beneath it) or as it is.
 */

const START_MS = 60_000;
/** A PNG of one red pixel, whole enough for an encoder to read. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const APP = 'export default { fetch() { return new Response("answered by the Function"); } };';
const WIDTH = 64;
const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [WIDTH],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

async function blobOf(blobs: string, bytes: Buffer, contentType: string): Promise<BlobRef> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(blobs, sha256), bytes);
  return { sha256, byteLength: bytes.byteLength, contentType };
}

/** A build of one Function and one PNG, `/pixel.png`, with `next/image` configured. */
async function writeBundle(dir: string): Promise<string> {
  const blobs = path.join(dir, '.arkor/blobs');
  const bundleDir = path.dirname(blobs);
  await mkdir(blobs, { recursive: true });
  const app = await blobOf(blobs, Buffer.from(APP), 'text/javascript');
  const pixel = await blobOf(blobs, PIXEL, 'image/png');
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
      images: IMAGES,
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
    staticFiles: [{ pathname: '/pixel.png', blob: pixel, immutable: false }],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [{ name: 'index.mjs', type: 'esm', blob: app }],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  };
  await writeFile(path.join(bundleDir, 'bundle.json'), JSON.stringify(bundle));
  return bundleDir;
}

/** What `/_next/image` answers for the PNG, asked by a browser that takes WebP. */
async function optimized(stack: LocalStack): Promise<{ status: number; type: string | null }> {
  const url = new URL(
    `/_next/image?url=${encodeURIComponent('/pixel.png')}&w=${String(WIDTH)}&q=75`,
    stack.url,
  );
  const response = await fetch(url, { headers: { accept: 'image/webp,image/*,*/*;q=0.8' } });
  await response.arrayBuffer();
  return { status: response.status, type: response.headers.get('content-type') };
}

describe("a stack's edge and its Images binding", () => {
  const state: { dir?: string; transforming?: LocalStack; asItIs?: LocalStack } = {};

  beforeAll(async () => {
    const scripts = await bundleStackScripts();
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-images-'));
    const bundleDir = await writeBundle(state.dir);
    const [transforming, asItIs] = await Promise.all([
      startStack({ bundleDir, scripts, images: true }),
      startStack({ bundleDir, scripts }),
    ]);
    state.transforming = transforming;
    state.asItIs = asItIs;
  }, START_MS);

  afterAll(async () => {
    await Promise.all([state.transforming?.dispose(), state.asItIs?.dispose()]);
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  it('transforms an image where the edge is bound to Images', async () => {
    const { transforming } = state;
    assert(transforming !== undefined, 'the stack started');

    await expect(optimized(transforming)).resolves.toStrictEqual({
      status: 200,
      type: 'image/webp',
    });
  });

  it('answers an image as it is where the edge is bound to none', async () => {
    const { asItIs } = state;
    assert(asItIs !== undefined, 'the stack started');

    await expect(optimized(asItIs)).resolves.toStrictEqual({ status: 200, type: 'image/png' });
  });
});
