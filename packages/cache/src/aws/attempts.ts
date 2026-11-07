import { randomUUID } from 'node:crypto';

import {
  artifactIdFor,
  attemptGenerationIdFor,
  deriveEntry,
  generationResponseHeaders,
  isRouteDescriptor,
  type OutputSnapshot,
} from '@stayingupwind/core/cache';
import {
  type ArtifactUpload,
  type AttemptOutcome,
  type AttemptRequest,
  CacheHostError,
  type CommitOutcome,
  type CommitRequest,
  type FailRequest,
  type UploadedArtifact,
} from '@stayingupwind/runtime/cache-host';

import { unixMilliseconds } from '../native/timestamp.ts';
import { runtimeStaticPageOutputsOf } from '../scope/static-page-privacy.ts';
import { ARTIFACT, ATTEMPT, type AwsBase, ENTRY, initialEntry } from './base.ts';
import { entryCapacity } from './capacity.ts';
import type { AttemptState, EntryState, GenerationState } from './model.ts';
import type { ObjectReference } from './objects.ts';
import { checkTags, weighCommit } from './semantics.ts';
import { busy, scopeOf } from './tags.ts';
import { LEASE_MS, MAX_CHANGE_TRIES, SCOPE_KEY, TRANSIENT_RETENTION_MS } from './types.ts';

export class AwsAttempts {
  readonly context: AwsBase;
  constructor(context: AwsBase) {
    this.context = context;
  }

