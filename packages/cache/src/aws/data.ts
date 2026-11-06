import { randomUUID } from 'node:crypto';

import {
  artifactIdFor,
  decodeGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  finiteSeconds,
  MAX_TAGS_PER_CALL,
  tagKindOf,
} from '@stayingupwind/core/cache';
import { isDeadlineError, withDeadline } from '@stayingupwind/core/util';
import { CacheHostError } from '@stayingupwind/runtime/cache-host';
import type {
  DataRead,
  DataReadRequest,
  DataWriteRequest,
  DataWritten,
  InvalidateOutcome,
  InvalidateRequest,
  TagDelta,
  TagInvalidations,
} from '@stayingupwind/runtime/cache-host';

import { unixMilliseconds } from '../native/timestamp.ts';
import { inForceMoment } from '../scope/invalidations.ts';
import { ARTIFACT, type AwsBase, ENTRY, initialEntry, RECORD, WRITER } from './base.ts';
import { entryCapacity, tagCapacity } from './capacity.ts';
import type { EntryState, GenerationState, InvalidationEvent, TagState } from './model.ts';
import type { ObjectReference } from './objects.ts';
import { checkTags, condemnation, mergedTag } from './semantics.ts';
import { busy, tagKey, tagRevisionKey } from './tags.ts';
import {
  MAX_CHANGE_TRIES,
  MAX_PENDING_EVENTS,
  INVALIDATION_BACKPRESSURE_MS,
  revisionKey,
  SCOPE_KEY,
  TRANSIENT_RETENTION_MS,
} from './types.ts';

export class AwsData {
  readonly context: AwsBase;
  readonly #artifacts = new Map<string, ObjectReference>();
  constructor(context: AwsBase) {
    this.context = context;
  }

  async readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const entry = await this.context.store.read<EntryState>(ENTRY + entryId, signal);
    const ref = entry?.value.current;
    if (ref?.record === undefined) return undefined;
    const generation = await this.context.readGeneration(ref);
    const tags = await this.context.tags.snapshot(generation.tags.map((tag) => tag.value));
    const local =
      this.context.store.kind === 'valkey'
        ? await this.context.store.read<string>(RECORD + ref.id, signal)
        : undefined;
    const bytes =
      local === undefined
        ? await this.context.objects.read(ref.record, signal)
        : new Uint8Array(Buffer.from(local.value, 'base64'));
    const decoded = decodeGenerationPack(bytes);
    if (
      decoded.kind !== 'ok' ||
      decoded.pack.header.generationId !== ref.id ||
      decoded.pack.header.scopeId !== this.context.options.scopeId
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
    const cached = this.#artifacts.get(artifactId);
    if (cached !== undefined) return this.context.objects.read(cached);
    const object = await this.context.store.read<ObjectReference>(ARTIFACT + artifactId);
    const ref = object?.value ?? (await this.context.objects.lookup(artifactId));
    if (ref === undefined) return undefined;
    if ((await artifactIdFor(this.context.options.scopeId, ref.sha256)) !== artifactId)
      throw new Error('AWS cache artifact directory identity differs');
    this.#artifacts.set(artifactId, ref);
    if (this.#artifacts.size > 128) {
      const first = this.#artifacts.keys().next().value;
      if (first !== undefined) this.#artifacts.delete(first);
    }
    return this.context.objects.read(ref);
  }

