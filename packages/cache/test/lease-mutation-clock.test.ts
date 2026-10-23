import { sha256Hex } from '@stayingupwind/core/artifact';
import { policyFromBuild, r2BlobKey, type RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { createId, encodeUtf8 } from '@stayingupwind/core/util';
import type { CommitRequest } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CacheBindings } from '../src/bindings.ts';
import { limitsOf, parseVars } from '../src/env.ts';
import { applyHeartbeat } from '../src/scope/attempts.ts';
import { planCommit } from '../src/scope/commit.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { blobStore } from '../src/scope/io.ts';
import { commitMutation, type ScopeMutationHost } from '../src/scope/mutations.ts';
import { readRevision, refuse } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const LIMITS = limitsOf(parseVars({}));
const ROOT: RouteEntryDescriptor = { kind: 'app-page', route: '/', pathname: '/' };

function noFaults() {
  return {};
}

async function fixture() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
  const lease = await stub.startAttempt({ entry: ROOT, reason: 'miss' }, NOW);
  if (lease.kind !== 'leased') throw new Error('the entry must have a lease');
  return { clock, scopeId, stub, lease };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function mutationHost(storage: DurableObjectStorage, scopeId: string): ScopeMutationHost {
  return {
    storage,
    scopeId,
    kv: env.CACHE_STATE,
    limits: LIMITS,
    history: NO_HISTORY,
    tables: true,
    createdTables: () => {
      throw new Error('the seeded scope already has its tables');
    },
  };
}

async function stateOf(subject: Fixture) {
  return runInDurableObject(subject.stub, (_instance, state) => {
    const { sql } = state.storage;
    return {
      attempt: sql
        .exec<{ status: string; lease_expires_at: number }>(
          'SELECT status, lease_expires_at FROM attempts WHERE attempt_id = ?',
          subject.lease.attemptId,
        )
        .one(),
      uploads: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM attempt_artifacts').one().n,
      generations: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM generations').one().n,
    };
  });
}

async function upload(subject: Fixture): Promise<CommitRequest> {
  const bytes = encodeUtf8('<html>clock</html>');
  const sha256 = await sha256Hex(bytes);
  const storageRef = r2BlobKey(subject.scopeId, sha256);
  const artifact = {
    role: 'html' as const,
    sha256,
    byteLength: bytes.byteLength,
    contentType: 'text/html',
    encoding: 'identity' as const,
  };
  const recorded = await subject.stub.recordArtifact(
    subject.lease.attemptId,
    { ...artifact, storageRef, fencingToken: subject.lease.fencingToken },
    NOW,
  );
  if ('kind' in recorded) throw new Error('the live lease must record its upload');
  await env.ARTIFACTS.put(storageRef, bytes as BufferSource);
  return {
    fencingToken: subject.lease.fencingToken,
    observedTagRevision: subject.lease.dependencyRevision,
    generation: {
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      dependencyCoverage: 'complete',
      dependencies: [],
      outputs: [
        {
          representationKey: 'html',
          pathname: '/',
          status: 200,
          headers: { 'content-type': 'text/html' },
          compute: 'static',
          response: 'complete',
          htmlSize: bytes.byteLength,
          artifacts: [artifact],
        },
      ],
    },
  };
}

async function delayedCommit(subject: Fixture, request: CommitRequest) {
  return runInDurableObject(subject.stub, async (_instance, state) => {
    const planned = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const pending = commitMutation(
      { ...mutationHost(state.storage, subject.scopeId), clock: Date.now },
      NOW,
      async (input) => {
        let apply: Awaited<ReturnType<typeof planCommit>>;
        try {
          apply = await planCommit(
            input,
            subject.lease.attemptId,
            request,
            blobStore(env.ARTIFACTS, noFaults),
          );
        } finally {
          planned.resolve(undefined);
        }
        await release.promise;
        return apply;
      },
      { empty: refuse('not_found', 'the scope is absent') },
    );
    try {
      await planned.promise;
      subject.clock.mockReturnValue(subject.lease.leaseExpiresAt);
    } finally {
      release.resolve(undefined);
    }
    return (await pending).value;
  });
}

/** Pause the actual authority commit inside its upload HEAD, after it captures its input. */
async function pausedAuthorityCommit(
  subject: Fixture,
  request: CommitRequest,
  whilePlanning: (storage: DurableObjectStorage) => void,
) {
  return runInDurableObject(subject.stub, async (instance, state) => {
    const bindings = Reflect.get(instance, 'env') as CacheBindings;
    const originalHead = bindings.ARTIFACTS.head.bind(bindings.ARTIFACTS);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const head = vi.spyOn(bindings.ARTIFACTS, 'head').mockImplementationOnce(async (key) => {
      entered.resolve(undefined);
      await release.promise;
      return originalHead(key);
    });
    const pending = Promise.resolve(instance.commit(subject.lease.attemptId, request, NOW));
    try {
      await entered.promise;
      whilePlanning(state.storage);
      release.resolve(undefined);
      return await pending;
    } finally {
      release.resolve(undefined);
      head.mockRestore();
    }
  });
}