  async startAttempt(request: AttemptRequest): Promise<AttemptOutcome> {
    const id = (await deriveEntry(this.context.options.scopeId, request.entry)).entryId;
    const attemptId = `attempt_${randomUUID()}`;
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const scope = await scopeOf(this.context.store);
      const previous = await this.context.store.read<EntryState>(ENTRY + id);
      const entry = previous?.value ?? initialEntry(id, request.entry);
      const now = await this.context.store.now();
      if (
        (entry.lease !== undefined && entry.lease.expiresAt > now) ||
        (entry.retryAt > now && request.reason !== 'manual')
      ) {
        return {
          kind: 'busy',
          current: await this.context.summary(entry),
          ...(entry.lease === undefined
            ? {}
            : { attemptId: entry.lease.attemptId, leaseExpiresAt: entry.lease.expiresAt }),
        };
      }
      const lease = {
        attemptId,
        fencingToken: entry.fence + 1,
        expiresAt: now + LEASE_MS,
        dependencyRevision: scope.value.revision,
      };
      const attempt: AttemptState = { entryId: id, lease, status: 'leased' };
      const writes = new Map<string, unknown>([
        [ENTRY + id, { ...entry, fence: lease.fencingToken, lease }],
        [ATTEMPT + attemptId, attempt],
      ]);
      if (previous === undefined) writes.set(SCOPE_KEY, entryCapacity(scope.value));
      if (
        await this.context.store.change(
          new Map([
            [SCOPE_KEY, scope.raw],
            [ENTRY + id, previous?.raw ?? null],
            [ATTEMPT + attemptId, null],
          ]),
          writes,
          lease.expiresAt,
          new Map([[ATTEMPT + attemptId, now + TRANSIENT_RETENTION_MS]]),
        )
      )
        return {
          kind: 'leased',
          attemptId,
          entryId: id,
          fencingToken: lease.fencingToken,
          leaseExpiresAt: lease.expiresAt,
          current: await this.context.summary(entry),
        };
      const own = await this.context.store.read<AttemptState>(ATTEMPT + attemptId);
      if (own !== undefined)
        return {
          kind: 'leased',
          attemptId,
          entryId: id,
          fencingToken: own.value.lease.fencingToken,
          leaseExpiresAt: own.value.lease.expiresAt,
          current: await this.context.summary(entry),
        };
    }
    return busy();
  }

  async uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact> {
    const object = await this.context.objects.put(upload.bytes, 'blobs', upload.contentType);
    const artifactId = await artifactIdFor(this.context.options.scopeId, object.sha256);
    await this.context.objects.link(artifactId, object);
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const { attempt, entry } = await this.context.leased(upload.attemptId, upload.fencingToken);
      if (
        await this.context.store.change(
          new Map([
            [ATTEMPT + upload.attemptId, attempt.raw],
            [ENTRY + entry.value.id, entry.raw],
          ]),
          new Map<string, unknown>([
            [ARTIFACT + artifactId, object],
            [`upload:${upload.attemptId}:${object.sha256}`, object],
          ]),
          entry.value.lease?.expiresAt,
          new Map([
            [ARTIFACT + artifactId, Date.now() + TRANSIENT_RETENTION_MS],
            [`upload:${upload.attemptId}:${object.sha256}`, Date.now() + TRANSIENT_RETENTION_MS],
          ]),
        )
      )
        return { sha256: object.sha256, byteLength: object.byteLength };
    }
    return busy();
  }

  async uploadArtifacts(uploads: readonly ArtifactUpload[]): Promise<readonly UploadedArtifact[]> {
    return Promise.all(uploads.map((upload) => this.uploadArtifact(upload)));
  }

  async heartbeat(attemptId: string, fencingToken: number): Promise<void> {
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const { attempt, entry } = await this.context.leased(attemptId, fencingToken);
      const lease = {
        ...attempt.value.lease,
        expiresAt: (await this.context.store.now()) + LEASE_MS,
      };
      if (
        await this.context.store.change(
          new Map([
            [ATTEMPT + attemptId, attempt.raw],
            [ENTRY + entry.value.id, entry.raw],
          ]),
          new Map<string, unknown>([
            [ATTEMPT + attemptId, { ...attempt.value, lease }],
            [ENTRY + entry.value.id, { ...entry.value, lease }],
          ]),
          entry.value.lease?.expiresAt,
          new Map([[ATTEMPT + attemptId, lease.expiresAt + TRANSIENT_RETENTION_MS]]),
        )
      )
        return;
    }
    return busy();
  }

  async commit(attemptId: string, request: CommitRequest): Promise<CommitOutcome> {
    const already = await this.context.store.read<AttemptState>(ATTEMPT + attemptId);
    if (already?.value.status === 'published' && already.value.published !== undefined)
      return { kind: 'published', generationId: already.value.published.id };
    const id = await attemptGenerationIdFor(this.context.options.scopeId, attemptId);
    checkTags(request.generation.tags.map((tag) => tag.value));
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      let leased;
      try {
        leased = await this.context.leased(attemptId, request.fencingToken);
      } catch (error) {
        const result = await this.context.store.read<AttemptState>(ATTEMPT + attemptId);
        if (result?.value.published !== undefined)
          return { kind: 'published', generationId: result.value.published.id };
        if (error instanceof CacheHostError) return { kind: 'refused', reason: 'lease-expired' };
        throw error;
      }
      const { attempt, entry } = leased;
      const tags = await this.context.tags.snapshot(
        request.generation.tags.map((tag) => tag.value),
      );
      const weighed = weighCommit(
        request.generation.tags.map((tag) => tag.value),
        tags.tags,
        attempt.value.lease.dependencyRevision,
        request.observedTagRevision,
        request.heldTagRevisions,
      );
      if (weighed.refused) return { kind: 'refused', reason: 'stale-dependencies' };
      const listed = request.generation.outputs.flatMap((output) => output.artifacts);
      const uploaded = await this.context.store.readMany(
        listed.map((artifact) => `upload:${attemptId}:${artifact.sha256}`),
      );
      const outputs: OutputSnapshot[] = [];
      for (const output of request.generation.outputs) {
        const artifacts = [];
        for (const artifact of output.artifacts) {
          const object = uploaded.get(`upload:${attemptId}:${artifact.sha256}`)?.value as
            | ObjectReference
            | undefined;
          if (object === undefined || object.byteLength !== artifact.byteLength)
            return { kind: 'refused', reason: 'missing-artifact' };
          artifacts.push({
            ...artifact,
            artifactId: await artifactIdFor(this.context.options.scopeId, artifact.sha256),
            storageRef: object.key,
            encoding: 'identity' as const,
          });
        }
        outputs.push({ ...output, outputId: `out_${randomUUID()}`, artifacts });
      }
      const source = request.generation;
      const generation: GenerationState = {
        id,
        seq: entry.value.seq + 1,
        source: 'runtime',
        cacheTimestamp: unixMilliseconds(source.cacheTimestamp),
        producedAt: unixMilliseconds(source.producedAt),
        policy: source.policy,
        status: source.status,
        headers: isRouteDescriptor(entry.value.descriptor)
          ? generationResponseHeaders(
              entry.value.descriptor.kind,
              source.status,
              Object.entries(source.headers),
            )
          : { ...source.headers },
        tags: [...source.tags],
        outputs,
        ...(weighed.condemned === undefined ? {} : { condemned: weighed.condemned }),
      };
      const admitted = runtimeStaticPageOutputsOf({
        scopeId: this.context.options.scopeId,
        buildId: this.context.options.buildId,
        entry: {
          entryId: entry.value.id,
          kind: entry.value.descriptor.kind,
          route: isRouteDescriptor(entry.value.descriptor) ? entry.value.descriptor.route : null,
          pathname: isRouteDescriptor(entry.value.descriptor)
            ? entry.value.descriptor.pathname
            : null,
        },
        generation: { generationId: id, ...generation },
        outputs,
      });
      const prepared = await this.context.prepared(
        entry.value,
        { ...generation, outputs: admitted },
        tags.scope.value.revision + 1,
        weighed.dependencyRevision,
      );
      prepared.writes.set(SCOPE_KEY, {
        ...entryCapacity(tags.scope.value, entry.value, prepared.ref),
        revision: tags.scope.value.revision + 1,
      });
      prepared.writes.set(ENTRY + entry.value.id, {
        ...entry.value,
        seq: generation.seq,
        current: prepared.ref,
        lease: undefined,
        failures: 0,
        retryAt: 0,
      });
      prepared.writes.set(ATTEMPT + attemptId, {
        ...attempt.value,
        status: 'published',
        published: prepared.ref,
      });
      if (
        await this.context.store.change(
          new Map([
            [SCOPE_KEY, tags.scope.raw],
            [ENTRY + entry.value.id, entry.raw],
            [ATTEMPT + attemptId, attempt.raw],
          ]),
          prepared.writes,
          entry.value.lease?.expiresAt,
          new Map([[ATTEMPT + attemptId, Date.now() + TRANSIENT_RETENTION_MS]]),
        )
      )
        return {
          kind: 'published',
          generationId: id,
          ...(prepared.record === undefined ? {} : { record: prepared.record }),
        };
      const result = await this.context.store.read<AttemptState>(ATTEMPT + attemptId);
      if (result?.value.published !== undefined)
        return { kind: 'published', generationId: result.value.published.id };
    }
    return busy();
  }

  async fail(attemptId: string, request: FailRequest): Promise<void> {
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const prior = await this.context.store.read<AttemptState>(ATTEMPT + attemptId);
      if (prior?.value.status === 'failed') return;
      const { scope, attempt, entry } = await this.context.leased(attemptId, request.fencingToken);
      const failures = request.outcome === 'failed' ? entry.value.failures + 1 : 0;
      const retryAt =
        failures === 0
          ? 0
          : Date.now() + (request.retryAfterMs ?? Math.min(300_000, 1000 * 2 ** failures));
      if (
        await this.context.store.change(
          new Map([
            [SCOPE_KEY, scope.raw],
            [ATTEMPT + attemptId, attempt.raw],
            [ENTRY + entry.value.id, entry.raw],
          ]),
          new Map<string, unknown>([
            [ATTEMPT + attemptId, { ...attempt.value, status: 'failed' }],
            [ENTRY + entry.value.id, { ...entry.value, lease: undefined, failures, retryAt }],
          ]),
          undefined,
          new Map([[ATTEMPT + attemptId, Date.now() + TRANSIENT_RETENTION_MS]]),
        )
      )
        return;
    }
    return busy();
  }
}
