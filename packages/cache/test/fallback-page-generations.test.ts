import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  deriveEntry,
  kvGenerationKey,
  policyFromCacheControl,
  r2BlobKey,
} from '@stayingupwind/core/cache';
import { createId, decodeUtf8, encodeUtf8 } from '@stayingupwind/core/util';
import { seedRouteFor } from '@stayingupwind/host/bundle';
import { commitRequestSchema, type SeedEntryInput } from '@stayingupwind/host/cache';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Exercise the native publication fixture across the packages. */
import {
  FALLBACK_NOW,
  FALLBACK_ROUTE,
  LAZY_PATH,
  fallbackPageFixture,
} from '../../host/test/fallback-page-fixture.ts';
import { scopeStub } from '../src/scope/stub.ts';

async function scope() {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        organizationId: 'owner',
        projectId: 'site',
        environmentId: 'production',
        deploymentId: scopeId,
        keySchemaVersion: 1,
        buildId: 'build',
      },
    },
    FALLBACK_NOW,
  );
  const fixture = await fallbackPageFixture();
  const seed = await seedRouteFor(fixture.bundle, fixture.page, {
    scopeId,
    generatedAt: FALLBACK_NOW,
  });
  if (seed === undefined) throw new Error('missing concrete build seed');
  const { entryId } = await deriveEntry(scopeId, seed.input.descriptor);
  return { scopeId, stub, fixture, seed: seed.input, entryId };
}

type Scope = Awaited<ReturnType<typeof scope>>;

async function storeBuild(test: Scope) {
  for (const output of test.seed.generation.outputs) {
    for (const artifact of output.artifacts) {
      await env.ARTIFACTS.put(
        artifact.storageRef,
        (artifact.role === 'html' ? test.fixture.html : test.fixture.data) as BufferSource,
      );
    }
  }
}

