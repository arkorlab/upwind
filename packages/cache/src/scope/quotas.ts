/**
 * Per-scope ceilings: a deployment's regenerations are counted per minute, its entries and the
 * bytes it holds against fixed totals, so that one deployment's use cannot crowd out another's on
 * the shared storage and gateway.
 */

const MILLISECONDS_PER_MINUTE = 60_000;

function windowStart(now: number): number {
  return Math.floor(now / MILLISECONDS_PER_MINUTE) * MILLISECONDS_PER_MINUTE;
}

/** Take one regeneration slot in the current minute, or say the minute is full. */
export function takeAttemptSlot(sql: SqlStorage, now: number, limit: number): boolean {
  const start = windowStart(now);
  const used =
    sql
      .exec<{ attempts: number }>(
        `SELECT attempts FROM quota_windows WHERE window_start = ?`,
        start,
      )
      .toArray()[0]?.attempts ?? 0;
  if (used >= limit) {
    return false;
  }
  sql.exec(
    `INSERT INTO quota_windows (window_start, attempts) VALUES (?, 1)
     ON CONFLICT (window_start) DO UPDATE SET attempts = attempts + 1`,
    start,
  );
  return true;
}

/** Windows older than the current one say nothing any more. */
export function pruneQuotaWindows(sql: SqlStorage, now: number): void {
  sql.exec(`DELETE FROM quota_windows WHERE window_start < ?`, windowStart(now));
}
