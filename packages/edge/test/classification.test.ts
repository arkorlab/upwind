import { buildProjectManifest } from '@stayingupwind/core/manifest';
import { classifyRequest, NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { manifestForClassification } from '../src/classification.ts';

const PATHNAME = '/something';
const ENTRY_ID = 'entry_validation';
const DATE = '2026-10-20T00:00:00.000Z';

function manifestFor(version: 1 | 2) {
  return buildProjectManifest({
    projectId: 'site',
    runId: 'run_validation',
    generatedAt: DATE,
    originHost: 'site.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: DATE },
    app: { deploymentId: 'dpl_validation', scriptName: 'validation-app' },
    cache: { keySchemaVersion: 1, scopeId: 'dpl_validation' },
    routes: [
      {
        pathname: PATHNAME,
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        shell: {
          sha256: 'b'.repeat(64),
          byteLength: 45,
          contentType: 'text/html; charset=utf-8',
          encoding: 'identity',
        },
        cache: { entryId: ENTRY_ID, kind: 'pages', delivery: 'complete', route: PATHNAME },
      },
    ],
    staticPages: [
      {
        pathname: PATHNAME,
        route: PATHNAME,
        entryId: ENTRY_ID,
        ...(version === 2 && { staticPagePrivacy: 2 as const }),
      },
    ],
  });
}

function classification(manifest: ReturnType<typeof manifestFor>, validated: boolean) {
  return classifyRequest({
    method: 'GET',
    url: new URL(`https://site.example${PATHNAME}`),
    headers: new Headers({ accept: 'text/html', ...NAVIGATION_REQUEST_HEADERS }),
    manifest: manifestForClassification(manifest, validated),
    deployment: manifest.deployment,
  });
}

describe('candidate build-shell classification', () => {
  it.each([1, 2] as const)(
    'keeps live version %i generation authority and manifest identity',
    (version) => {
      const manifest = manifestFor(version);

      expect(manifestForClassification(manifest, false)).toBe(manifest);
      expect(classification(manifest, false)).toStrictEqual({
        kind: 'static-page',
        entry: manifest.staticPages?.[PATHNAME],
      });
    },
  );

  it.each([1, 2] as const)(
    'proves the existing build shell for a signed version %i candidate',
    (version) => {
      const manifest = manifestFor(version);
      const original = structuredClone(manifest);
      const candidate = manifestForClassification(manifest, true);

      expect(classification(manifest, true)).toStrictEqual({
        kind: 'document',
        entry: manifest.routes[PATHNAME],
      });
      expect(candidate.routes).toBe(manifest.routes);
      expect(candidate.cache).toBe(manifest.cache);
      expect(candidate.staticPages).toBeUndefined();
      expect(manifest).toStrictEqual(original);
      expect(classification(manifest, false).kind).toBe('static-page');
    },
  );

  it('retains the original manifest for candidates without static Pages mappings', () => {
    const manifest = { ...manifestFor(1), staticPages: undefined };

    expect(manifestForClassification(manifest, true)).toBe(manifest);
    expect(classification(manifest, true).kind).toBe('document');
  });

  it('never invents a proved build route from a generation mapping alone', () => {
    const manifest = { ...manifestFor(2), routes: {} };

    expect(classification(manifest, true)).toStrictEqual({
      kind: 'passthrough',
      reason: 'route-not-proved',
    });
  });
});
