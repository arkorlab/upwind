import type { AppRuntime } from '@stayingupwind/core/manifest';
import { createId } from '@stayingupwind/core/util';
import { functionBinding } from '@stayingupwind/host/bindings';
import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import type { AccountScope } from '../../src/deploy/cloudflare/workers.ts';
import {
  deploymentOfTag,
  edgeTag,
  type EdgeVersionInput,
  uploadEdgeVersion,
} from '../../src/deploy/edge-version.ts';
import { deploymentLabel, projectNames } from '../../src/deploy/names.ts';
import { sha256Of } from '../../src/deploy/shipped.ts';
import { type FakeCloudflare, type FakeVersion, fakeCloudflare } from './fake-cloudflare.ts';

const NAMES = projectNames('shop');
const SCRIPT = 'export default {}; // edge';

function scopeOf(fake: FakeCloudflare): AccountScope {
  return {
    client: createCloudflareClient({
      apiToken: 'token',
      fetch: fake.fetch,
      sleep: () => Promise.resolve(),
    }),
    accountId: 'account-1',
  };
}

/** A deployment's Functions: an app Function, a split one, and the middleware. */
function appOf(deploymentId: string): AppRuntime {
  const label = deploymentLabel(deploymentId);
  return {
    deploymentId,
    scriptName: `shop-${label}-app`,
    middlewareScriptName: `shop-${label}-mw`,
    functions: { 'app-2': `shop-${label}-app-2` },
  };
}

function inputOf(
  fake: FakeCloudflare,
  deploymentId: string,
  overrides: Partial<EdgeVersionInput> = {},
): EdgeVersionInput {
  return {
    scope: scopeOf(fake),
    names: NAMES,
    stores: { edgeState: 'kv-edge', cacheState: 'kv-cache', bucket: NAMES.artifactsBucket },
    script: { role: 'edge', script: SCRIPT, sha256: sha256Of(SCRIPT) },
    pointer: JSON.stringify({ v: 1, deploymentId }),
    app: appOf(deploymentId),
    hostnames: 'shop-edge.example.workers.dev,shop.example.com',
    images: false,
    reach: { enabled: true, previews_enabled: false },
    message: `upwind deploy ${deploymentId}`,
    existing: new Set(fake.scripts.keys()),
    ...overrides,
  };
}

function newest(fake: FakeCloudflare): FakeVersion {
  const version = fake.scripts.get(NAMES.edge)?.versions[0];
  if (version === undefined) {
    throw new Error('the edge has no version');
  }
  return version;
}

function bindingsOf(version: FakeVersion): readonly Record<string, unknown>[] {
  return version.metadata['bindings'] as readonly Record<string, unknown>[];
}

function versionUploads(fake: FakeCloudflare): number {
  return fake.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith(`/${NAMES.edge}/versions`),
  ).length;
}

describe("the edge's version for a deployment", () => {
  it('is uploaded live for a first deployment, the edge made with the reach it is given', async () => {
    const fake = fakeCloudflare();
    const first = createId('dpl');
    const input = inputOf(fake, first);
    const version = await uploadEdgeVersion(input);
    const deployed = fake.scripts.get(NAMES.edge)?.deployments[0];

    expect(version).toStrictEqual({
      versionId: deployed?.versions[0]?.version_id,
      live: true,
    });
    expect(deployed?.versions).toStrictEqual([{ version_id: version.versionId, percentage: 100 }]);
    expect(fake.scripts.get(NAMES.edge)?.subdomain).toStrictEqual({
      enabled: true,
      previews_enabled: false,
    });

    const uploaded = newest(fake);

    expect(uploaded.metadata).toMatchObject({
      compatibility_flags: ['nodejs_compat'],
      annotations: {
        'workers/tag': edgeTag(first, input.pointer),
        'workers/message': `upwind deploy ${first}`,
      },
    });
    expect(bindingsOf(uploaded)).toStrictEqual([
      { type: 'kv_namespace', name: 'EDGE_STATE', namespace_id: 'kv-edge' },
      { type: 'kv_namespace', name: 'CACHE_STATE', namespace_id: 'kv-cache' },
      { type: 'r2_bucket', name: 'ARTIFACTS', bucket_name: NAMES.artifactsBucket },
      { type: 'plain_text', name: 'POINTER', text: input.pointer },
      { type: 'plain_text', name: 'HOSTNAMES', text: input.hostnames },
      { type: 'service', name: 'CACHE_SIGNALS', service: NAMES.cache, entrypoint: 'CacheSignals' },
      { type: 'version_metadata', name: 'CF_VERSION_METADATA' },
      ...[input.app.scriptName, input.app.middlewareScriptName, input.app.functions?.['app-2']].map(
        (service) => ({ type: 'service', name: functionBinding(service ?? ''), service }),
      ),
    ]);
  });

  it('is uploaded with no traffic for every later deployment, and with images where asked', async () => {
    const fake = fakeCloudflare();
    const live = await uploadEdgeVersion(inputOf(fake, createId('dpl')));
    const next = await uploadEdgeVersion(inputOf(fake, createId('dpl'), { images: true }));

    expect(next.live).toBe(false);
    expect(next.versionId).not.toBe(live.versionId);
    expect(versionUploads(fake)).toBe(1);
    expect(fake.scripts.get(NAMES.edge)?.deployments[0]?.versions).toStrictEqual([
      { version_id: live.versionId, percentage: 100 },
    ]);
    expect(bindingsOf(newest(fake))).toContainEqual({ type: 'images', name: 'IMAGES' });
  });

  it('narrows nothing of the reach the live version has, for a later deployment', async () => {
    const fake = fakeCloudflare();
    await uploadEdgeVersion(inputOf(fake, createId('dpl')));
    await uploadEdgeVersion(
      inputOf(fake, createId('dpl'), { reach: { enabled: false, previews_enabled: false } }),
    );

    // Still on workers.dev: the live version is reached there until the new one has the traffic.
    expect(fake.scripts.get(NAMES.edge)?.subdomain).toStrictEqual({
      enabled: true,
      previews_enabled: false,
    });
  });

  it('widens the reach for a later deployment, for its version to be asked there', async () => {
    const fake = fakeCloudflare();
    await uploadEdgeVersion(
      inputOf(fake, createId('dpl'), { reach: { enabled: false, previews_enabled: false } }),
    );

    expect(fake.scripts.get(NAMES.edge)?.subdomain.enabled).toBe(false);

    await uploadEdgeVersion(inputOf(fake, createId('dpl')));

    expect(fake.scripts.get(NAMES.edge)?.subdomain).toStrictEqual({
      enabled: true,
      previews_enabled: false,
    });
  });
});

describe("an edge version's tag", () => {
  it('names the deployment, and the pointer by its digest', () => {
    const deploymentId = createId('dpl');
    const tag = edgeTag(deploymentId, '{"v":1}');

    expect(tag).toMatch(/^dpl_\w+:[\da-f]{12}$/u);
    expect(tag.startsWith(`${deploymentId}:`)).toBe(true);
    expect(edgeTag(deploymentId, '{"v":2}')).not.toBe(tag);
    expect(deploymentOfTag(tag)).toBe(deploymentId);
    expect(deploymentOfTag('upwind:infra:0123456789abcdef')).toBeUndefined();
    expect(deploymentOfTag(undefined)).toBeUndefined();
  });
});
