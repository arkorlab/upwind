import type { GenerationTag } from '@stayingupwind/core/cache';
import { assembleManifest } from '@stayingupwind/deploy/manifest';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { describe, expect, it, vi } from 'vitest';

import type { CheckedStack, Verdict } from '../src/answers.ts';
import { unheldRoutes } from '../src/held-routes.ts';
import type { BuiltParts } from '../src/parts.ts';
import { SHARED_SHELL, shellBundle } from './build-tags-fixture.ts';

// Only static route conformance is examined: no filesystem shell, Worker or transport is read.
vi.mock(import('../src/shells.ts'), () => ({ blobBytesOf: vi.fn() }));
vi.mock(import('../src/parts.ts'), () => {
  const builtPartsOf = vi.fn<() => BuiltParts>(() => {
    const documents = new Map<string, string>();
    return {
      documents,
      segments: new Map(),
      payloads: new Map(),
      pagesData: new Map(),
      resumable: new Set(),
    };
  });
  return { builtPartsOf };
});

const MISMATCH = "held by the manifest with build tag membership different from the build's seed";
type Mutation = 'partial' | 'extra' | 'kind' | 'duplicate';

function changedTags(tags: readonly GenerationTag[], mutation: Mutation): GenerationTag[] {
  if (mutation === 'partial') return tags.slice(1);
  if (mutation === 'extra') return [...tags, { kind: 'next-explicit', value: 'never-seeded' }];
  if (mutation === 'duplicate') return [...tags.slice(1), tags[1]!];
  return tags.map((tag) => ({ ...tag, kind: 'platform-delivery' }));
}

async function fixture() {
  const page = {
    ...SHARED_SHELL,
    id: 'page',
    pathname: '/',
    route: '/',
    routeType: 'page' as const,
    response: 'complete' as const,
    compute: 'static' as const,
    renderingMode: 'STATIC' as const,
    postponed: undefined,
    initialHeaders: { 'x-next-cache-tags': 'first,second' },
  };
  const bundle = shellBundle(page);
  const assembled = await assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'membership-check',
    runId: 'run',
    originHost: 'app.example',
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
    recoverySource: await recoveryScriptCspSource(),
  });
  if (assembled.kind !== 'assembled') throw new Error(assembled.reason);
  const route = assembled.manifest.routes['/'];
  if (route?.cache?.buildTags === undefined) throw new Error('fixture has no trusted build tags');
  const add = vi.fn<(asked: string, verdict: Verdict) => void>();
  return { bundle, manifest: assembled.manifest, route, cache: route.cache, add };
}

async function checked(sample: Awaited<ReturnType<typeof fixture>>) {
  // unheldRoutes uses only this recorded deployment state; transport members stay uninstantiated.
  const stack = {
    bundle: sample.bundle,
    manifest: sample.manifest,
    deploymentId: sample.bundle.deploymentId,
  } as unknown as CheckedStack;
  await unheldRoutes(stack, { add: sample.add });
}

describe('present immutable membership in local manifest conformance', () => {
  it.each(['partial', 'extra', 'kind', 'duplicate'] as const)(
    'rejects %s trusted membership',
    async (mutation) => {
      const sample = await fixture();
      sample.manifest.routes['/'] = {
        ...sample.route,
        cache: { ...sample.cache, buildTags: changedTags(sample.cache.buildTags!, mutation) },
      };

      await checked(sample);

      expect(sample.add).toHaveBeenCalledExactlyOnceWith('/', { kind: 'failed', reason: MISMATCH });
    },
  );

  it('accepts the exact trusted membership', async () => {
    const sample = await fixture();

    await checked(sample);

    expect(sample.add).not.toHaveBeenCalled();
  });

  it('accepts the whole trusted membership in a different order', async () => {
    const sample = await fixture();
    sample.manifest.routes['/'] = {
      ...sample.route,
      cache: { ...sample.cache, buildTags: sample.cache.buildTags!.toReversed() },
    };

    await checked(sample);

    expect(sample.add).not.toHaveBeenCalled();
  });

  it('accepts complete optional membership omission', async () => {
    const sample = await fixture();
    const cache = { ...sample.cache };
    delete cache.buildTags;
    sample.manifest.routes['/'] = { ...sample.route, cache };

    await checked(sample);

    expect(sample.add).not.toHaveBeenCalled();
  });
});
