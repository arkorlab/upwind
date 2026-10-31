import { attemptGenerationIdFor, policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { commitRequestSchema, type StartAttemptResponse } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

import { limitsOf, parseVars } from '../../src/env.ts';
import { findAttempt } from '../../src/scope/attempts.ts';
import type { CacheScope } from '../../src/scope/cache-scope.ts';
import { prepareCommitRepair } from '../../src/scope/commit-repair.ts';
import { planCommit, type CommitPlan, type Publication } from '../../src/scope/commit.ts';
import { planSetData } from '../../src/scope/data.ts';
import { requireEntry } from '../../src/scope/entries.ts';
import { NO_HISTORY } from '../../src/scope/history.ts';
import { blobStore } from '../../src/scope/io.ts';
import { advanceRepairJob, readRepairJob, type RepairJob } from '../../src/scope/repair-jobs.ts';
import { readRevision } from '../../src/scope/state.ts';
import { scopeStub } from '../../src/scope/stub.ts';
import { tagRefsFor } from '../../src/scope/tags.ts';
import type { TxInput } from '../../src/scope/tx.ts';

export const RESOURCE = 'a'.repeat(64);
export const TAG = 'resource:example';
const ROOT = { kind: 'app-page', route: '/items', pathname: '/items' } as const;
const LIMITS = limitsOf(parseVars({}));

export interface SnapshotScope {
  readonly instance: CacheScope;
  readonly storage: DurableObjectStorage;
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly now: number;
}

export async function withSnapshotScope<T>(work: (scope: SnapshotScope) => Promise<T>): Promise<T> {
  const scopeId = createId('dpl');
  const now = Date.now();
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
    now,
  );
  return runInDurableObject(stub, (instance, state) =>
    work({ instance, storage: state.storage, sql: state.storage.sql, scopeId, now }),
  );
}

export function input(scope: SnapshotScope): TxInput {
  return {
    sql: scope.sql,
    scopeId: scope.scopeId,
    limits: LIMITS,
    now: scope.now + 1,
    revision: readRevision(scope.sql) + 1,
    history: NO_HISTORY,
  };
}

export async function lease(
  scope: SnapshotScope,
): Promise<Extract<StartAttemptResponse, { kind: 'leased' }>> {
  const result = await scope.instance.startAttempt({ entry: ROOT, reason: 'manual' }, scope.now);
  if (result.kind !== 'leased') throw new Error('The publisher must hold a lease.');
  return result;
}

function requestFor(
  scope: SnapshotScope,
  started: Awaited<ReturnType<typeof lease>>,
  tags: readonly string[],
): ReturnType<typeof commitRequestSchema.parse> {
  const revision = readRevision(scope.sql);
  return commitRequestSchema.parse({
    fencingToken: started.fencingToken,
    observedTagRevision: revision,
    heldTagRevisions: { [TAG]: revision },
    generation: {
      cacheTimestamp: scope.now + 1,
      producedAt: scope.now + 1,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: tags.map((value) => ({ kind: 'next-explicit', value })),
      outputs: [
        {
          representationKey: 'html',
          pathname: '/items',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: 0,
          artifacts: [],
        },
      ],
      dependencies: [],
      dependencyCoverage: 'complete',
    },
  });
}

export async function publish(
  scope: SnapshotScope,
  started: Awaited<ReturnType<typeof lease>>,
  tags: readonly string[],
): Promise<ReturnType<Awaited<ReturnType<typeof planCommit>>>> {
  const request = requestFor(scope, started, tags);
  const apply = await planCommit(
    input(scope),
    started.attemptId,
    request,
    blobStore(env.ARTIFACTS, () => ({})),
  );
  return scope.storage.transactionSync(apply);
}

/** An empty shared group isolates the deserialized final publication from physical relocation. */
export async function retainPublication(
  scope: SnapshotScope,
  started: Awaited<ReturnType<typeof lease>>,
  tags: readonly string[],
): Promise<RepairJob> {
  const request = requestFor(scope, started, tags);
  const attempt = findAttempt(scope.sql, started.attemptId);
  if (attempt === undefined) throw new Error('Missing accepted attempt.');
  const plan: CommitPlan = {
    scopeId: scope.scopeId,
    attemptId: started.attemptId,
    request,
    generationId: await attemptGenerationIdFor(scope.scopeId, started.attemptId),
    tagRefs: await tagRefsFor(scope.scopeId, request.generation.tags),
    artifactIds: new Map(),
    dependencyTagIds: new Map(),
    missingUploads: new Set(),
    checkedUploads: new Set(),
  };
  const publication: Publication = {
    attempt,
    entry: requireEntry(scope.sql, started.entryId),
    outputs: [
      {
        outputId: 'accepted-output',
        representationKey: 'html',
        pathname: '/items',
        status: 200,
        headers: {},
        compute: 'static',
        response: 'complete',
        htmlSize: 0,
        artifacts: [],
      },
    ],
    repairs: new Map(),
    condemned: null,
    dependencyRevision: readRevision(scope.sql),
  };
  scope.storage.transactionSync(() => prepareCommitRepair(input(scope), plan, publication));
  const saved = readRepairJob(scope.sql);
  if (saved === undefined) throw new Error('Missing durable publication.');
  const final: RepairJob = { ...saved, phase: 'publish' };
  scope.storage.transactionSync(() => {
    advanceRepairJob(scope.sql, final);
  });
  return final;
}

export function head(scope: SnapshotScope, version: number, tag = TAG): void {
  scope.sql.exec(
    `INSERT INTO resource_heads (resource_id,event_id,version,tag,tag_revision,applied_at)
    VALUES (?, 'event', ?, ?, ?, ?) ON CONFLICT(resource_id) DO UPDATE SET
    version=excluded.version,tag=excluded.tag,tag_revision=excluded.tag_revision`,
    RESOURCE,
    version,
    tag,
    readRevision(scope.sql),
    scope.now,
  );
}

export async function setData(
  scope: SnapshotScope,
  tags: readonly string[],
  value = 'a',
): Promise<ReturnType<Awaited<ReturnType<typeof planSetData>>>> {
  const apply = await planSetData(input(scope), {
    key: 'value',
    entry: {
      kind: 'data:fetch',
      tags: [...tags],
      stale: 60,
      timestamp: scope.now + 100,
      expire: 600,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    value: {
      sha256: value.repeat(64),
      byteLength: 1,
      contentType: 'text/plain',
      storageRef: `body/${value}`,
    },
  });
  return scope.storage.transactionSync(apply);
}
