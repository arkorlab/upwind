import { sha256HexOfText } from '@stayingupwind/core/artifact';
import {
  buildProjectManifest,
  MAX_MANIFEST_BYTES,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { EDGE_ISOLATE_BUDGET_BYTES, manifestCharge } from '@stayingupwind/host/delivery';
import { kvManifestKey, r2ManifestKey } from '@stayingupwind/host/storage';
import { env } from 'cloudflare:workers';
import { assert, describe, expect, it, vi } from 'vitest';

import type { BlobWorker } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getManifest } from '../src/preview/manifest.ts';
import { standaloneRuntime } from '../src/standalone/index.ts';

const DATE = '2026-10-18T00:00:00.000Z';
const ROUTES = 1000;
const CONDITIONS = 600;
const INLINE_CONDITIONS = 420;
const BLOB_ORIGIN = 'https://manifest-copy.example';

/** Valid route copies whose stored condition table is shared by the digest-vouched reader. */
function storedMembers(shared = true): string {
  const conditionCount = shared ? CONDITIONS : INLINE_CONDITIONS;
  const route = {
    sourceRegex: '^/([^/]+)$',
    members: {
      route: '/[id]',
      kind: 'app-page' as const,
      bypassFor: Array.from({ length: conditionCount }, () => ({ type: 'host' as const })),
    },
  };
  const manifest = buildProjectManifest({
    projectId: 'manifest-memory',
    runId: 'run',
    generatedAt: DATE,
    originHost: 'manifest.example',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: DATE },
    routes: [],
    app: { deploymentId: 'dpl_manifestMemory', scriptName: 'manifest-app' },
    dynamicRoutes: [route],
  });
  const listed = {
    ...manifest,
    dynamicRoutes: Array.from({ length: ROUTES }, () => route),
  };
  // Legacy documents have inline arrays; JSON gives every route its own physical conditions.
  return shared ? serializeManifest(listed) : JSON.stringify(listed);
}

describe('the stored graph held under a manifest’s digest', () => {
  it.each(['kv', 'r2', 'blob-cache'] as const)(
    'holds shared member conditions once after reading %s',
    async (store) => {
      const serialized = storedMembers();
      const bytes = new TextEncoder().encode(serialized).byteLength;
      const manifestId = await sha256HexOfText(serialized);
      await env.EDGE_STATE.delete(kvManifestKey(manifestId));
      await env.ARTIFACTS.delete(r2ManifestKey(manifestId));
      let blobWorker: BlobWorker | undefined;
      switch (store) {
        case 'kv': {
          await env.EDGE_STATE.put(kvManifestKey(manifestId), serialized);
          break;
        }
        case 'r2': {
          await env.ARTIFACTS.put(r2ManifestKey(manifestId), serialized);
          break;
        }
        case 'blob-cache': {
          await caches.default.put(
            `${BLOB_ORIGIN}/manifests/${manifestId}`,
            new Response(serialized, { headers: { 'cache-control': 'public, max-age=3600' } }),
          );
          blobWorker = async (path) => {
            return (
              (await caches.default.match(`${BLOB_ORIGIN}${path}`)) ??
              new Response(null, { status: 404 })
            );
          };
          break;
        }
      }
      const memory = createEdgeMemory(() => Date.now());
      const runtime = standaloneRuntime(env, { memory, ...(blobWorker && { blobWorker }) });
      const admitted = vi.spyOn(memory.manifests, 'set');
      const first = await getManifest(env, runtime, manifestId);

      expect(first.kind).toBe('found');

      assert(first.kind === 'found');
      const routes = first.value.dynamicRoutes;

      expect(routes?.[0]?.members?.bypassFor).toBe(routes?.[1]?.members?.bypassFor);
      expect(routes?.[0]?.members).not.toBe(routes?.[1]?.members);
      expect(manifestCharge(first.value, bytes)).toBeLessThan(EDGE_ISOLATE_BUDGET_BYTES);
      expect(memory.manifests.get(manifestId)).toBe(first.value);

      const second = await getManifest(env, runtime, manifestId);

      expect(second.kind === 'found' && second.value).toBe(first.value);
      expect(admitted).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves validated table references under a non-digest name', async () => {
    const manifestId = 'manifest-without-a-digest';
    await env.EDGE_STATE.put(kvManifestKey(manifestId), storedMembers());
    const memory = createEdgeMemory(() => Date.now());
    const runtime = standaloneRuntime(env, { memory });

    const read = await getManifest(env, runtime, manifestId);

    assert(read.kind === 'found');
    const routes = read.value.dynamicRoutes;

    expect(routes?.[0]?.members?.bypassFor).toBe(routes?.[1]?.members?.bypassFor);
    expect(memory.manifests.get(manifestId)).toBe(read.value);
  });

  it('still refuses inline conditions whose distinct objects exceed the memory budget', async () => {
    const manifestId = 'manifest-with-inline-conditions';
    const serialized = storedMembers(false);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(MAX_MANIFEST_BYTES);

    await env.EDGE_STATE.put(kvManifestKey(manifestId), serialized);
    const memory = createEdgeMemory(() => Date.now());
    const runtime = standaloneRuntime(env, { memory });
    const read = await getManifest(env, runtime, manifestId);

    expect(read.kind).toBe('missing');
    expect(memory.manifests.get(manifestId)).toBeUndefined();
  });
});
