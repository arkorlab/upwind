import { randomUUID } from 'node:crypto';

import { artifactIdFor, deriveEntry, type OutputSnapshot } from '@stayingupwind/core/cache';
import type { ScopeRevision } from '@stayingupwind/core/paas';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { CacheHostError, type CurrentSummary } from '@stayingupwind/runtime/cache-host';

import { readSeedArtifact } from '../native/seed-artifact.ts';
import { entryCapacity } from './capacity.ts';
import type {
  AttemptState,
  EntryState,
  GenerationReference,
  GenerationState,
  ScopeState,
} from './model.ts';
import type { ObjectStore } from './objects.ts';
import { checkTags, condemnation, deliveryRecord } from './semantics.ts';
import { AwsTags, busy, scopeOf } from './tags.ts';
import {
  type AuthorityStore,
  type AwsCacheOptions,
  MAX_ARTIFACT_BYTES,
  MAX_CHANGE_TRIES,
  SCOPE_KEY,
  type Stored,
  TRANSIENT_RETENTION_MS,
} from './types.ts';

export const ENTRY = 'entry:';
export const ATTEMPT = 'attempt:';
export const ARTIFACT = 'artifact:';
export const META = 'generation:';
export const RECORD = 'record:';
export const WRITER = 'writer:';
const JSON_TYPE = 'application/json';

function unavailable(message: string): never {
  throw new CacheHostError(message, { code: 'unavailable', status: 503 });
}

