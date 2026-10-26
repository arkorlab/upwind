import { describe, expect, it } from 'vitest';

import {
  buildProjectManifest,
  MAX_MANIFEST_BYTES,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';

describe('stored manifest parsing', () => {
  it('keeps shared policies, conditions, and preloads shared after validation', () => {
    const observedAt = '2026-10-08T00:00:00.000Z';
    const headers = { 'content-security-policy': "default-src 'self'" };
    const bypassFor = [{ type: 'header' as const, key: 'next-action' }];
    const preloads = ['</font.woff2>; rel=preload; as=font'];
    const manifest = buildProjectManifest({
      projectId: 'shared',
      runId: 'shared',
      generatedAt: observedAt,
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt },
      app: { deploymentId: 'dpl_1', scriptName: 'app-1' },
      routes: ['/a', '/b'].map((pathname) => ({
        pathname,
        status: 200,
        shell: {
          sha256: '0'.repeat(64),
          byteLength: 1,
          contentType: 'text/html',
          encoding: 'identity' as const,
        },
        headers,
        bypassFor,
        preloads,
      })),
    });
    const parsed = parseProjectManifest(serializeManifest(manifest));
    expect(parsed).toStrictEqual(manifest);
    expect(parsed.routes['/a']?.headers).toBe(parsed.routes['/b']?.headers);
    expect(parsed.routes['/a']?.bypassFor).toBe(parsed.routes['/b']?.bypassFor);
    expect(parsed.routes['/a']?.bypassFor?.[0]).toBe(parsed.routes['/b']?.bypassFor?.[0]);
    expect(parsed.routes['/a']?.preloads).toBe(parsed.routes['/b']?.preloads);
  });

  it('refuses oversized JSON before trying to parse it', () => {
    expect(() => parseProjectManifest(' '.repeat(MAX_MANIFEST_BYTES + 1))).toThrow(/at most/u);
  });
});
