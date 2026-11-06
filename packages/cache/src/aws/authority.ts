import { randomUUID } from 'node:crypto';

import {
  artifactIdFor,
  attemptGenerationIdFor,
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  finiteSeconds,
  generationResponseHeaders,
  isRouteDescriptor,
  MAX_TAGS_PER_CALL,
  type OutputSnapshot,
  tagKindOf,
} from '@stayingupwind/core/cache';
import type { ScopeRevision } from '@stayingupwind/core/paas';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import {
  type ArtifactUpload,
  type AttemptOutcome,
  type AttemptRequest,
  type CacheHost,
  CacheHostError,
  type CommitOutcome,
  type CommitRequest,
  type CurrentSummary,
  type DataRead,
  type DataReadRequest,
  type DataWriteRequest,
  type DataWritten,
  type FailRequest,
  type InvalidateOutcome,
  type InvalidateRequest,
  type TagDelta,
  type TagInvalidations,
  type UploadedArtifact,
} from '@stayingupwind/runtime/cache-host';

import { readSeedArtifact } from '../native/seed-artifact.ts';
import { unixMilliseconds } from '../native/timestamp.ts';
import { inForceMoment } from '../scope/invalidations.ts';
import { runtimeStaticPageOutputsOf } from '../scope/static-page-privacy.ts';
import type {
  AttemptState,
  EntryState,
  GenerationReference,
  GenerationState,
  InvalidationEvent,
  ScopeState,
  TagState,
} from './model.ts';
import { type ObjectReference, type ObjectStore } from './objects.ts';
import { checkTags, condemnation, deliveryRecord, mergedTag, weighCommit } from './semantics.ts';
import { AwsTags, busy, scopeOf, tagKey, tagRevisionKey } from './tags.ts';
import {
  type AuthorityStore,
  type AwsCacheOptions,
  LEASE_MS,
  MAX_ARTIFACT_BYTES,
  MAX_CHANGE_TRIES,
  MAX_PENDING_EVENTS,
  revisionKey,
  SCOPE_KEY,
  type Stored,
  TRANSIENT_RETENTION_MS,
} from './types.ts';

const ENTRY = 'entry:';
const ATTEMPT = 'attempt:';
const ARTIFACT = 'artifact:';
const META = 'generation:';
const RECORD = 'record:';
const WRITER = 'writer:';
const JSON_TYPE = 'application/json';

function unavailable(message: string): never {
  throw new CacheHostError(message, { code: 'unavailable', status: 503 });
}

function initialEntry(id: string, descriptor: EntryState['descriptor']): EntryState {
  return { id, descriptor, fence: 0, seq: 0, failures: 0, retryAt: 0 };
}