  async getData(request: DataReadRequest): Promise<DataRead | undefined> {
    const id = (await deriveEntry(this.context.options.scopeId, { ...request, kind: request.kind }))
      .entryId;
    const entry = await this.context.store.read<EntryState>(ENTRY + id);
    const ref = entry?.value.current;
    if (ref === undefined) return undefined;
    const generation = await this.context.readGeneration(ref);
    const data = generation.data;
    if (
      data === undefined ||
      data.entry.kind !== request.kind ||
      data.entry.handler !== request.handler
    )
      return undefined;
    const tags = await this.context.tags.snapshot(data.entry.tags);
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
    const id = (await deriveEntry(this.context.options.scopeId, descriptor)).entryId;
    const bytes = new Uint8Array(Buffer.from(request.valueBase64, 'base64'));
    const object = await this.context.objects.put(bytes, 'blobs');
    const artifactId = await artifactIdFor(this.context.options.scopeId, object.sha256);
    await this.context.objects.link(artifactId, object);
    const generationId = `gen_${randomUUID()}`;
    const writerKey =
      request.order === undefined ? undefined : WRITER + id + ':' + request.order.writer;
    for (let tries = 0; tries < MAX_CHANGE_TRIES; tries += 1) {
      const snapshot = await this.context.tags.snapshot(request.entry.tags);
      const previous = await this.context.store.read<EntryState>(ENTRY + id);
      const entry = previous?.value ?? initialEntry(id, descriptor);
      const mark =
        writerKey === undefined
          ? undefined
          : await this.context.store.read<{ seq: number; result: DataWritten }>(writerKey);
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
          byteLength: bytes.byteLength,
          value:
            bytes.byteLength <= 64 * 1024
              ? { kind: 'inline', base64: request.valueBase64 }
              : { kind: 'ref', artifactId },
        },
      };
      const invalidation = condemnation(generation, snapshot.scope.value.revision, snapshot.tags);
      const revision = snapshot.scope.value.revision + 1;
      const prepared = await this.context.prepared(entry, generation, revision, revision);
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
      prepared.writes.set(SCOPE_KEY, {
        ...entryCapacity(snapshot.scope.value, previous?.value, prepared.ref),
        revision,
      });
      prepared.writes.set(ENTRY + id, { ...entry, seq: generation.seq, current: prepared.ref });
      prepared.writes.set(ARTIFACT + artifactId, object);
      if (writerKey !== undefined)
        prepared.writes.set(writerKey, { seq: request.order?.seq, result });
      const expires = new Map([[ARTIFACT + artifactId, Date.now() + TRANSIENT_RETENTION_MS]]);
      if (writerKey !== undefined) expires.set(writerKey, Date.now() + TRANSIENT_RETENTION_MS);
      if (await this.context.store.change(expected, prepared.writes, undefined, expires))
        return result;
    }
    return busy();
  }

  getTags(values: readonly string[]): Promise<TagInvalidations> {
    return this.context.tags.getTags(values);
  }

  tagsDelta(since: number): Promise<TagDelta> {
    return this.context.tags.delta(since);
  }

  async invalidate(request: InvalidateRequest): Promise<InvalidateOutcome> {
    const values = [...new Set(request.tags)];
    const pressureDeadline = performance.now() + INVALIDATION_BACKPRESSURE_MS;
    let pressureWaits = 0;
    let revision = 0;
    const invalidations: InvalidateOutcome['invalidations'][number][] = [];
    for (let offset = 0; offset < values.length; offset += MAX_TAGS_PER_CALL) {
      const chunk = values.slice(offset, offset + MAX_TAGS_PER_CALL);
      checkTags(chunk);
      const receiptKey = `invalidation:${randomUUID()}`;
      for (let tries = 0; ;) {
        if (tries >= MAX_CHANGE_TRIES) return busy();
        const snapshot = await this.context.tags.snapshot(chunk);
        const scope = snapshot.scope;
        const capacity = tagCapacity(
          scope.value,
          chunk.filter((value) => !snapshot.tags.has(value)).length,
        );
        if (this.context.store.kind === 'dynamodb' && scope.value.pending >= MAX_PENDING_EVENTS) {
          const remaining = pressureDeadline - performance.now();
          try {
            const projected = await withDeadline(
              this.context.tags.project(),
              remaining,
              'AWS invalidation projection',
            );
            if (!projected)
              await new Promise((resolve) => {
                const delay = Math.min(1000, 50 * 2 ** Math.min(pressureWaits++, 5));
                setTimeout(resolve, Math.max(0, Math.min(delay, remaining)));
              });
          } catch (error) {
            if (!isDeadlineError(error)) throw error;
            throw new CacheHostError('AWS invalidation projection did not catch up in time', {
              code: 'unavailable',
              status: 503,
              cause: error,
            });
          }
          continue;
        }
        if (
          request.expire !== undefined &&
          (!Number.isFinite(request.expire) || request.expire < 0)
        )
          throw new Error('AWS cache invalidation expiry must be finite and nonnegative');
        const staleAt = inForceMoment(request, await this.context.store.now());
        const windowMs =
          request.expire === undefined || request.expire === 0
            ? 0
            : Math.max(1, Math.round(request.expire * 1000));
        const hardExpireAt = staleAt + windowMs;
        const event: InvalidationEvent = {
          revision: scope.value.revision + 1,
          values: chunk,
          staleAt,
          hardExpireAt: Math.ceil(hardExpireAt),
          sparedAfter:
            request.inForceAt !== undefined && Number.isFinite(request.inForceAt)
              ? Math.max(staleAt, Math.ceil(request.inForceAt))
              : null,
        };
        const expected = new Map<string, string | null>([
          [SCOPE_KEY, scope.raw],
          [receiptKey, null],
        ]);
        const writes = new Map<string, unknown | null>([[receiptKey, event]]);
        if (this.context.store.kind === 'valkey') {
          const previous = await this.context.store.readMany(chunk.map(tagKey));
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
            ...capacity,
            revision: event.revision,
            checkpoint: event.revision,
            invalidationRevision: event.revision,
            invalidatedAt: event.staleAt,
          });
        } else {
          writes.set(revisionKey('event:', event.revision), event);
          writes.set(SCOPE_KEY, {
            ...capacity,
            revision: event.revision,
            pending: scope.value.pending + 1,
            invalidationRevision: event.revision,
            invalidatedAt: event.staleAt,
          });
        }
        const changed = await this.context.store.change(
          expected,
          writes,
          undefined,
          new Map([[receiptKey, Date.now() + TRANSIENT_RETENTION_MS]]),
        );
        const recorded = changed
          ? event
          : (await this.context.store.read<InvalidationEvent>(receiptKey))?.value;
        if (recorded === undefined) {
          tries += 1;
          continue;
        }
        revision = recorded.revision;
        invalidations.push(
          ...recorded.values.map((value) => ({
            value,
            revision,
            staleAt: recorded.staleAt,
            hardExpireAt: recorded.hardExpireAt,
          })),
        );
        if (this.context.store.kind === 'dynamodb') this.context.hold(this.context.tags.project());
        break;
      }
    }
    return { revision, invalidations };
  }
}
