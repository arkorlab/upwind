import { recordsBehindAmong, recordsInRepairWindow } from './entries.ts';
import type { EntryRow } from './rows.ts';
import type { OwnRecords, SettleDeps } from './settle.ts';
import { readScope } from './state.ts';

const PROJECTION_BATCH = 50;
interface RepairProjection {
  readonly failed: number;
  readonly written: number;
  readonly cut: boolean;
}
type ProjectRepairPage = (
  deps: SettleDeps,
  entries: readonly EntryRow[],
  writing: {
    readonly retired: boolean;
    readonly wanted?: OwnRecords['wanted'];
    readonly carried?: OwnRecords['carried'];
  },
  stop: () => boolean,
) => Promise<{ readonly failed: number; readonly written: number; readonly reached: number }>;

/** Capture the repair's first pending index page before another writer can change it. */
export function ownRepairRecordsOf(
  sql: SqlStorage,
  fromRevision: number,
  revision: number,
): OwnRecords {
  const rows = recordsInRepairWindow(sql, {
    fromRevision,
    throughRevision: revision,
    after: { revision: fromRevision - 1, entryId: '' },
    limit: PROJECTION_BATCH,
  });
  const last = rows.at(-1);
  return {
    revision,
    first: rows.map((entry) => entry.entry_id),
    controlTags: { ids: [], projected: true },
    tags: [],
    repairWindow: {
      fromRevision,
      firstAfter: { revision: last?.record_revision ?? revision, entryId: last?.entry_id ?? '' },
    },
  };
}

/** The multi-revision form keeps the same first-slice answer rule as an ordinary mutation. */
export async function projectRepairWindow(
  deps: SettleDeps,
  own: OwnRecords,
  window: NonNullable<OwnRecords['repairWindow']>,
  { stop, projectPage }: { readonly stop: () => boolean; readonly projectPage: ProjectRepairPage },
): Promise<RepairProjection> {
  const retired = readScope(deps.sql)?.status === 'retired';
  let entries = recordsBehindAmong(deps.sql, own.first);
  let after = window.firstAfter;
  let more = own.first.length === PROJECTION_BATCH;
  let failed = 0;
  let written = 0;
  const next = (): EntryRow[] =>
    recordsInRepairWindow(deps.sql, {
      fromRevision: window.fromRevision,
      throughRevision: own.revision,
      after,
      limit: PROJECTION_BATCH,
    });
  for (;;) {
    if (entries.length > 0) {
      const page = await projectPage(
        deps,
        entries,
        { retired, wanted: own.wanted, carried: own.carried },
        stop,
      );
      failed += page.failed;
      written += page.written;
      if (page.reached < entries.length) return { failed, written, cut: true };
      if (more && stop()) return { failed, written, cut: next().length > 0 };
    }
    if (!more) return { failed, written, cut: false };
    entries = next();
    const last = entries.at(-1);
    if (last !== undefined) after = { revision: last.record_revision, entryId: last.entry_id };
    more = entries.length === PROJECTION_BATCH;
  }
}