function sameLease(entry: EntryState, attempt: AttemptState, token: number, now: number): boolean {
  return (
    attempt.status === 'leased' &&
    attempt.lease.fencingToken === token &&
    entry.lease?.attemptId === attempt.lease.attemptId &&
    entry.fence === token &&
    entry.lease.expiresAt > now
  );
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Both providers publish the same immutable generations and implement the same runtime contract. */
export class AwsAuthority implements CacheHost {
  readonly #options: AwsCacheOptions;
  readonly #store: AuthorityStore;
  readonly #objects: ObjectStore;
  readonly #tags: AwsTags;
  readonly #metadata = new Map<string, GenerationState>();
  readonly #background = new Set<Promise<unknown>>();
  #maintenance: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: AwsCacheOptions, store: AuthorityStore, objects: ObjectStore) {
    this.#options = options;
    this.#store = store;
    this.#objects = objects;
    this.#tags = new AwsTags(store);
  }

  #hold(work: Promise<unknown>): void {
    const held = work.catch((error: unknown) => {
      console.error(
        'upwind: AWS cache maintenance failed',
        error instanceof Error ? error.message : String(error),
      );
    });
    this.#background.add(held);
    this.#options.waitUntil?.(held);
    void held.finally(() => this.#background.delete(held));
  }

  async initialize(): Promise<void> {
    const initial: ScopeState = {
      format: 1,
      buildId: this.#options.buildId,
      deploymentId: this.#options.deploymentId,
      revision: 0,
      invalidationRevision: 0,
      invalidatedAt: null,
      checkpoint: 0,
      pending: 0,
      status: 'seeding',
    };
    await this.#store.change(new Map([[SCOPE_KEY, null]]), new Map([[SCOPE_KEY, initial]]));
    const found = await scopeOf(this.#store);
    if (
      found.value.buildId !== initial.buildId ||
      found.value.deploymentId !== initial.deploymentId
    )
      throw new Error('AWS cache scope belongs to another immutable build');
    if (found.value.status === 'seeding') {
      for (const entry of this.#options.seed?.entries ?? []) await this.#seedEntry(entry);
      for (let tries = 0; ; tries += 1) {
        if (tries >= MAX_CHANGE_TRIES) return busy();
        const scope = await scopeOf(this.#store);
        if (scope.value.status === 'active') break;
        if (
          await this.#store.change(
            new Map([[SCOPE_KEY, scope.raw]]),
            new Map([
              [
                SCOPE_KEY,
                {
                  ...scope.value,
                  status: 'active',
                  revision: scope.value.revision + 1,
                },
              ],
            ]),
          )
        )
          break;
      }
    }
    this.#maintenance = setInterval(() => {
      if (this.#closed) return;
      if (this.#store.kind === 'dynamodb') this.#hold(this.#tags.project());
      this.#hold(this.#store.sweepExpired());
    }, 1000);
    this.#maintenance.unref();
    if (this.#store.kind === 'dynamodb') this.#hold(this.#tags.project());
  }

  async #readGeneration(ref: GenerationReference): Promise<GenerationState> {
    const cached = this.#metadata.get(ref.metadata.key);
    if (cached !== undefined) return cached;
    const local =
      this.#store.kind === 'valkey'
        ? await this.#store.read<GenerationState>(META + ref.id)
        : undefined;
    const generation =
      local?.value ??
      (JSON.parse(
        new TextDecoder().decode(await this.#objects.read(ref.metadata)),
      ) as GenerationState);
    if (generation.id !== ref.id || generation.seq !== ref.seq)
      throw new Error('AWS cache generation identity differs');
    this.#metadata.set(ref.metadata.key, generation);
    if (this.#metadata.size > 32) {
      const first = this.#metadata.keys().next().value;
      if (first !== undefined) this.#metadata.delete(first);
    }
    return generation;
  }

  async #summary(entry: EntryState): Promise<CurrentSummary | null> {
    const ref = entry.current;
    if (ref === undefined) return null;
    const generation = await this.#readGeneration(ref);
    const tags = await this.#tags.snapshot(generation.tags.map((tag) => tag.value));
    return {
      generationId: ref.id,
      seq: ref.seq,
      cacheTimestamp: generation.cacheTimestamp,
      policy: generation.policy,
      status: generation.status,
      location: generation.headers['location'] ?? null,
      condemned: condemnation(generation, ref.dependencyRevision, tags.tags, ref.revision) ?? null,
    };
  }

  async #prepared(
    entry: EntryState,
    generation: GenerationState,
    revision: number,
    dependencyRevision: number,
  ): Promise<{
    readonly ref: GenerationReference;
    readonly writes: Map<string, unknown | null>;
    readonly record?: Uint8Array | undefined;
  }> {
    const metadata = await this.#objects.put(jsonBytes(generation), 'metadata', JSON_TYPE);
    const record =
      generation.data === undefined
        ? await deliveryRecord(
            this.#options.scopeId,
            this.#options.buildId,
            entry.id,
            entry.descriptor,
            generation,
            revision,
            this.#objects,
          )
        : undefined;
    const recordRef = record === undefined ? undefined : await this.#objects.put(record, 'records');
    const ref: GenerationReference = {
      id: generation.id,
      seq: generation.seq,
      revision,
      dependencyRevision,
      metadata,
      ...(recordRef === undefined ? {} : { record: recordRef }),
    };
    const writes = new Map<string, unknown | null>();
    if (this.#store.kind === 'valkey') {
      writes.set(META + generation.id, generation);
      if (record !== undefined)
        writes.set(RECORD + generation.id, Buffer.from(record).toString('base64'));
      if (entry.current !== undefined && entry.current.id !== generation.id) {
        writes.set(META + entry.current.id, null);
        writes.set(RECORD + entry.current.id, null);
      }
    }
    return { ref, writes, ...(record === undefined ? {} : { record }) };
  }

  async #seedEntry(seed: SeedEntryInput): Promise<void> {
    const id = (await deriveEntry(this.#options.scopeId, seed.descriptor, seed.allowQuery)).entryId;
    if ((await this.#store.read(ENTRY + id)) !== undefined) return;
    const directory = this.#options.seed?.blobsDirectory;
    if (directory === undefined) throw new Error('AWS cache seed has no blob directory');
    checkTags(seed.generation.tags.map((tag) => tag.value));
    const outputs: OutputSnapshot[] = [];
    for (const output of seed.generation.outputs) {
      const artifacts = [];
      for (const artifact of output.artifacts) {
        if (artifact.encoding !== 'identity')
          throw new Error('AWS native cache requires identity seed artifacts');
        const bytes = await readSeedArtifact(directory, artifact, MAX_ARTIFACT_BYTES);
        const object = await this.#objects.put(bytes, 'blobs', artifact.contentType);
        const artifactId = await artifactIdFor(this.#options.scopeId, artifact.sha256);
        await this.#objects.link(artifactId, object);
        await this.#store.change(
          new Map(),
          new Map([[ARTIFACT + artifactId, object]]),
          undefined,
          new Map([[ARTIFACT + artifactId, Date.now() + TRANSIENT_RETENTION_MS]]),
        );
        artifacts.push({ ...artifact, artifactId, storageRef: object.key });
      }
      outputs.push({ ...output, outputId: `out_${randomUUID()}`, artifacts });
    }
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const scope = await scopeOf(this.#store);
      const previous = await this.#store.read<EntryState>(ENTRY + id);
      if (previous !== undefined) return;
      const entry = initialEntry(id, seed.descriptor);
      const generation: GenerationState = {
        ...seed.generation,
        id: seed.generation.generationId,
        source: 'build',
        seq: 1,
        tags: seed.generation.tags.map((tag) => ({ ...tag })),
        outputs,
      };
      const prepared = await this.#prepared(entry, generation, scope.value.revision + 1, 0);
      prepared.writes.set(ENTRY + id, { ...entry, seq: 1, current: prepared.ref });
      prepared.writes.set(SCOPE_KEY, { ...scope.value, revision: scope.value.revision + 1 });
      if (
        await this.#store.change(
          new Map([
            [SCOPE_KEY, scope.raw],
            [ENTRY + id, null],
          ]),
          prepared.writes,
        )
      )
        return;
    }
    return busy();
  }

  async startAttempt(request: AttemptRequest): Promise<AttemptOutcome> {
    const id = (await deriveEntry(this.#options.scopeId, request.entry)).entryId;
    const attemptId = `attempt_${randomUUID()}`;
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const scope = await scopeOf(this.#store);
      const previous = await this.#store.read<EntryState>(ENTRY + id);
      const entry = previous?.value ?? initialEntry(id, request.entry);
      const now = await this.#store.now();
      if (
        (entry.lease !== undefined && entry.lease.expiresAt > now) ||
        (entry.retryAt > now && request.reason !== 'manual')
      ) {
        return {
          kind: 'busy',
          current: await this.#summary(entry),
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
      if (
        await this.#store.change(
          new Map([
            [SCOPE_KEY, scope.raw],
            [ENTRY + id, previous?.raw ?? null],
            [ATTEMPT + attemptId, null],
          ]),
          new Map<string, unknown>([
            [ENTRY + id, { ...entry, fence: lease.fencingToken, lease }],
            [ATTEMPT + attemptId, attempt],
          ]),
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
          current: await this.#summary(entry),
        };
      const own = await this.#store.read<AttemptState>(ATTEMPT + attemptId);
      if (own !== undefined)
        return {
          kind: 'leased',
          attemptId,
          entryId: id,
          fencingToken: own.value.lease.fencingToken,
          leaseExpiresAt: own.value.lease.expiresAt,
          current: await this.#summary(entry),
        };
    }
    return busy();
  }

  async #leased(
    attemptId: string,
    token: number,
  ): Promise<{
    readonly scope: Stored<ScopeState>;
    readonly attempt: Stored<AttemptState>;
    readonly entry: Stored<EntryState>;
  }> {
    const scope = await scopeOf(this.#store);
    const attempt = await this.#store.read<AttemptState>(ATTEMPT + attemptId);
    if (attempt === undefined) return unavailable('AWS cache attempt is missing');
    const entry = await this.#store.read<EntryState>(ENTRY + attempt.value.entryId);
    if (
      entry === undefined ||
      !sameLease(entry.value, attempt.value, token, await this.#store.now())
    )
      return unavailable('AWS cache lease expired or was superseded');
    return { scope, attempt, entry };
  }

  async uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact> {
    const object = await this.#objects.put(upload.bytes, 'blobs', upload.contentType);
    const artifactId = await artifactIdFor(this.#options.scopeId, object.sha256);
    await this.#objects.link(artifactId, object);
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const { attempt, entry } = await this.#leased(upload.attemptId, upload.fencingToken);
      if (
        await this.#store.change(
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
      const { attempt, entry } = await this.#leased(attemptId, fencingToken);
      const lease = { ...attempt.value.lease, expiresAt: (await this.#store.now()) + LEASE_MS };
      if (
        await this.#store.change(
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
    const already = await this.#store.read<AttemptState>(ATTEMPT + attemptId);
    if (already?.value.status === 'published' && already.value.published !== undefined)
      return { kind: 'published', generationId: already.value.published.id };
    const id = await attemptGenerationIdFor(this.#options.scopeId, attemptId);
    checkTags(request.generation.tags.map((tag) => tag.value));
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      let leased;
      try {
        leased = await this.#leased(attemptId, request.fencingToken);
      } catch (error) {
        const result = await this.#store.read<AttemptState>(ATTEMPT + attemptId);
        if (result?.value.published !== undefined)
          return { kind: 'published', generationId: result.value.published.id };
        if (error instanceof CacheHostError) return { kind: 'refused', reason: 'lease-expired' };
        throw error;
      }
      const { attempt, entry } = leased;
      const tags = await this.#tags.snapshot(request.generation.tags.map((tag) => tag.value));
      const weighed = weighCommit(
        request.generation.tags.map((tag) => tag.value),
        tags.tags,
        attempt.value.lease.dependencyRevision,
        request.observedTagRevision,
        request.heldTagRevisions,
      );
      if (weighed.refused) return { kind: 'refused', reason: 'stale-dependencies' };
      const listed = request.generation.outputs.flatMap((output) => output.artifacts);
      const uploaded = await this.#store.readMany(
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
            artifactId: await artifactIdFor(this.#options.scopeId, artifact.sha256),
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
        scopeId: this.#options.scopeId,
        buildId: this.#options.buildId,
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
      const prepared = await this.#prepared(
        entry.value,
        { ...generation, outputs: admitted },
        tags.scope.value.revision + 1,
        weighed.dependencyRevision,
      );
      prepared.writes.set(SCOPE_KEY, {
        ...tags.scope.value,
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
        await this.#store.change(
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
      const result = await this.#store.read<AttemptState>(ATTEMPT + attemptId);
      if (result?.value.published !== undefined)
        return { kind: 'published', generationId: result.value.published.id };
    }
    return busy();
  }

  async fail(attemptId: string, request: FailRequest): Promise<void> {
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const prior = await this.#store.read<AttemptState>(ATTEMPT + attemptId);
      if (prior?.value.status === 'failed') return;
      const { scope, attempt, entry } = await this.#leased(attemptId, request.fencingToken);
      const failures = request.outcome === 'failed' ? entry.value.failures + 1 : 0;
      const retryAt =
        failures === 0
          ? 0
          : Date.now() + (request.retryAfterMs ?? Math.min(300_000, 1000 * 2 ** failures));
      if (
        await this.#store.change(
          new Map([
            [SCOPE_KEY, scope.raw],
            [ATTEMPT + attemptId, attempt.raw],
            [ENTRY + entry.value.id, entry.raw],
          ]),
          new Map<string, unknown>([
            [SCOPE_KEY, { ...scope.value, revision: scope.value.revision + 1 }],
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

  async readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const entry = await this.#store.read<EntryState>(ENTRY + entryId, signal);
    const ref = entry?.value.current;
    if (ref?.record === undefined) return undefined;
    const generation = await this.#readGeneration(ref);
    const tags = await this.#tags.snapshot(generation.tags.map((tag) => tag.value));
    const local =
      this.#store.kind === 'valkey'
        ? await this.#store.read<string>(RECORD + ref.id, signal)
        : undefined;
    const bytes =
      local === undefined
        ? await this.#objects.read(ref.record, signal)
        : new Uint8Array(Buffer.from(local.value, 'base64'));
    const decoded = decodeGenerationPack(bytes);
    if (
      decoded.kind !== 'ok' ||
      decoded.pack.header.generationId !== ref.id ||
      decoded.pack.header.scopeId !== this.#options.scopeId
    )
      throw new Error('AWS cache delivery record identity differs');
    const invalidation = condemnation(generation, ref.dependencyRevision, tags.tags, ref.revision);
    return invalidation === undefined
      ? bytes
      : encodeGenerationPack(
          {
            ...decoded.pack.header,
            revision: Math.max(ref.revision, invalidation.revision),
            invalidation,
          },
          decoded.pack.html,
          decoded.pack.postponed,
        );
  }

  async readArtifact(artifactId: string): Promise<Uint8Array | undefined> {
    const object = await this.#store.read<ObjectReference>(ARTIFACT + artifactId);
    const ref = object?.value ?? (await this.#objects.lookup(artifactId));
    if (ref === undefined) return undefined;
    if ((await artifactIdFor(this.#options.scopeId, ref.sha256)) !== artifactId)
      throw new Error('AWS cache artifact directory identity differs');
    return this.#objects.read(ref);
  }

  async getData(request: DataReadRequest): Promise<DataRead | undefined> {
    const id = (await deriveEntry(this.#options.scopeId, { ...request, kind: request.kind }))
      .entryId;
    const entry = await this.#store.read<EntryState>(ENTRY + id);
    const ref = entry?.value.current;
    if (ref === undefined) return undefined;
    const generation = await this.#readGeneration(ref);
    const data = generation.data;
    if (
      data === undefined ||
      data.entry.kind !== request.kind ||
      data.entry.handler !== request.handler
    )
      return undefined;
    const tags = await this.#tags.snapshot(data.entry.tags);
    const invalidation = condemnation(generation, ref.dependencyRevision, tags.tags, ref.revision);
    return {
      entryId: id,
      generationId: ref.id,
      dependencyRevision: ref.dependencyRevision,
      entry: data.entry,
      value: data.value,
      ...(invalidation === undefined ? {} : { invalidation }),
    };
  }

  async setData(request: DataWriteRequest): Promise<DataWritten> {
    checkTags(request.entry.tags);
    const descriptor = {
      kind: request.entry.kind,
      key: request.key,
      ...(request.entry.handler === undefined ? {} : { handler: request.entry.handler }),
    };
    const id = (await deriveEntry(this.#options.scopeId, descriptor)).entryId;
    const bytes = new Uint8Array(Buffer.from(request.valueBase64, 'base64'));
    const object = await this.#objects.put(bytes, 'blobs');
    const artifactId = await artifactIdFor(this.#options.scopeId, object.sha256);
    await this.#objects.link(artifactId, object);
    const generationId = `gen_${randomUUID()}`;
    const writerKey =
      request.order === undefined ? undefined : WRITER + id + ':' + request.order.writer;
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const snapshot = await this.#tags.snapshot(request.entry.tags);
      const previous = await this.#store.read<EntryState>(ENTRY + id);
      const entry = previous?.value ?? initialEntry(id, descriptor);
      const mark =
        writerKey === undefined
          ? undefined
          : await this.#store.read<{ seq: number; result: DataWritten }>(writerKey);
      if (mark !== undefined && request.order !== undefined && mark.value.seq >= request.order.seq)
        return { ...mark.value.result, superseded: true };
      const metadata = { ...request.entry, timestamp: unixMilliseconds(request.entry.timestamp) };
      const generation: GenerationState = {
        id: generationId,
        seq: entry.seq + 1,
        source: 'runtime',
        cacheTimestamp: metadata.timestamp,
        producedAt: Date.now(),
        policy: {
          revalidateAfter: finiteSeconds(metadata.revalidate),
          expireAfter: finiteSeconds(metadata.expire),
          clientStale: finiteSeconds(metadata.stale),
          source: 'runtime-output',
        },
        status: 200,
        headers: {},
        tags: metadata.tags.map((value) => ({ kind: tagKindOf(value), value })),
        outputs: [],
        data: {
          entry: metadata,
          value:
            bytes.byteLength <= 64 * 1024
              ? { kind: 'inline', base64: request.valueBase64 }
              : { kind: 'ref', artifactId },
        },
      };
      const invalidation = condemnation(generation, snapshot.scope.value.revision, snapshot.tags);
      const revision = snapshot.scope.value.revision + 1;
      const prepared = await this.#prepared(entry, generation, revision, revision);
      const result: DataWritten = {
        entryId: id,
        generationId,
        revision,
        ...(invalidation === undefined ? {} : { invalidation }),
      };
      const expected = new Map([
        [SCOPE_KEY, snapshot.scope.raw],
        [ENTRY + id, previous?.raw ?? null],
      ]);
      if (writerKey !== undefined) expected.set(writerKey, mark?.raw ?? null);
      prepared.writes.set(SCOPE_KEY, { ...snapshot.scope.value, revision });
      prepared.writes.set(ENTRY + id, { ...entry, seq: generation.seq, current: prepared.ref });
      prepared.writes.set(ARTIFACT + artifactId, object);
      if (writerKey !== undefined)
        prepared.writes.set(writerKey, { seq: request.order?.seq, result });
      const expires = new Map([[ARTIFACT + artifactId, Date.now() + TRANSIENT_RETENTION_MS]]);
      if (writerKey !== undefined) expires.set(writerKey, Date.now() + TRANSIENT_RETENTION_MS);
      if (await this.#store.change(expected, prepared.writes, undefined, expires)) return result;
    }
    return busy();
  }

  getTags(values: readonly string[]): Promise<TagInvalidations> {
    return this.#tags.getTags(values);
  }
  tagsDelta(since: number): Promise<TagDelta> {
    return this.#tags.delta(since);
  }

  async invalidate(request: InvalidateRequest): Promise<InvalidateOutcome> {
    const values = [...new Set(request.tags)];
    let revision = 0;
    const invalidations: InvalidateOutcome['invalidations'][number][] = [];
    for (let offset = 0; offset < values.length; offset += MAX_TAGS_PER_CALL) {
      const chunk = values.slice(offset, offset + MAX_TAGS_PER_CALL);
      checkTags(chunk);
      const receiptKey = `invalidation:${randomUUID()}`;
      for (let tries = 0; ; tries += 1) {
        if (tries >= MAX_CHANGE_TRIES) return busy();
        const scope = await scopeOf(this.#store);
        if (this.#store.kind === 'dynamodb' && scope.value.pending >= MAX_PENDING_EVENTS) {
          if (!(await this.#tags.project()))
            await new Promise((resolve) => {
              setTimeout(resolve, 10);
            });
          continue;
        }
        if (
          request.expire !== undefined &&
          (!Number.isFinite(request.expire) || request.expire < 0)
        )
          throw new Error('AWS cache invalidation expiry must be finite and nonnegative');
        const staleAt = inForceMoment(request, await this.#store.now());
        const windowMs = request.expire === undefined || request.expire === 0 ? 0 : Math.max(1, Math.round(request.expire * 1000));
        const hardExpireAt = staleAt + windowMs;
        const event: InvalidationEvent = {
          revision: scope.value.revision + 1,
          values: chunk,
          staleAt,
          hardExpireAt: Math.ceil(hardExpireAt),
          sparedAfter: request.inForceAt !== undefined && Number.isFinite(request.inForceAt)
            ? Math.max(staleAt, Math.ceil(request.inForceAt)) : null,
        };
        const expected = new Map<string, string | null>([
          [SCOPE_KEY, scope.raw],
          [receiptKey, null],
        ]);
        const writes = new Map<string, unknown | null>([[receiptKey, event]]);
        if (this.#store.kind === 'valkey') {
          const previous = await this.#store.readMany(chunk.map(tagKey));
          for (const value of chunk) {
            const key = tagKey(value);
            const old = previous.get(key);
            const tag = mergedTag(old?.value as TagState | undefined, event, value);
            expected.set(key, old?.raw ?? null);
            writes.set(key, tag);
            if (old !== undefined) writes.set(tagRevisionKey(old.value as TagState), null);
            writes.set(tagRevisionKey(tag), tag);
          }
          writes.set(SCOPE_KEY, {
            ...scope.value,
            revision: event.revision,
            checkpoint: event.revision,
            invalidationRevision: event.revision,
            invalidatedAt: event.staleAt,
          });
        } else {
          writes.set(revisionKey('event:', event.revision), event);
          writes.set(SCOPE_KEY, {
            ...scope.value,
            revision: event.revision,
            pending: scope.value.pending + 1,
            invalidationRevision: event.revision,
            invalidatedAt: event.staleAt,
          });
        }
        const changed = await this.#store.change(
          expected,
          writes,
          undefined,
          new Map([[receiptKey, Date.now() + TRANSIENT_RETENTION_MS]]),
        );
        const recorded = changed
          ? event
          : (await this.#store.read<InvalidationEvent>(receiptKey))?.value;
        if (recorded === undefined) continue;
        revision = recorded.revision;
        invalidations.push(
          ...recorded.values.map((value) => ({
            value,
            revision,
            staleAt: recorded.staleAt,
            hardExpireAt: recorded.hardExpireAt,
          })),
        );
        if (this.#store.kind === 'dynamodb') this.#hold(this.#tags.project());
        break;
      }
    }
    return { revision, invalidations };
  }

  /** Explicit AWS ingress barrier; the runtime host's optional no-wait beacon is not redefined. */
  async readScopeRevision(): Promise<ScopeRevision> {
    const scope = await scopeOf(this.#store);
    return { revision: scope.value.invalidationRevision, invalidatedAt: scope.value.invalidatedAt };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#maintenance);
    await Promise.allSettled(this.#background);
    await this.#store.close();
    this.#objects.close();
  }

  /** Services must be scaled to zero and drained before invoking this deployment-owned job. */
  async retire(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#maintenance);
    await Promise.allSettled(this.#background);
    let tombstone: Stored<ScopeState> | undefined;
    for (let attempt = 0; attempt < MAX_CHANGE_TRIES; attempt += 1) {
      const scope = await this.#store.read<ScopeState>(SCOPE_KEY);
      if (scope?.value.status === 'retired') {
        tombstone = scope;
        break;
      }
      const retired: ScopeState = {
        format: 1,
        buildId: this.#options.buildId,
        deploymentId: this.#options.deploymentId,
        revision: (scope?.value.revision ?? 0) + 1,
        invalidationRevision: scope?.value.invalidationRevision ?? 0,
        invalidatedAt: scope?.value.invalidatedAt ?? null,
        checkpoint: scope?.value.checkpoint ?? 0,
        pending: 0,
        status: 'retired',
      };
      if (
        await this.#store.change(
          new Map([[SCOPE_KEY, scope?.raw ?? null]]),
          new Map([[SCOPE_KEY, retired]]),
        )
      ) {
        tombstone = { raw: JSON.stringify(retired), value: retired };
        break;
      }
    }
    if (tombstone === undefined) return busy();
    let cursor: string | undefined;
    do {
      const page = await this.#store.list('', cursor, 64);
      const writes = new Map<string, unknown | null>();
      for (const item of page.items) if (item.key !== SCOPE_KEY) writes.set(item.key, null);
      if (
        writes.size > 0 &&
        !(await this.#store.change(new Map([[SCOPE_KEY, tombstone.raw]]), writes))
      )
        throw new Error('AWS cache retirement tombstone changed');
      cursor = page.cursor;
    } while (cursor !== undefined);
    await this.#objects.clear();
  }
}
