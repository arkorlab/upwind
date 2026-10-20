import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { type ImagesConfig, imageResponseHeaders } from '@stayingupwind/core/images';
import {
  buildProjectManifest,
  type ProjectManifest,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { kvManifestKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { assert, describe, expect, it, vi } from 'vitest';

import { replayedDocumentHeaders } from '../src/handlers/document-headers.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getManifest } from '../src/preview/manifest.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const DATE = '2026-10-20T00:00:00.000Z';
const CSP = 'content-security-policy';
const FILE_PATH = '/artifact-type.txt';
const FILE_BODY = 'the shipped Unicode-typed artifact';
const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'",
  contentDispositionType: 'attachment',
};

function manifestWith(
  headers: Record<string, string>,
  imagePolicy: string | undefined,
): ProjectManifest {
  const route = {
    pathname: '/',
    status: 200 as const,
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: 1,
      contentType: 'text/html; charset=utf-8',
      encoding: 'identity' as const,
    },
    headers,
    prerenderId: '/',
  };
  return buildProjectManifest({
    projectId: 'manifest-headers',
    runId: 'run',
    generatedAt: DATE,
    originHost: 'manifest.example',
    deployment: { assetSetHash: 'b'.repeat(64), observedAt: DATE },
    // The stored header table is shared, as it is for routes with identical policies.
    routes: [route, { ...route, pathname: '/other', prerenderId: '/other' }],
    app: { deploymentId: 'dpl_manifestHeaders', scriptName: 'manifest-app' },
    ...(imagePolicy !== undefined && {
      images: { ...CONFIG, contentSecurityPolicy: imagePolicy },
    }),
  });
}

async function coldRead(manifest: ProjectManifest, mode: 'schema' | 'digest') {
  const serialized = serializeManifest(manifest);
  const digest = await sha256HexOfText(serialized);
  const manifestId = mode === 'digest' ? digest : `headers-${digest}`;
  await env.EDGE_STATE.put(kvManifestKey(manifestId), serialized);
  const memory = createEdgeMemory(() => Date.now());
  const runtime = standaloneRuntime(env, { memory });
  const result = await getManifest(env, runtime, manifestId, { live: false });
  return { result, memory, runtime, manifestId };
}

async function fileWithType(contentType: string) {
  const site = await seedSite({ document: pprDocument(), files: { [FILE_PATH]: FILE_BODY } });
  const file = site.manifest.staticFiles?.[FILE_PATH];
  if (file === undefined) throw new Error('the fixture must ship its artifact');
  const manifest: ProjectManifest = {
    ...site.manifest,
    staticFiles: { [FILE_PATH]: { ...file, contentType } },
  };
  return { site, manifest };
}

