import { r2ArtifactKey, sha256Hex } from '@stayingupwind/core/artifact';
import {
  buildProjectManifest,
  computeManifestId,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY, edgePointerSchema } from '@stayingupwind/host/delivery';
import { kvManifestKey } from '@stayingupwind/host/storage';
import { describe, expect, it } from 'vitest';

import { type DeployTarget, publishDeployment } from '../src/deploy.ts';
import { edgePointerOf } from '../src/pointer.ts';

const GENERATED_AT = '2026-10-24T00:00:00.000Z';
const GENERATED_AT_MS = 1_792_800_000_000;
const PRIVATE_PATH = '/private';
const POINTER_KEY = 'pointer';

function storage(values: Map<string, Uint8Array>) {
  return {
    get: (key: string): Promise<Uint8Array | undefined> => Promise.resolve(values.get(key)),
    put: (key: string, value: Uint8Array | string): Promise<void> => {
      values.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
      return Promise.resolve();
    },
  };
}

async function publication(gated: boolean) {
  const shell = new TextEncoder().encode('<html>the application</html>');
  const sha256 = await sha256Hex(shell);
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run_pointer_gate',
    generatedAt: GENERATED_AT,
    originHost: 'site.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: GENERATED_AT },
    app: { deploymentId: 'deployment', scriptName: 'site-app' },
    routes: [
      {
        pathname: PRIVATE_PATH,
        status: 200,
        shell: {
          sha256,
          byteLength: shell.byteLength,
          contentType: 'text/html; charset=utf-8',
          encoding: 'identity',
        },
        headers: { 'content-type': 'text/html; charset=utf-8' },
        prerenderId: PRIVATE_PATH,
      },
    ],
    ...(gated && {
      gates: { [PRIVATE_PATH]: 'authorization' },
      gatedPathnames: { [PRIVATE_PATH]: PRIVATE_PATH },
    }),
  });
  const serialized = serializeManifest(manifest);
  const manifestId = await computeManifestId(manifest);
  const bucket = new Map<string, Uint8Array>([[r2ArtifactKey(sha256), shell]]);
  const namespace = new Map<string, Uint8Array>();
  const target: DeployTarget = {
    blobs: { uploaded: true, read: () => Promise.resolve(undefined) },
    bucket: storage(bucket),
    edgeState: storage(namespace),
  };
  return { manifestId, serialized, namespace, target };
}

function parsedPointer(stored: Uint8Array | undefined) {
  if (stored === undefined) throw new Error('published pointer missing');
  const json = new TextDecoder().decode(stored);
  const value: unknown = JSON.parse(json);
  return edgePointerSchema.parse(value);
}

describe('both independent gate markers of a freshly published pointer', () => {
  it.each([true, false])(
    'survives publication, pointer KV and schema parsing for gated=%s',
    async (gated) => {
      const subject = await publication(gated);
      const pointer = await publishDeployment(
        subject.target,
        { manifestId: subject.manifestId, serialized: subject.serialized, blobs: [] },
        { policy: DEFAULT_DELIVERY_POLICY, now: () => GENERATED_AT_MS },
      );
      const json = JSON.stringify(pointer);
      await subject.target.edgeState.put(POINTER_KEY, json);
      const stored = await subject.target.edgeState.get(POINTER_KEY);
      const parsed = parsedPointer(stored);
      const manifestKey = kvManifestKey(subject.manifestId);
      const storedManifest = subject.namespace.get(manifestKey);
      const manifestJson = new TextDecoder().decode(storedManifest);

      expect({
        pointerRequiresGate: Reflect.get(pointer, 'requiresGate'),
        parsedRequiresGate: Reflect.get(parsed, 'requiresGate'),
        pointerHasGates: Reflect.get(pointer, 'hasGates'),
        parsedHasGates: Reflect.get(parsed, 'hasGates'),
      }).toStrictEqual({
        pointerRequiresGate: gated ? true : undefined,
        parsedRequiresGate: gated ? true : undefined,
        pointerHasGates: gated ? true : undefined,
        parsedHasGates: gated ? true : undefined,
      });
      expect(JSON.stringify(parsed)).toBe(json);
      expect(manifestJson).toBe(subject.serialized);

      const rebuilt = edgePointerOf(
        { projectId: parsed.projectId, originHost: parsed.originHost },
        {
          fingerprint: { assetSetHash: 'a'.repeat(64), observedAt: GENERATED_AT },
          manifestId: subject.manifestId,
          policyId: parsed.policyId,
          app: parsed.app,
          requiresGate: gated,
          hasGates: gated ? true : undefined,
          cspNonce: false,
        },
        GENERATED_AT_MS,
      );

      expect(Reflect.get(rebuilt, 'requiresGate')).toBe(gated ? true : undefined);
      expect(Reflect.get(rebuilt, 'hasGates')).toBe(gated ? true : undefined);
      expect(edgePointerSchema.safeParse({ ...parsed, requiresGate: false }).success).toBe(false);
      expect(edgePointerSchema.safeParse({ ...parsed, hasGates: false }).success).toBe(false);
    },
  );
});
