import { sha256HexOfText } from '@stayingupwind/core/artifact';
import { type ImagesConfig, imageResponseHeaders } from '@stayingupwind/core/images';
import {
  buildProjectManifest,
  type ProjectManifest,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { kvManifestKey } from '@stayingupwind/host/storage';
import { env } from 'cloudflare:workers';
import { assert, describe, expect, it } from 'vitest';

import { replayedDocumentHeaders } from '../src/handlers/document-headers.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getManifest } from '../src/preview/manifest.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';

const DATE = '2026-10-20T00:00:00.000Z';
const CSP = 'content-security-policy';
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
  },
);
