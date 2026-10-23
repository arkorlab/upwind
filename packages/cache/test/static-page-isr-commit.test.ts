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
import { commitRequestSchema } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Share only the build fixture, without executing host tests. */
import { ISR_PAGE, isrPageBundle } from '../../host/test/static-page-fixture.ts';
import { generationOutputs, type GenerationRow } from '../src/scope/rows.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const HTML_TYPE = 'text/html; charset=utf-8';
const PRIMARY_PATH = '/news';
const OTHER_PATH = '/other';

async function seededScope() {
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
    NOW,
  );
  const entries = [];
  for (const pathname of [PRIMARY_PATH, OTHER_PATH]) {
    const bytes = encodeUtf8(`<p>build ${pathname}</p>`);
    const page = {
      ...ISR_PAGE,
      id: pathname,
      route: pathname,
      pathname,
      body: {
        sha256: await sha256Hex(bytes),
        byteLength: bytes.byteLength,
        contentType: HTML_TYPE,
      },
    };
    const seeded = await seedRouteFor(isrPageBundle(page), page, { scopeId, generatedAt: NOW });
    const artifact = seeded?.input.generation.outputs[0]?.artifacts[0];
    if (seeded === undefined || artifact === undefined) throw new Error('Missing build fixture');
    await env.ARTIFACTS.put(artifact.storageRef, bytes as BufferSource);
    entries.push(seeded.input);
  }
  await stub.seedEntries({ scopeId, batchIndex: 0, entries }, NOW);
  const primary = entries[0];
  const other = entries[1];
  if (primary === undefined || other === undefined) throw new Error('Missing seeded entries');
  const first = await deriveEntry(scopeId, primary.descriptor);
  const second = await deriveEntry(scopeId, other.descriptor);
  return { scopeId, stub, primary, primaryId: first.entryId, otherId: second.entryId };
}

type Scope = Awaited<ReturnType<typeof seededScope>>;

async function recordFor(scope: Scope, entryId: string) {
  const bytes = await env.CACHE_STATE.get(kvGenerationKey(scope.scopeId, entryId), 'arrayBuffer');
  if (bytes === null) throw new Error('Missing current record');
  const decoded = decodeGenerationPack(new Uint8Array(bytes));
  if (decoded.kind !== 'ok') throw new Error('Invalid current record');
  return decoded.pack;
}

async function lease(scope: Scope) {
  const started = await scope.stub.startAttempt(
    { entry: scope.primary.descriptor, reason: 'miss' },
    NOW,
  );
  if (started.kind !== 'leased') throw new Error('Missing render lease');
  return started;
}

interface RenderOptions {
  readonly marked: boolean;
  readonly private: boolean;
}

async function publish(scope: Scope, options: RenderOptions) {
  const started = await lease(scope);
  const bytes = encodeUtf8('<p>runtime value</p>');
  const sha256 = await sha256Hex(bytes);
  const artifact = {
    role: 'html',
    sha256,
    byteLength: bytes.byteLength,
    contentType: HTML_TYPE,
    encoding: 'identity',
  } as const;
  const storageRef = r2BlobKey(scope.scopeId, sha256);
  await env.ARTIFACTS.put(storageRef, bytes as BufferSource);
  await scope.stub.recordArtifact(
    started.attemptId,
    { ...artifact, storageRef, fencingToken: started.fencingToken },
    NOW,
  );
  const request = commitRequestSchema.parse({
    fencingToken: started.fencingToken,
    observedTagRevision: started.dependencyRevision,
    generation: {
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromCacheControl({ revalidate: 2, expire: 60 }),
      status: 200,
      headers: { 'content-type': HTML_TYPE },
      tags: [],
      outputs: [
        {
          representationKey: 'html',
          pathname: PRIMARY_PATH,
          status: 200,
          headers: options.private ? { 'set-cookie': 'visitor=one' } : {},
          compute: 'static',
          response: 'complete',
          ...(options.marked && { staticPagePrivacy: 2 }),
          htmlSize: bytes.byteLength,
          artifacts: [artifact],
        },
      ],
      dependencies: [],
      dependencyCoverage: 'complete',
    },
  });
  return scope.stub.commit(started.attemptId, request, NOW);
}

async function storedMarker(scope: Scope) {
  return runInDurableObject(scope.stub, (_instance, state) => {
    const current = state.storage.sql
      .exec<GenerationRow>(
        'SELECT g.* FROM generations g JOIN entries e ON e.current_generation_id = g.generation_id WHERE e.entry_id = ?',
        scope.primaryId,
      )
      .one();
    return generationOutputs(current)[0]?.staticPagePrivacy;
  });
}

describe('the actual Cache commit projects only independently proved Pages ISR output', () => {
  it.each([
    { marked: true, private: false, expected: 2 },
    { marked: false, private: false, expected: undefined },
    { marked: true, private: true, expected: undefined },
  ])('publishes only a newly proved runtime marker: %j', async (options) => {
    const scope = await seededScope();
    const original = await recordFor(scope, scope.primaryId);
    const other = await recordFor(scope, scope.otherId);

    expect(original.header.staticPagePrivacy).toBe(2);
    await expect(publish(scope, options)).resolves.toMatchObject({ kind: 'published', seq: 2 });

    const current = await recordFor(scope, scope.primaryId);

    expect({
      stored: await storedMarker(scope),
      projected: current.header.staticPagePrivacy,
      body: decodeUtf8(current.html),
      source: current.header.source,
    }).toStrictEqual({
      stored: options.expected,
      projected: options.expected,
      body: '<p>runtime value</p>',
      source: 'runtime',
    });
    await expect(recordFor(scope, scope.otherId)).resolves.toStrictEqual(other);
  });

  it('keeps the previous current generation when a render fails', async () => {
    const scope = await seededScope();
    const original = await recordFor(scope, scope.primaryId);
    const started = await lease(scope);

    await scope.stub.fail(
      started.attemptId,
      { fencingToken: started.fencingToken, outcome: 'failed' },
      NOW,
    );

    const current = await recordFor(scope, scope.primaryId);

    expect({
      generation: current.header.generationId,
      seq: current.header.seq,
      marker: current.header.staticPagePrivacy,
      body: current.html,
    }).toStrictEqual({
      generation: original.header.generationId,
      seq: original.header.seq,
      marker: 2,
      body: original.html,
    });
  });
});