function decoded(bytes: ArrayBuffer | Uint8Array | undefined | null) {
  if (bytes === undefined || bytes === null) throw new Error('missing current pack');
  const result = decodeGenerationPack(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  if (result.kind !== 'ok') throw new Error('current pack did not decode');
  return result.pack;
}

async function published(test: Scope, entryId = test.entryId) {
  return decoded(await env.CACHE_STATE.get(kvGenerationKey(test.scopeId, entryId), 'arrayBuffer'));
}

async function runtime(test: Scope, label: string) {
  const descriptor = { kind: 'pages' as const, route: FALLBACK_ROUTE, pathname: LAZY_PATH };
  const lease = await test.stub.startAttempt({ entry: descriptor, reason: 'miss' }, FALLBACK_NOW);
  if (lease.kind !== 'leased') throw new Error('missing concrete render lease');
  const outputs = [];
  for (const role of ['html', 'pages-data'] as const) {
    const bytes = encodeUtf8(
      role === 'html' ? `<p>${label}</p>` : JSON.stringify({ pageProps: { label } }),
    );
    const artifact = {
      role,
      sha256: await sha256Hex(bytes),
      byteLength: bytes.byteLength,
      contentType: role === 'html' ? 'text/html' : 'application/json',
      encoding: 'identity' as const,
    };
    const storageRef = r2BlobKey(test.scopeId, artifact.sha256);
    await env.ARTIFACTS.put(storageRef, bytes as BufferSource);

    await test.stub.recordArtifact(
      lease.attemptId,
      { ...artifact, storageRef, fencingToken: lease.fencingToken },
      FALLBACK_NOW,
    );

    outputs.push({
      representationKey: role,
      pathname: role === 'html' ? LAZY_PATH : '/_next/data/build/fallback-true/second.json',
      status: 200,
      headers: { 'content-type': artifact.contentType },
      compute: 'static',
      response: 'complete',
      staticPagePrivacy: 3,
      htmlSize: role === 'html' ? bytes.byteLength : null,
      artifacts: [artifact],
    });
  }
  const request = commitRequestSchema.parse({
    fencingToken: lease.fencingToken,
    observedTagRevision: lease.dependencyRevision,
    generation: {
      cacheTimestamp: FALLBACK_NOW,
      producedAt: FALLBACK_NOW,
      policy: policyFromCacheControl({ revalidate: 2, expire: 60 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      outputs,
      dependencies: [],
      dependencyCoverage: 'complete',
    },
  });
  const outcome = await test.stub.commit(lease.attemptId, request, FALLBACK_NOW);
  const { entryId } = await deriveEntry(test.scopeId, descriptor);
  return { outcome, entryId };
}

describe('actual Cache version-three Pages generation publication', () => {
  it('projects the real paired seed and retains build identity across an object restart', async () => {
    const test = await scope();
    await storeBuild(test);

    await test.stub.seedEntries(
      { scopeId: test.scopeId, batchIndex: 0, entries: [test.seed] },
      FALLBACK_NOW,
    );

    const pack = await published(test);

    expect(pack.header).toMatchObject({
      staticPagePrivacy: 3,
      source: 'build',
      seq: 1,
      route: FALLBACK_ROUTE,
      pathname: test.fixture.page.pathname,
    });
    expect(decodeUtf8(pack.html)).toBe(decodeUtf8(test.fixture.html));
    expect(pack.header.artifacts.find((artifact) => artifact.role === 'pages-data')?.sha256).toBe(
      test.fixture.twin.body?.sha256,
    );

    await evictDurableObject(test.stub);
    const current = decoded(await test.stub.currentRecord(test.entryId, 0));

    expect(current.header.staticPagePrivacy).toBe(3);
    expect(current.html).toStrictEqual(pack.html);
  });

  it('publishes a first lazy member as runtime sequence one, then replaces only that member', async () => {
    const test = await scope();
    await storeBuild(test);

    await test.stub.seedEntries(
      { scopeId: test.scopeId, batchIndex: 0, entries: [test.seed] },
      FALLBACK_NOW,
    );

    const other = await published(test);
    const first = await runtime(test, 'first runtime');

    expect(first.outcome).toMatchObject({ kind: 'published', seq: 1 });

    const initial = await published(test, first.entryId);

    expect(initial.header).toMatchObject({ staticPagePrivacy: 3, source: 'runtime', seq: 1 });

    const next = await runtime(test, 'next runtime');

    expect(next.outcome).toMatchObject({ kind: 'published', seq: 2 });

    const current = await published(test, first.entryId);

    expect(current.header).toMatchObject({ staticPagePrivacy: 3, source: 'runtime', seq: 2 });
    expect(decodeUtf8(current.html)).toBe('<p>next runtime</p>');
    expect(current.header.generationId).not.toBe(initial.header.generationId);
    await expect(published(test)).resolves.toStrictEqual(other);
  });

  it('repairs a failed build location without losing the paired proof or changing its generation', async () => {
    const test = await scope();
    await storeBuild(test);
    const broken: SeedEntryInput = {
      ...test.seed,
      generation: {
        ...test.seed.generation,
        outputs: test.seed.generation.outputs.map((output) => {
          return {
            ...output,
            artifacts: output.artifacts.map((artifact) => {
              return artifact.role === 'html'
                ? { ...artifact, storageRef: 'missing-fallback-html' }
                : artifact;
            }),
          };
        }),
      },
    };

    await test.stub.seedEntries(
      { scopeId: test.scopeId, batchIndex: 0, entries: [broken] },
      FALLBACK_NOW,
    );

    const repaired = await test.stub.seedEntries(
      { scopeId: test.scopeId, batchIndex: 1, entries: [test.seed] },
      FALLBACK_NOW,
    );

    expect(repaired).toMatchObject({ inserted: 0, skipped: 1, refused: [] });

    const pack = await published(test);

    expect(pack.header).toMatchObject({
      staticPagePrivacy: 3,
      generationId: test.seed.generation.generationId,
      seq: 1,
    });
    expect(pack.html).toStrictEqual(test.fixture.html);
  });
});