export function initialEntry(id: string, descriptor: EntryState['descriptor']): EntryState {
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

export class AwsBase {
  readonly options: AwsCacheOptions;
  readonly store: AuthorityStore;
  readonly objects: ObjectStore;
  readonly tags: AwsTags;
  readonly #metadata = new Map<string, GenerationState>();
  readonly #background = new Set<Promise<unknown>>();
  #maintenance: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: AwsCacheOptions, store: AuthorityStore, objects: ObjectStore) {
    this.options = options;
    this.store = store;
    this.objects = objects;
    this.tags = new AwsTags(store);
  }

  hold(work: Promise<unknown>): void {
    const held = work.catch((error: unknown) => {
      // eslint-disable-next-line no-console -- The native process owns its background maintenance diagnostics.
      console.error(
        'upwind: AWS cache maintenance failed',
        error instanceof Error ? error.message : String(error),
      );
    });
    this.#background.add(held);
    this.options.waitUntil?.(held);
    void held.finally(() => this.#background.delete(held)).catch(() => undefined);
  }

  async initialize(): Promise<void> {
    const initial: ScopeState = {
      format: 1,
      buildId: this.options.buildId,
      deploymentId: this.options.deploymentId,
      revision: 0,
      invalidationRevision: 0,
      invalidatedAt: null,
      checkpoint: 0,
      pending: 0,
      entries: 0,
      tags: 0,
      bodyBytes: 0,
      status: 'seeding',
    };
    await this.store.change(new Map([[SCOPE_KEY, null]]), new Map([[SCOPE_KEY, initial]]));
    const found = await scopeOf(this.store);
    if (
      found.value.buildId !== initial.buildId ||
      found.value.deploymentId !== initial.deploymentId
    )
      throw new Error('AWS cache scope belongs to another immutable build');
    if (found.value.status === 'seeding') {
      for (const entry of this.options.seed?.entries ?? []) await this.#seedEntry(entry);
      for (let tries = 0; ; tries += 1) {
        if (tries >= MAX_CHANGE_TRIES) return busy();
        const scope = await scopeOf(this.store);
        if (scope.value.status === 'active') break;
        if (
          await this.store.change(
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
      if (this.store.kind === 'dynamodb') this.hold(this.tags.project());
      this.hold(this.store.sweepExpired());
    }, 1000);
    this.#maintenance.unref();
    if (this.store.kind === 'dynamodb') this.hold(this.tags.project());
  }

  async readGeneration(ref: GenerationReference): Promise<GenerationState> {
    const cached = this.#metadata.get(ref.metadata.key);
    if (cached !== undefined) return cached;
    const local =
      this.store.kind === 'valkey'
        ? await this.store.read<GenerationState>(META + ref.id)
        : undefined;
    const generation =
      local?.value ??
      (JSON.parse(
        new TextDecoder().decode(await this.objects.read(ref.metadata)),
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

  async summary(entry: EntryState): Promise<CurrentSummary | null> {
    const ref = entry.current;
    if (ref === undefined) return null;
    const generation = await this.readGeneration(ref);
    const tags = await this.tags.snapshot(generation.tags.map((tag) => tag.value));
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

  async prepared(
    entry: EntryState,
    generation: GenerationState,
    revision: number,
    dependencyRevision: number,
  ): Promise<{
    readonly ref: GenerationReference;
    readonly writes: Map<string, unknown | null>;
    readonly record?: Uint8Array | undefined;
  }> {
    const metadata = await this.objects.put(jsonBytes(generation), 'metadata', JSON_TYPE);
    const record =
      generation.data === undefined
        ? await deliveryRecord(
            this.options.scopeId,
            this.options.buildId,
            entry.id,
            entry.descriptor,
            generation,
            revision,
            this.objects,
          )
        : undefined;
    const recordRef = record === undefined ? undefined : await this.objects.put(record, 'records');
    const ref: GenerationReference = {
      id: generation.id,
      seq: generation.seq,
      revision,
      dependencyRevision,
      metadata,
      bytes:
        metadata.byteLength +
        (record?.byteLength ?? 0) +
        (generation.data?.byteLength ?? 0) +
        generation.outputs.reduce(
          (total, output) =>
            total + output.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
          0,
        ),
      ...(recordRef === undefined ? {} : { record: recordRef }),
    };
    const writes = new Map<string, unknown | null>();
    if (this.store.kind === 'valkey') {
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
    const id = (await deriveEntry(this.options.scopeId, seed.descriptor, seed.allowQuery)).entryId;
    if ((await this.store.read(ENTRY + id)) !== undefined) return;
    const directory = this.options.seed?.blobsDirectory;
    if (directory === undefined) throw new Error('AWS cache seed has no blob directory');
    checkTags(seed.generation.tags.map((tag) => tag.value));
    const outputs: OutputSnapshot[] = [];
    for (const output of seed.generation.outputs) {
      const artifacts = [];
      for (const artifact of output.artifacts) {
        if (artifact.encoding !== 'identity')
          throw new Error('AWS native cache requires identity seed artifacts');
        const bytes = await readSeedArtifact(directory, artifact, MAX_ARTIFACT_BYTES);
        const object = await this.objects.put(bytes, 'blobs', artifact.contentType);
        const artifactId = await artifactIdFor(this.options.scopeId, artifact.sha256);
        await this.objects.link(artifactId, object);
        await this.store.change(
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
      const scope = await scopeOf(this.store);
      const previous = await this.store.read<EntryState>(ENTRY + id);
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
      const prepared = await this.prepared(entry, generation, scope.value.revision + 1, 0);
      prepared.writes.set(ENTRY + id, { ...entry, seq: 1, current: prepared.ref });
      prepared.writes.set(SCOPE_KEY, {
        ...entryCapacity(scope.value, undefined, prepared.ref),
        revision: scope.value.revision + 1,
      });
      if (
        await this.store.change(
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

  async leased(
    attemptId: string,
    token: number,
  ): Promise<{
    readonly scope: Stored<ScopeState>;
    readonly attempt: Stored<AttemptState>;
    readonly entry: Stored<EntryState>;
  }> {
    const scope = await scopeOf(this.store);
    const attempt = await this.store.read<AttemptState>(ATTEMPT + attemptId);
    if (attempt === undefined) return unavailable('AWS cache attempt is missing');
    const entry = await this.store.read<EntryState>(ENTRY + attempt.value.entryId);
    if (
      entry === undefined ||
      !sameLease(entry.value, attempt.value, token, await this.store.now())
    )
      return unavailable('AWS cache lease expired or was superseded');
    return { scope, attempt, entry };
  }

  /** Explicit AWS ingress barrier; the runtime host's optional no-wait beacon is not redefined. */
  async readScopeRevision(): Promise<ScopeRevision> {
    const scope = await scopeOf(this.store);
    return { revision: scope.value.invalidationRevision, invalidatedAt: scope.value.invalidatedAt };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#maintenance);
    await Promise.allSettled(this.#background);
    await this.store.close();
    this.objects.close();
  }

  /** Services must be scaled to zero and drained before invoking this deployment-owned job. */
  async retire(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#maintenance);
    await Promise.allSettled(this.#background);
    let tombstone: Stored<ScopeState> | undefined;
    for (let attempt = 0; attempt < MAX_CHANGE_TRIES; attempt += 1) {
      const scope = await this.store.read<ScopeState>(SCOPE_KEY);
      if (scope?.value.status === 'retired') {
        tombstone = scope;
        break;
      }
      const retired: ScopeState = {
        format: 1,
        buildId: this.options.buildId,
        deploymentId: this.options.deploymentId,
        revision: (scope?.value.revision ?? 0) + 1,
        invalidationRevision: scope?.value.invalidationRevision ?? 0,
        invalidatedAt: scope?.value.invalidatedAt ?? null,
        checkpoint: scope?.value.checkpoint ?? 0,
        pending: 0,
        entries: 0,
        tags: 0,
        bodyBytes: 0,
        status: 'retired',
      };
      if (
        await this.store.change(
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
      const page = await this.store.list('', cursor, 64);
      const writes = new Map<string, unknown | null>();
      for (const item of page.items) if (item.key !== SCOPE_KEY) writes.set(item.key, null);
      if (
        writes.size > 0 &&
        !(await this.store.change(new Map([[SCOPE_KEY, tombstone.raw]]), writes))
      )
        throw new Error('AWS cache retirement tombstone changed');
      cursor = page.cursor;
    } while (cursor !== undefined);
    await this.objects.clear();
  }
}
