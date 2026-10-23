import { dataUploadExpired, dataUploadStartedAt } from './data-uploads.ts';
import { type DataSetInput, type DataSetOutcome, planSetData } from './data.ts';
import type { BlobStore, CarriedValue } from './io.ts';
import type { RepairPending, RepairStart } from './repair-jobs.ts';
import { isRefusal, type Refusal, refuse, requireActiveScope } from './state.ts';
import type { Apply, TxInput } from './tx.ts';

/** What adopting a data upload reads of the scope's object (`adoptDataUpload`). */
export interface AdoptDeps {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  /** The authority's clock, read as the change is planned. */
  readonly now: () => number;
  readonly blobs: () => BlobStore;
}

/**
 * Plan the write of a value the gateway stored (`setValue`), where its upload still stands: one
 * whose upload clock (`dataUploadStartedAt`) has run past its lease is refused. A key that carries
 * no upload clock is checked for existence under the same mutex as GC, through the store every
 * other read of storage goes through; current uploads use the timestamp fence without another
 * storage read.
 */
export async function adoptDataUpload(
  deps: AdoptDeps,
  tx: TxInput,
  input: DataSetInput,
): Promise<
  Apply<DataSetOutcome | Refusal | RepairStart<DataSetOutcome | Refusal> | RepairPending>
> {
  const scope = requireActiveScope(deps.sql);
  if (isRefusal(scope)) return () => scope;
  const startedAt = dataUploadStartedAt(deps.scopeId, input.value.storageRef);
  if (startedAt !== undefined && dataUploadExpired(deps.sql, startedAt, deps.now())) {
    return () => refuse('lease_expired', 'the data upload expired before adoption');
  }
  if (startedAt === undefined && !(await deps.blobs().exists(input.value.storageRef))) {
    return () => refuse('artifact_missing', 'the data upload is no longer present');
  }
  return planSetData(tx, input, deps.blobs());
}

/**
 * The bytes a write handed over with its value (`DataSetInput.bytes`), named as the gateway named
 * them, for its settle to make the value's record of; `undefined` where it handed over none.
 */
export function carriedValueOf(input: DataSetInput): CarriedValue | undefined {
  return input.bytes === undefined ? undefined : { sha256: input.value.sha256, bytes: input.bytes };
}
