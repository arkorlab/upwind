import {
  type EntryDescriptor,
  type GenerationPackHeader,
  type InvalidationState,
  isRouteDescriptor,
  MAX_PACK_BYTES,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_ENTRY,
  PACK_SCHEMA_VERSION,
  packBodyDigests,
  encodeGenerationPack,
  publicArtifactRef,
  withTagHistory,
} from '@stayingupwind/core/cache';

import type { PackHeaderFields } from '../scope/pack-header-fields.ts';
import { staticPageHeadersOf, staticPagePrivacyOf } from '../scope/static-page-privacy.ts';
import type {
  DataInvalidationMark,
  GenerationState,
  InvalidationEvent,
  TagState,
} from './model.ts';
import type { ObjectStore } from './objects.ts';

export function checkTags(values: readonly string[]): void {
  if (
    values.length > MAX_TAGS_PER_ENTRY ||
    values.some((value) => value.length === 0 || value.length > MAX_TAG_LENGTH)
  )
    throw new Error('AWS cache tags exceed the runtime contract');
}

export function mergedTag(
  previous: TagState | undefined,
  event: InvalidationEvent,
  value: string,
): TagState {
  const history = withTagHistory(previous?.history, {
    revision: event.revision,
    staleAt: event.staleAt,
    hardExpireAt: event.hardExpireAt,
  });
  const latest = previous !== undefined && previous.revision > event.revision ? previous : event;
  const dataHistory: DataInvalidationMark[] = [...(previous?.dataHistory ?? [])];
  if (!dataHistory.some((mark) => mark.revision === event.revision)) {
    dataHistory.push({
      revision: event.revision,
      staleAt: event.staleAt,
      hardExpireAt: event.hardExpireAt,
      sparedAfter: event.sparedAfter,
    });
    dataHistory.sort((a, b) => a.revision - b.revision);
    if (dataHistory.length > 16) {
      const [first, second] = dataHistory;
      if (first !== undefined && second !== undefined) {
        const hard = Math.min(first.hardExpireAt ?? Infinity, second.hardExpireAt ?? Infinity);
        dataHistory.splice(0, 2, {
          revision: second.revision,
          staleAt: Math.max(first.staleAt, second.staleAt),
          hardExpireAt: hard === Infinity ? null : hard,
          sparedAfter: null,
        });
      }
    }
  }
  return {
    value,
    revision: latest.revision,
    staleAt: latest.staleAt,
    hardExpireAt: latest.hardExpireAt,
    history,
    latestImmediateRevision: Math.max(
      previous?.latestImmediateRevision ?? 0,
      event.hardExpireAt !== null && event.hardExpireAt <= event.staleAt ? event.revision : 0,
    ),
    dataHistory,
  };
}

/** A later SWR mark never reopens an earlier expired value. */
export function condemnation(
  generation: GenerationState,
  dependencyRevision: number,
  tags: ReadonlyMap<string, TagState>,
  publicationRevision = dependencyRevision,
): InvalidationState | undefined {
  let result: InvalidationState | undefined = generation.condemned;
  for (const tag of generation.tags) {
    const state = tags.get(tag.value);
    const history = generation.data === undefined ? state?.history : state?.dataHistory;
    for (const mark of history ?? []) {
      if (generation.data === undefined && mark.revision <= dependencyRevision) continue;
      if (generation.data !== undefined && generation.cacheTimestamp !== null) {
        const threshold =
          publicationRevision < mark.revision
            ? (mark as DataInvalidationMark).sparedAfter
            : mark.staleAt;
        if (threshold !== null && generation.cacheTimestamp > threshold) continue;
      }
      result = {
        revision: Math.max(result?.revision ?? 0, mark.revision),
        staleAt: Math.min(result?.staleAt ?? Infinity, mark.staleAt),
        ...(mark.hardExpireAt === null && result?.hardExpireAt === undefined
          ? {}
          : {
              hardExpireAt: Math.min(
                result?.hardExpireAt ?? Infinity,
                mark.hardExpireAt ?? Infinity,
              ),
            }),
      };
    }
  }
  return result;
}

