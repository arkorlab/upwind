import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  buildGenerationIdFor,
  decodeGenerationPack,
  deriveEntry,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { toBase64 } from '@stayingupwind/core/util';
import {
  type CacheHost,
  type CommitRequest,
  type AttemptOutcome,
} from '@stayingupwind/runtime/cache-host';
import { afterEach, describe, expect, it } from 'vitest';

import { createNativeCache, type NativeCache } from '../../src/native/index.ts';

const caches: NativeCache[] = [];
const directories: string[] = [];

function leaseOf(attempt: AttemptOutcome | undefined) {
  if (attempt?.kind !== 'leased') throw new Error('missing lease');
  return attempt;
}

function packOf(bytes: Uint8Array) {
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('invalid generation pack');
  return decoded.pack;
}

async function truncateArtifact(directory: string, body: string): Promise<string> {
  const objects = path.join(directory, 'objects');
  // These paths refer only to this test's private temporary cache objects.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const names = await readdir(objects);
  for (const name of names) {
    const file = path.join(objects, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if ((await readFile(file, 'utf8')) !== body) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await truncate(file, 1);
    return file;
  }
  throw new Error('missing artifact fixture');
}

async function openCache(
  directory?: string,
  seed?: Parameters<typeof createNativeCache>[0]['seed'],
) {
  const location = directory ?? (await mkdtemp(path.join(os.tmpdir(), 'upwind-native-cache-')));
  if (directory === undefined) directories.push(location);
  const cache = await createNativeCache({
    directory: location,
    scopeId: 'native-test',
    buildId: 'build-test',
    seed,
  });
  caches.push(cache);
  return { cache, directory: location, host: cache.binding.host };
}

function value(text: string) {
  return {
    key: 'value',
    entry: {
      kind: 'data:fetch' as const,
      tags: ['value'],
      stale: 0,
      timestamp: Date.now(),
      expire: 600,
      revalidate: 60,
    },
    valueBase64: toBase64(new TextEncoder().encode(text)),
  };
}

async function generation(
  host: CacheHost,
  attemptId: string,
  fencingToken: number,
): Promise<CommitRequest> {
  const html = await host.uploadArtifact({
    attemptId,
    fencingToken,
    role: 'html',
    bytes: new TextEncoder().encode('<p>complete</p>'),
    contentType: 'text/html',
  });
  const rsc = await host.uploadArtifact({
    attemptId,
    fencingToken,
    role: 'rsc',
    bytes: new TextEncoder().encode('RSC output'),
    contentType: 'text/x-component',
  });
  return {
    fencingToken,
    observedTagRevision: 0,
    heldTagRevisions: {},
    generation: {
      cacheTimestamp: Date.now() + 0.75,
      producedAt: Date.now() + 0.25,
      reason: 'miss',
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [{ kind: 'next-explicit', value: 'page' }],
      outputs: [
        {
          representationKey: 'html',
          pathname: '/page',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: 15,
          artifacts: [{ ...html, role: 'html', contentType: 'text/html' }],
        },
        {
          representationKey: 'rsc',
          pathname: '/page',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: null,
          artifacts: [{ ...rsc, role: 'rsc', contentType: 'text/x-component' }],
        },
      ],
    },
  };
}

describe('native cache', () => {
  afterEach(async () => {
    await Promise.all(caches.splice(0).map((cache) => cache.close()));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('data and invalidation revisions survive restarting the owner', async () => {
    const first = await openCache();
    await first.host.setData(value('persisted'));
    const invalidation = await first.host.invalidate({ tags: ['value'], api: 'updateTag' });
    await first.cache.close();
    const next = await openCache(first.directory);

    await expect(next.host.getData({ key: 'value', kind: 'data:fetch' })).resolves.toMatchObject({
      value: { kind: 'inline', base64: toBase64(new TextEncoder().encode('persisted')) },
      invalidation: { revision: invalidation.revision },
    });
    await expect(next.host.tagsDelta(0)).resolves.toMatchObject({
      tags: [expect.objectContaining({ value: 'value' })],
    });
  });

  it('normalizes fractional producer timestamps before persistence and preserves invalidation after restart', async () => {
    const first = await openCache();
    const original = value('fractional');
    const timestamp = original.entry.timestamp + 0.875;
    await first.host.setData({
      ...original,
      entry: { ...original.entry, timestamp },
    });
    await first.cache.close();
    const next = await openCache(first.directory);
    const stored = await next.host.getData({ key: 'value', kind: 'data:fetch' });

    expect(stored?.entry.timestamp).toBe(Math.floor(timestamp));
    expect(stored?.value).toMatchObject({ base64: original.valueBase64 });

    const invalidation = await next.host.invalidate({ tags: ['value'], api: 'updateTag' });
    await next.cache.close();
    const reopened = await openCache(first.directory);

    await expect(
      reopened.host.getData({ key: 'value', kind: 'data:fetch' }),
    ).resolves.toMatchObject({
      entry: { timestamp: Math.floor(timestamp) },
      invalidation: { revision: invalidation.revision },
    });
  });

  it('an older write from one writer cannot replace its later value', async () => {
    const { host } = await openCache();
    await host.setData({ ...value('later'), order: { writer: 'writer', seq: 2 } });

    await expect(
      host.setData({ ...value('older'), order: { writer: 'writer', seq: 1 } }),
    ).resolves.toMatchObject({ superseded: true });
    await expect(host.getData({ key: 'value', kind: 'data:fetch' })).resolves.toMatchObject({
      value: { base64: toBase64(new TextEncoder().encode('later')) },
    });
  });

  it('a second process owner is refused, and a clean close releases the database', async () => {
    const first = await openCache();

    await expect(openCache(first.directory)).rejects.toThrow(/locked/u);

    await first.cache.close();

    await expect(openCache(first.directory)).resolves.toHaveProperty('host');
  });

  const route = {
    entry: { kind: 'app-page' as const, route: '/page', pathname: '/page' },
    reason: 'miss' as const,
  };

  it('competing regeneration gets one lease and all outputs publish together', async () => {
    const { host } = await openCache();
    const attempts = await Promise.all([host.startAttempt(route), host.startAttempt(route)]);
    const leased = attempts.find((attempt) => attempt.kind === 'leased');

    expect(attempts.filter((attempt) => attempt.kind === 'leased')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.kind === 'busy')).toHaveLength(1);

    const winner = leaseOf(leased);
    const request = await generation(host, winner.attemptId, winner.fencingToken);

    await expect(host.readRecord(winner.entryId)).resolves.toBeUndefined();

    const committed = await host.commit(winner.attemptId, request);

    expect(committed.kind).toBe('published');

    const record = await host.readRecord(winner.entryId);

    expect(record).toBeDefined();

    const decoded = packOf(record ?? new Uint8Array());

    expect(decoded.header.artifacts).toHaveLength(2);
    expect(decoded.header).toMatchObject({
      cacheTimestamp: Math.floor(request.generation.cacheTimestamp),
      producedAt: Math.floor(request.generation.producedAt),
    });

    const rsc = decoded.header.artifacts.find((artifact) => artifact.role === 'rsc');

    expect(new TextDecoder().decode(await host.readArtifact(rsc?.artifactId ?? ''))).toBe(
      'RSC output',
    );
  });

  it('a render cannot publish with a lost fencing token or a pre-invalidation tag view', async () => {
    const { host } = await openCache();
    const leased = await host.startAttempt(route);
    const winner = leaseOf(leased);
    const request = await generation(host, winner.attemptId, winner.fencingToken);

    await expect(
      host.commit(winner.attemptId, { ...request, fencingToken: winner.fencingToken + 1 }),
    ).resolves.toMatchObject({ kind: 'refused' });

    await host.invalidate({ tags: ['page'], api: 'updateTag' });
    const result = await host.commit(winner.attemptId, request);

    expect(result.kind).toBe('refused');
    await expect(host.readRecord(winner.entryId)).resolves.toBeUndefined();
  });

  it('a truncated artifact becomes a cache miss and regeneration repairs it after restart', async () => {
    const first = await openCache();
    const original = leaseOf(await first.host.startAttempt(route));
    const request = await generation(first.host, original.attemptId, original.fencingToken);
    const committed = await first.host.commit(original.attemptId, request);

    expect(committed.kind).toBe('published');

    const record = packOf((await first.host.readRecord(original.entryId)) ?? new Uint8Array());
    const artifactId = record.header.artifacts.find(
      (artifact) => artifact.role === 'rsc',
    )?.artifactId;

    expect(artifactId).toBeDefined();

    const damagedFile = await truncateArtifact(first.directory, 'RSC output');

    await expect(first.host.readArtifact(artifactId ?? '')).resolves.toBeUndefined();
    await expect(first.host.readArtifact(artifactId ?? '')).resolves.toBeUndefined();

    await first.cache.close();

    const reopened = await openCache(first.directory);
    const repair = leaseOf(await reopened.host.startAttempt({ ...route, reason: 'manual' }));
    const replacement = await generation(reopened.host, repair.attemptId, repair.fencingToken);

    // The persisted failure must reserve a new location instead of overwriting the known bad one.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await expect(readFile(damagedFile, 'utf8')).resolves.toBe('R');
    await expect(reopened.host.commit(repair.attemptId, replacement)).resolves.toMatchObject({
      kind: 'published',
    });
    expect(new TextDecoder().decode(await reopened.host.readArtifact(artifactId ?? ''))).toBe(
      'RSC output',
    );
  });

  it('restarting with build seeds preserves invalidations already applied to the build generation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-native-seed-'));
    directories.push(directory);
    const blobsDirectory = path.join(directory, 'build-blobs');
    // This is a private temporary fixture directory, never a request-controlled path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(blobsDirectory);
    const bytes = new TextEncoder().encode('<p>build</p>');
    const sha256 = await sha256Hex(bytes);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(path.join(blobsDirectory, sha256), bytes);
    const descriptor = { kind: 'app-page' as const, route: '/seed', pathname: '/seed' };
    const { entryId } = await deriveEntry('native-test', descriptor);
    const seed = {
      blobsDirectory,
      entries: [
        {
          descriptor,
          groupInstanceId: null,
          generation: {
            generationId: await buildGenerationIdFor('native-test', entryId),
            cacheTimestamp: Date.now(),
            producedAt: Date.now(),
            policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
            status: 200,
            headers: {},
            tags: [{ kind: 'next-explicit' as const, value: 'seed' }],
            dependencyCoverage: 'complete' as const,
            outputs: [
              {
                representationKey: 'html',
                pathname: '/seed',
                status: 200,
                headers: {},
                compute: 'static' as const,
                response: 'complete' as const,
                htmlSize: bytes.byteLength,
                artifacts: [
                  {
                    role: 'html' as const,
                    sha256,
                    byteLength: bytes.byteLength,
                    contentType: 'text/html',
                    encoding: 'identity' as const,
                    storageRef: `build/${sha256}`,
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const first = await openCache(directory, seed);

    expect(packOf((await first.host.readRecord(entryId)) ?? new Uint8Array()).header.source).toBe(
      'build',
    );

    const invalidation = await first.host.invalidate({ tags: ['seed'], api: 'updateTag' });
    await first.cache.close();
    const next = await openCache(directory, seed);
    const record = packOf((await next.host.readRecord(entryId)) ?? new Uint8Array());

    expect(record.header.invalidation?.revision).toBe(invalidation.revision);
    expect(record.header.seq).toBe(1);
  });
});
