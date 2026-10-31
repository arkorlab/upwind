import { resourceSnapshotOf } from '@stayingupwind/core/cache';
import type { CommitResponse } from '@stayingupwind/host/cache';

import { endAttempt } from './attempts.ts';
import type { EventInput } from './history.ts';
import type { AttemptRow } from './rows.ts';
import { readRevision } from './state.ts';
import { record, type TxInput } from './tx.ts';

interface SnapshotFailure {
  readonly revision: number;
  readonly message: string;
}

interface ResourceHead extends Record<string, SqlStorageValue> {
  resource_id: string | null;
  version: number | null;
  tag: string | null;
  tag_revision: number | null;
  expected: number;
}

function minimumVersions(tags: readonly string[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const tag of tags) {
    const witness = resourceSnapshotOf(tag);
    if (witness !== undefined)
      versions.set(
        witness.resourceId,
        Math.min(versions.get(witness.resourceId) ?? witness.version, witness.version),
      );
  }
  return versions;
}

/** Indexed, bounded to the supplied witnesses, under the publication's existing transaction. */
export function resourceSnapshotFailure(
  sql: SqlStorage,
  tags: readonly string[],
): SnapshotFailure | undefined {
  let versions: Map<string, number>;
  try {
    versions = minimumVersions(tags);
  } catch {
    return { revision: readRevision(sql), message: 'The resource snapshot witness is malformed.' };
  }
  if (versions.size === 0) return undefined;
  const held = new Set(tags);
  const heads = sql.exec<ResourceHead>(
    `SELECT h.resource_id, h.version, h.tag, h.tag_revision,
      json_extract(i.value, '$[1]') AS expected
     FROM json_each(?) i LEFT JOIN resource_heads h
       ON h.resource_id = json_extract(i.value, '$[0]')`,
    JSON.stringify([...versions]),
  );
  for (const head of heads) {
    if (
      head.version === null ||
      head.version > head.expected ||
      head.tag === null ||
      !held.has(head.tag)
    )
      return {
        revision: head.tag_revision ?? readRevision(sql),
        message: 'The resource snapshot predates its delivered change.',
      };
  }
  return undefined;
}

/** Release the stale publisher's lease while retaining the prior generation for normal SWR. */
export function supersedeResourceSnapshot(
  input: TxInput,
  attempt: AttemptRow,
  failure: SnapshotFailure,
): CommitResponse {
  const events: EventInput[] = [];
  endAttempt(input, attempt, { status: 'superseded', regeneration: 'queued' }, events);
  record(input, events);
  return { kind: 'stale-dependencies', invalidationRevision: failure.revision };
}