/** Match the authority's held-immediate excusal: a held SWR may still have served stale inputs. */
export function weighCommit(
  values: readonly string[],
  tags: ReadonlyMap<string, TagState>,
  leaseRevision: number,
  observed: number,
  held: Readonly<Record<string, number>>,
): {
  readonly refused: boolean;
  readonly dependencyRevision: number;
  readonly condemned?: InvalidationState | undefined;
} {
  const behind = Math.min(leaseRevision, observed);
  let heldThrough = leaseRevision;
  let condemned: InvalidationState | undefined;
  let refused = false;
  for (const value of values) {
    const tag = tags.get(value);
    const history = tag?.history ?? [];
    const through = Math.min(observed, held[value] ?? 0);
    const immediate = tag?.latestImmediateRevision ?? 0;
    refused ||= immediate > Math.max(behind, through);
    const afresh = immediate <= through ? immediate : 0;
    for (const mark of history) {
      if (mark.revision <= behind) continue;
      if (mark.revision <= afresh) {
        heldThrough = Math.max(heldThrough, mark.revision);
        continue;
      }
      condemned = {
        revision: Math.max(condemned?.revision ?? 0, mark.revision),
        staleAt: Math.min(condemned?.staleAt ?? Infinity, mark.staleAt),
        ...(mark.hardExpireAt === null && condemned?.hardExpireAt === undefined
          ? {}
          : {
              hardExpireAt: Math.min(
                condemned?.hardExpireAt ?? Infinity,
                mark.hardExpireAt ?? Infinity,
              ),
            }),
      };
    }
  }
  return {
    refused,
    dependencyRevision: heldThrough,
    ...(condemned === undefined ? {} : { condemned }),
  };
}

export async function deliveryRecord(
  scopeId: string,
  buildId: string,
  entryId: string,
  descriptor: EntryDescriptor,
  generation: GenerationState,
  revision: number,
  objects: ObjectStore,
): Promise<Uint8Array> {
  if (!isRouteDescriptor(descriptor)) throw new Error('a data cache value has no delivery record');
  const artifacts = generation.outputs.flatMap((output) => output.artifacts);
  const htmlRef = artifacts.find(
    (artifact) => artifact.role === 'html' || artifact.role === 'route-body',
  );
  const stateRef = artifacts.find(
    (artifact) => artifact.role === 'postponed' && artifact.byteLength > 0,
  );
  const read = async (ref: typeof htmlRef): Promise<Uint8Array> =>
    ref === undefined
      ? new Uint8Array(0)
      : objects.read({ key: ref.storageRef, sha256: ref.sha256, byteLength: ref.byteLength });
  const [html, state] = await Promise.all([
    read(htmlRef),
    stateRef === undefined ? undefined : read(stateRef),
  ]);
  const digests = await packBodyDigests(html, state);
  const fields: PackHeaderFields = {
    scopeId,
    buildId,
    entry: {
      entryId,
      kind: descriptor.kind,
      route: descriptor.route,
      pathname: descriptor.pathname,
    },
    generation: { generationId: generation.id, ...generation },
    outputs: generation.outputs,
  };
  const privacy = staticPagePrivacyOf(fields, digests);
  const header: GenerationPackHeader = {
    schemaVersion: PACK_SCHEMA_VERSION,
    scopeId,
    entryId,
    generationId: generation.id,
    seq: generation.seq,
    source: generation.source,
    kind: descriptor.kind,
    route: descriptor.route,
    pathname: descriptor.pathname,
    cacheTimestamp: generation.cacheTimestamp,
    producedAt: generation.producedAt,
    policy: generation.policy,
    status: generation.status,
    headers: privacy === undefined ? generation.headers : staticPageHeadersOf(fields),
    tags: [...generation.tags],
    ...digests,
    ...(privacy === undefined ? {} : { staticPagePrivacy: privacy }),
    artifacts: generation.outputs.flatMap((output) =>
      output.artifacts.map((artifact) => ({
        ...publicArtifactRef(artifact),
        representationKey: output.representationKey,
        storageRef: artifact.storageRef,
      })),
    ),
    revision,
    ...(generation.condemned === undefined ? {} : { invalidation: generation.condemned }),
  };
  const record = encodeGenerationPack(header, html, state);
  if (record.byteLength > MAX_PACK_BYTES)
    throw new Error('AWS cache delivery record exceeds its byte limit');
  return record;
}