async function fixedHeartbeat(subject: Fixture) {
  return runInDurableObject(subject.stub, async (_instance, state) => {
    const result = await commitMutation(
      mutationHost(state.storage, subject.scopeId),
      NOW,
      (input) => () => applyHeartbeat(input, subject.lease.attemptId, subject.lease.fencingToken),
      { empty: refuse('not_found', 'the scope is absent') },
    );
    return result.value;
  });
}

describe('the clock at the lease mutation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not renew an expired lease using the old request timestamp', async () => {
    const subject = await fixture();
    subject.clock.mockReturnValue(subject.lease.leaseExpiresAt);
    const answer = await subject.stub.heartbeat(
      subject.lease.attemptId,
      subject.lease.fencingToken,
      NOW,
    );

    const state = await stateOf(subject);

    expect(parseVars(env).ARKOR_TEST_HOOKS).toBe(false);
    expect(answer).toMatchObject({ kind: 'refused', code: 'lease_expired' });
    expect(state).toMatchObject({ attempt: { status: 'expired' } });
  });

  it('does not reserve an upload after its lease expired during the request', async () => {
    const subject = await fixture();
    subject.clock.mockReturnValue(subject.lease.leaseExpiresAt);
    const answer = await subject.stub.recordArtifact(
      subject.lease.attemptId,
      {
        fencingToken: subject.lease.fencingToken,
        sha256: 'a'.repeat(64),
        byteLength: 1,
        contentType: 'text/html',
        encoding: 'identity',
        role: 'html',
        storageRef: 'not-uploaded',
      },
      NOW,
    );

    const state = await stateOf(subject);

    expect(answer).toMatchObject({ kind: 'refused', code: 'lease_expired' });
    expect(state).toMatchObject({ uploads: 0, attempt: { status: 'expired' } });
  });

  it('rechecks time after real commit planning and lets the next renderer take over', async () => {
    const subject = await fixture();
    const request = await upload(subject);
    const answer = await delayedCommit(subject, request);

    const state = await stateOf(subject);

    expect(answer).toMatchObject({ kind: 'lease-expired' });
    expect(state).toMatchObject({ generations: 0, attempt: { status: 'expired' } });

    const next = await subject.stub.startAttempt({ entry: ROOT, reason: 'miss' }, NOW);

    expect(next).toMatchObject({ kind: 'leased', fencingToken: subject.lease.fencingToken + 1 });
  });

  it('refuses the authority commit when its upload check outlives the lease', async () => {
    const subject = await fixture();
    const request = await upload(subject);
    const answer = await pausedAuthorityCommit(subject, request, () => {
      subject.clock.mockReturnValue(subject.lease.leaseExpiresAt);
    });
    const state = await stateOf(subject);

    expect(answer).toMatchObject({ kind: 'lease-expired' });
    expect(state).toMatchObject({ generations: 0, attempt: { status: 'expired' } });
  });

  it('publishes after a newer scope revision acknowledged during the upload check', async () => {
    const subject = await fixture();
    const request = await upload(subject);
    let acknowledged = 0;
    const answer = await pausedAuthorityCommit(subject, request, (storage) => {
      acknowledged = readRevision(storage.sql) + 1;
      storage.sql.exec('UPDATE scope SET revision = ?', acknowledged);
    });
    const state = await stateOf(subject);
    const revision = await runInDurableObject(subject.stub, (_instance, state) => {
      return readRevision(state.storage.sql);
    });

    expect(answer).toMatchObject({ kind: 'published', revision: acknowledged + 1 });
    expect(state).toMatchObject({ generations: 1, attempt: { status: 'committed' } });
    expect(revision).toBeGreaterThan(acknowledged);
  });

  it('retains the explicit fixed-clock mutation mode when no live clock is supplied', async () => {
    const subject = await fixture();
    subject.clock.mockReturnValue(subject.lease.leaseExpiresAt);
    const answer = await fixedHeartbeat(subject);

    const state = await stateOf(subject);

    expect(answer).toStrictEqual({ leaseExpiresAt: NOW + LIMITS.leaseMs });
    expect(state).toMatchObject({ attempt: { status: 'leased' } });
  });
});
