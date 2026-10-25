import {
  buildProjectManifest,
  computeManifestId,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY, edgePointerSchema } from '@stayingupwind/host/delivery';
import { describe, expect, it } from 'vitest';

import { publishDeployment, type DeployTarget } from '../src/deploy.ts';
import { edgePointerOf } from '../src/pointer.ts';

const NOW = '2026-10-24T00:00:00.000Z';
const NOW_MS = 1_792_800_000_000;
const APP = { deploymentId: 'dpl_site', scriptName: 'site-app' };
const SITE = { projectId: 'site', originHost: 'site.example' };
const FINGERPRINT = { assetSetHash: 'a'.repeat(64), observedAt: NOW };

function target(): DeployTarget {
  const stored = new Map<string, Uint8Array>();
  const storage = {
    get: (key: string) => Promise.resolve(stored.get(key)),
    put: (key: string, value: Uint8Array | string) => {
      stored.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
      return Promise.resolve();
    },
  };
  return { blobs: { uploaded: true, read: storage.get }, bucket: storage, edgeState: storage };
}

describe('gate admission survives the independent pointer', () => {
  it.each([true, false])('publishes a marker only for a gated=%s manifest', async (gated) => {
    const manifest = buildProjectManifest({
      ...SITE,
      runId: 'run_site',
      generatedAt: NOW,
      deployment: FINGERPRINT,
      app: APP,
      routes: [],
      staticFiles: {},
      ...(gated && {
        gates: { '/private': 'checker' },
        gatedPathnames: { '/private': '/private' },
      }),
    });
    const pointer = await publishDeployment(
      target(),
      {
        blobs: [],
        serialized: serializeManifest(manifest),
        manifestId: await computeManifestId(manifest),
      },
      { policy: DEFAULT_DELIVERY_POLICY, now: () => NOW_MS },
    );

    expect(pointer.v).toBe(gated ? 2 : 1);
    expect(pointer.hasGates).toBe(gated ? true : undefined);
    expect(edgePointerSchema.parse(pointer).hasGates).toBe(pointer.hasGates);
    expect(JSON.stringify(edgePointerSchema.parse(pointer))).toBe(JSON.stringify(pointer));
  });

  it.each([
    { version: 1, marker: undefined, accepted: true },
    { version: 1, marker: true, accepted: false },
    { version: 1, marker: false, accepted: false },
    { version: 2, marker: true, accepted: true },
    { version: 2, marker: undefined, accepted: false },
    { version: 2, marker: false, accepted: false },
    { version: 3, marker: true, accepted: false },
  ])(
    'requires the version and gate marker together: $version/$marker',
    ({ version, marker, accepted }) => {
      const pointer = edgePointerOf(
        SITE,
        {
          fingerprint: FINGERPRINT,
          manifestId: 'manifest',
          policyId: DEFAULT_DELIVERY_POLICY.id,
          app: APP,
          cspNonce: false,
        },
        NOW_MS,
      );

      expect(
        edgePointerSchema.safeParse({ ...pointer, v: version, hasGates: marker }).success,
      ).toBe(accepted);
    },
  );

  it('keeps legacy pointer bytes without a marker and rejects an explicit false marker', () => {
    const pointer = edgePointerOf(
      SITE,
      {
        fingerprint: FINGERPRINT,
        manifestId: 'manifest',
        policyId: DEFAULT_DELIVERY_POLICY.id,
        app: APP,
        cspNonce: false,
      },
      NOW_MS,
    );

    expect(Object.hasOwn(pointer, 'hasGates')).toBe(false);
    expect(edgePointerSchema.safeParse({ ...pointer, hasGates: false }).success).toBe(false);
  });

  it('retains a requiresGate-only legacy pointer without accepting it as unmarked version two', () => {
    const pointer = edgePointerOf(
      SITE,
      {
        fingerprint: FINGERPRINT,
        manifestId: 'manifest',
        policyId: DEFAULT_DELIVERY_POLICY.id,
        app: APP,
        requiresGate: true,
        cspNonce: false,
      },
      NOW_MS,
    );

    expect(pointer.v).toBe(1);
    expect(Object.hasOwn(pointer, 'hasGates')).toBe(false);

    const parsed = edgePointerSchema.parse(pointer);

    expect(parsed.requiresGate).toBe(true);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(pointer));
    expect(edgePointerSchema.safeParse({ ...pointer, v: 2 }).success).toBe(false);
  });
});
