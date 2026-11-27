import { sha256HexOfText } from '@stayingupwind/core/artifact';
import {
  computeManifestId,
  parseProjectManifest,
  serializeManifest,
} from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { fixtureBundle, rootPrerender } from '../../core/test/fixtures/bundle.ts';
import { assembleManifest, type AssembleManifestInput } from '../src/manifest.ts';

function inputFor(count: number): AssembleManifestInput {
  const built = fixtureBundle();
  const root = rootPrerender();
  const prerenders = Array.from({ length: count }, (_, i) => {
    const pathname = `/docs/page-${String(i)}`;
    return {
      ...root,
      id: pathname,
      pathname,
      route: pathname,
      parentOutputId: pathname,
      initialHeaders: { ...root.initialHeaders, 'x-next-cache-tags': 'documentation' },
    };
  });
  const kind = 'app-page' as const;
  const bundle = {
    ...built,
    prerenders,
    entrypoints: prerenders.map(({ id, pathname }) => ({ id, pathname, kind })),
  };
  return {
    bundle,
    previous: undefined,
    projectId: 'compact',
    runId: 'run',
    originHost: 'site.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      dplId: bundle.deploymentId,
      assetSetHash: 'assets',
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'app' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-recovery'",
  };
}

async function assembled(input: AssembleManifestInput) {
  const result = await assembleManifest(input);
  if (result.kind !== 'assembled') throw new Error(result.reason);
  return result;
}

describe('opt-in compact manifest publication', () => {
  it('publishes a smaller manifest at the digest of the bytes a reader can reproduce', async () => {
    const input = inputFor(12);
    const original = await assembled(input);
    const compact = await assembled({ ...input, compactManifestTables: true });
    const read = parseProjectManifest(compact.serialized);

    expect(original.manifest.schemaVersion).toBe(6);
    expect(read).toStrictEqual({ ...original.manifest, schemaVersion: 9 });
    expect(compact.manifest).toStrictEqual(read);
    expect(compact.serialized.length).toBeLessThan(original.serialized.length);
    expect(compact.serialized).toBe(serializeManifest(read));
    expect(compact.manifestId).toBe(await sha256HexOfText(compact.serialized));
    expect(compact.manifestId).toBe(await computeManifestId(read));
  });

  it('keeps the original version, bytes and digest when there is nothing to share', async () => {
    const input = inputFor(0);
    const original = await assembled(input);
    const optedIn = await assembled({ ...input, compactManifestTables: true });

    expect(optedIn.manifest.schemaVersion).toBe(original.manifest.schemaVersion);
    expect(optedIn.serialized).toBe(original.serialized);
    expect(optedIn.manifestId).toBe(original.manifestId);
  });
});