describe.each(['schema', 'digest'] as const)(
  'stored response headers through %s decode',
  (mode) => {
    it.each([
      { field: 'image', label: 'image CR', value: 'default-src self;\rbroken' },
      { field: 'image', label: 'image LF', value: 'default-src self;\nbroken' },
      { field: 'image', label: 'image NUL', value: 'default-src self;\0broken' },
      { field: 'route', label: 'route CR', value: 'default-src self;\rbroken' },
      { field: 'route', label: 'route LF', value: 'default-src self;\nbroken' },
      { field: 'route', label: 'route NUL', value: 'default-src self;\0broken' },
    ])('refuses $label before retaining the manifest', async ({ field, value }) => {
      const manifest = manifestWith(
        field === 'route' ? { 'Content-Security-Policy': value } : {},
        field === 'image' ? value : undefined,
      );
      const subject = await coldRead(manifest, mode);

      expect(subject.result.kind).toBe('missing');
      expect(subject.memory.manifests.get(subject.manifestId)).toBeUndefined();
      expect(subject.memory.absentManifests.get(subject.manifestId)).toBe(true);

      const repeated = await getManifest(env, subject.runtime, subject.manifestId);

      expect(repeated.kind).toBe('missing');
    });

    it.each([
      { label: 'ordinary policy', value: "default-src 'self'", sent: "default-src 'self'" },
      {
        label: 'HTTP edge whitespace',
        value: "\r\n \tdefault-src 'self'\t \r\n",
        sent: "default-src 'self'",
      },
      {
        label: 'Workers Unicode value',
        value: 'default-src https://日本.example',
        sent: 'default-src https://日本.example',
      },
    ])('retains and sends $label for both consumers', async ({ value, sent }) => {
      const manifest = manifestWith({ 'Content-Security-Policy': value }, value);
      const subject = await coldRead(manifest, mode);

      assert(subject.result.kind === 'found');
      const loaded = subject.result.value;
      const route = loaded.routes['/'];
      const other = loaded.routes['/other'];
      const images = loaded.images;
      assert(route !== undefined && other !== undefined && images !== undefined);
      const documentHeaders = replayedDocumentHeaders(route.headers, {
        headers: {},
        conditioned: false,
      });
      const imageHeaders = imageResponseHeaders({
        href: '/photo.png',
        contentType: 'image/webp',
        isStatic: false,
        maxAge: 60,
        etag: undefined,
        config: images,
        cache: 'MISS',
      });

      expect(route.headers).toStrictEqual({ 'Content-Security-Policy': value });
      expect(other.headers).toStrictEqual(route.headers);
      expect(images.contentSecurityPolicy).toBe(value);
      expect(documentHeaders.get(CSP)).toBe(sent);
      expect(imageHeaders.get(CSP)).toBe(sent);

      const repeated = await getManifest(env, subject.runtime, subject.manifestId);

      expect(repeated.kind === 'found' && repeated.value).toBe(loaded);
    });

    it('keeps an ignored malformed header and absent image config without rejecting the route', async () => {
      const ignored = 'ignored\0\r\nvalue';
      const subject = await coldRead(manifestWith({ 'x-not-replayed': ignored }, undefined), mode);

      assert(subject.result.kind === 'found');
      const route = subject.result.value.routes['/'];
      assert(route !== undefined);
      const headers = replayedDocumentHeaders(route.headers, { headers: {}, conditioned: false });

      expect(route.headers).toStrictEqual({ 'x-not-replayed': ignored });
      expect(headers.has('x-not-replayed')).toBe(false);
      expect(subject.result.value.images).toBeUndefined();
    });

    it.each(['\0', '\r', '\n'])(
      'still refuses an artifact type with embedded %j before retaining the manifest',
      async (control) => {
        const { manifest } = await fileWithType(`text/plain; name=a${control}b`);
        const subject = await coldRead(manifest, mode);

        expect(subject.result.kind).toBe('missing');
        expect(subject.memory.manifests.get(subject.manifestId)).toBeUndefined();
        expect(subject.memory.absentManifests.get(subject.manifestId)).toBe(true);
      },
    );

    it.each([
      { contentType: 'text/plain; name="日本語"', sent: 'text/plain; name="日本語"' },
      {
        contentType: '\r\n \ttext/plain; name="日本語"\t \r\n',
        sent: 'text/plain; name="日本語"',
      },
    ])(
      'decodes and serves a Workers-native artifact type $contentType',
      async ({ contentType, sent }) => {
        const { site, manifest } = await fileWithType(contentType);
        const subject = await coldRead(manifest, mode);
        assert(subject.result.kind === 'found');
        const dispatchApp = vi.fn(() => Promise.resolve(new Response('unexpected Function')));
        const runtime = { ...subject.runtime, dispatchApp };
        const ctx = createExecutionContext();
        const request = navigation(FILE_PATH);

        const response = await serveFromPointer(
          {
            request,
            url: new URL(request.url),
            env,
            ctx,
            runtime,
            host: standaloneHost(env),
            pointer: { ...site.pointer, manifestId: subject.manifestId },
            pointerMs: 0,
            privateDelivery: false,
            cspReportingPath: undefined,
          },
          {
            manifestLookup: Promise.resolve(subject.result),
            policyLookup: Promise.resolve({
              kind: 'found',
              source: 'exact',
              policy: DEFAULT_DELIVERY_POLICY,
            }),
          },
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(FILE_BODY);
        expect(response.headers.get('content-type')).toBe(sent);
        expect(subject.result.value.staticFiles?.[FILE_PATH]?.contentType).toBe(contentType);
        expect(dispatchApp).not.toHaveBeenCalled();
        const repeated = await getManifest(env, runtime, subject.manifestId);
        expect(repeated.kind === 'found' && repeated.value).toBe(subject.result.value);
        await waitOnExecutionContext(ctx);
      },
    );
  },
);
