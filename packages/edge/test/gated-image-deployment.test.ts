import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CURRENT = 'dpl_site';
const STORED = 'dpl_stored';
const OTHER = 'dpl_other';
const TEMPLATE = '/photos/[name]';
const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
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

/** A native image response, transformed by the test transformer without contacting a service. */
function image(): Response {
  return new Response(
    concatBytes([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      encodeUtf8('image'),
    ]),
    { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=60' } },
  );
}

interface Options {
  readonly dpls: readonly string[];
  readonly fileDeployment?: string;
  readonly gated?: boolean;
}

/** Source selection and source refusal see the same named optimizer deployment. */
async function imaged(options: Options) {
  const path = `/photos/${crypto.randomUUID()}.png`;
  const site = await seedSite({
    document: pprDocument(),
    pathname: TEMPLATE,
    images: CONFIG,
    dplId: CURRENT,
  });
  const bytes = new Uint8Array(await image().arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  const original = {
    sha256,
    byteLength: bytes.byteLength,
    contentType: 'image/png',
    immutable: false,
  };
  const manifest: ProjectManifest = {
    ...site.manifest,
    staticFiles: {
      [path]: { ...original, deploymentId: options.fileDeployment ?? STORED, dplOnly: true },
    },
    dynamicRoutes: [
      { sourceRegex: '^/photos/(?<name>[^/]+?)(?:/)?$', route: TEMPLATE, gated: TEMPLATE },
    ],
    ...(options.gated !== false && {
      gates: { [TEMPLATE]: 'members' },
      gatedPathnames: { [TEMPLATE]: TEMPLATE },
    }),
  };
  const dispatchApp = vi.fn(() => Promise.resolve(image()));
  const transformImage = vi.fn(async (source: ReadableStream<Uint8Array>) => {
    return {
      contentType: 'image/webp',
      body: new Blob([await new Response(source).arrayBuffer()]).stream(),
    };
  });
  const gate = vi.fn(() =>
    Promise.resolve(new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } })),
  );
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp,
    transformImage,
  });
  const host = { ...standaloneHost(env), gates: { answer: gate } };
  const get = async () => {
    const query = new URLSearchParams({ url: path, w: '64', q: '75' });
    for (const dpl of options.dpls) query.append('dpl', dpl);
    const request: IncomingRequest = new Request(
      `https://site.example/_next/image?${query.toString()}`,
      {
        headers: { accept: 'image/webp', 'sec-fetch-dest': 'image' },
      },
    );
    const ctx = createExecutionContext();
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
        host,
        pointer: site.pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );
    await response.arrayBuffer();
    await waitOnExecutionContext(ctx);
    return { status: response.status, debug: response.headers.get(EDGE_DEBUG_HEADER) };
  };
  return { get, dispatchApp, transformImage, gate };
}

describe('gated image source deployment selection', () => {
  it.each([
    { id: 'foreign pin', dpls: [OTHER] },
    { id: 'unnamed deployment', dpls: [] },
    { id: 'duplicate pin', dpls: [STORED, STORED] },
  ])('refuses a carried file not selected by $id', async ({ dpls }) => {
    const fixture = await imaged({ dpls });
    const first = await fixture.get();
    const again = await fixture.get();

    expect({
      first,
      again,
      functions: fixture.dispatchApp.mock.calls.length,
      transforms: fixture.transformImage.mock.calls.length,
      gates: fixture.gate.mock.calls.length,
    }).toStrictEqual({
      first: { status: 400, debug: 'error;reason=image-source-gated' },
      again: { status: 400, debug: 'error;reason=image-source-gated' },
      functions: 0,
      transforms: 0,
      gates: 0,
    });
  });

  it.each([
    { id: 'selected stored file', dpls: [STORED], fileDeployment: STORED, gated: true },
    { id: 'current file', dpls: [OTHER], fileDeployment: CURRENT, gated: true },
    { id: 'ungated source', dpls: [OTHER], fileDeployment: STORED, gated: false },
  ])('keeps $id available', async (options) => {
    const fixture = await imaged(options);
    const response = await fixture.get();

    expect(response.status).toBe(200);
    expect(fixture.gate).not.toHaveBeenCalled();
  });
});
