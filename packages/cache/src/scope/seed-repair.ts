import { canonicalJson } from '@stayingupwind/core/artifact';
import type { OutputSnapshot } from '@stayingupwind/core/cache';
import type { SeedEntryInput } from '@stayingupwind/host/cache';

import { entryStateEvent } from './attempts.ts';
import { type EntryIdentity, findEntry, requireEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import type { EventInput } from './history.ts';
import { headerFieldsOf, InvalidArtifactError, unwritableRecord } from './records.ts';
import {
  type EntryRow,
  generationOutputs,
  type GenerationRow,
  toEntryState,
  toPublicGeneration,
} from './rows.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';
import type { TxInput } from './tx.ts';

const FAILURE_PREFIX = 'seed_artifact_failure:';

/** A seed whose bytes projection could not read, not a record delayed by an outage. */
export function rememberSeedFailure(
  deps: { readonly sql: SqlStorage; readonly transaction: <T>(body: () => T) => T },
  snapshot: { readonly entry: EntryRow; readonly current: GenerationRow | undefined } | undefined,
  error: unknown,
): void {
  if (snapshot === undefined || !(error instanceof InvalidArtifactError)) return;
  const { sql } = deps;
  const { entry, current } = snapshot;
  deps.transaction(() => {
    const latest = findEntry(sql, entry.entry_id);
    if (
      current?.source === 'build' &&
      latest?.kv_revision === 0 &&
      latest.current_generation_id === current.generation_id &&
      latest.record_revision === entry.record_revision
    ) {
      writeMeta(sql, FAILURE_PREFIX + entry.entry_id, current.generation_id);
    }
  });
}

/** Once its record is acknowledged in KV, the build's locations are closed to a seed's retry. */
export function forgetSeedFailure(sql: SqlStorage, entryId: string): void {
  deleteMeta(sql, FAILURE_PREFIX + entryId);
}

interface SeedLocations {
  readonly entry: SeedEntryInput;
  readonly identity: Pick<EntryIdentity, 'entryId'>;
  readonly outputs: readonly OutputSnapshot[];
}

/** Only the locations may differ: the generation's bytes and every other field stay its own. */
function relocatedOutputs(
  previous: readonly OutputSnapshot[],
  proposed: readonly OutputSnapshot[],
): OutputSnapshot[] | undefined {
  const next = proposed.map((output, index) => {
    return {
      ...output,
      outputId: previous[index]?.outputId ?? '',
    };
  });
  const unchanged = next.map((output, index) => {
    return {
      ...output,
      artifacts: output.artifacts.map((artifact, offset) => {
        return {
          ...artifact,
          storageRef: previous[index]?.artifacts[offset]?.storageRef ?? '',
        };
      }),
    };
  });
  return canonicalJson(previous) === canonicalJson(unchanged) ? next : undefined;
}

function repairableGeneration(sql: SqlStorage, plan: SeedLocations): GenerationRow | undefined {
  const entry = findEntry(sql, plan.identity.entryId);
  if (
    entry?.kv_revision !== 0 ||
    entry.publication !== 'published' ||
    entry.regeneration_attempt_id !== null ||
    entry.current_generation_id !== plan.entry.generation.generationId ||
    readMeta(sql, FAILURE_PREFIX + entry.entry_id) !== entry.current_generation_id
  ) {
    return undefined;
  }
  const generation = findGeneration(sql, entry.current_generation_id);
  return generation?.source === 'build' && generation.publication === 'published'
    ? generation
    : undefined;
}

function repairOne(input: TxInput, plan: SeedLocations, events: EventInput[]): boolean {
  const { sql, revision, now, scopeId } = input;
  const generation = repairableGeneration(sql, plan);
  if (generation === undefined) return false;
  const previous = generationOutputs(generation);
  const outputs = relocatedOutputs(previous, plan.outputs);
  const entry = findEntry(sql, generation.entry_id);
  if (
    outputs === undefined ||
    entry === undefined ||
    unwritableRecord(
      headerFieldsOf(scopeId, entry, generation, outputs),
      input.limits.maxRecordBytes,
    ) !== undefined
  ) {
    return false;
  }
  // A borrowed artifact may be shared by several entries. Relocate its reference, never its
  // ownership or reference count, and never a different location another change has given it.
  for (const [index, output] of outputs.entries()) {
    for (const [offset, artifact] of output.artifacts.entries()) {
      sql.exec(
        `UPDATE artifacts SET storage_ref = ? WHERE sha256 = ? AND storage_ref = ? AND owned = 0`,
        artifact.storageRef,
        artifact.sha256,
        previous[index]?.artifacts[offset]?.storageRef ?? '',
      );
    }
  }
  sql.exec(
    `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
    JSON.stringify(outputs),
    generation.generation_id,
  );
  sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?, updated_at = ? WHERE entry_id = ?`,
    revision,
    revision,
    now,
    generation.entry_id,
  );
  forgetSeedFailure(sql, generation.entry_id);
  events.push(entryStateEvent(sql, generation.entry_id), {
    entityType: 'generation',
    entityId: generation.generation_id,
    kind: 'generation.committed',
    payload: {
      generation: toPublicGeneration(scopeId, { ...generation, outputs: JSON.stringify(outputs) }),
      entryState: toEntryState(requireEntry(sql, generation.entry_id)),
      supersededGenerationId: null,
      attempt: null,
    },
  });
  return true;
}

/**
 * A seed whose record has never been acknowledged in KV may correct where its unchanged bytes are
 * kept after projection found them missing or corrupt. No seed reads storage to ask in advance,
 * and a retry changes neither an acknowledged generation nor one a render holds a lease to replace.
 */
export function repairSeedEntries(
  input: TxInput,
  plans: readonly SeedLocations[],
  events: EventInput[],
): number {
  return plans.reduce((count, plan) => count + Number(repairOne(input, plan, events)), 0);
}
