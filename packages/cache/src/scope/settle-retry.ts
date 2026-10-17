import { detailOf, type Logger } from '../logger.ts';
import type { SettleOutcome } from './settle.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';

/**
 * When the alarm comes back for what a settle run left owed (`settlePending`): after a backoff of
 * the runs in a row that failed, which the object counts as each run ends.
 */

const MILLISECONDS_PER_SECOND = 1000;
const MAX_RETRY_SECONDS = 300;

/** A second, doubling with each failure in a row, up to five minutes. */
export function retryDelayMs(failures: number): number {
  return Math.min(2 ** failures, MAX_RETRY_SECONDS) * MILLISECONDS_PER_SECOND;
}

/**
 * When the alarm comes back for what a run left: at once for a rewrite the run cut at its slice
 * while making progress — a record that keeps failing does not hold the rest back — and otherwise
 * after `retryDelayMs` of the runs in a row that failed, or once what is owed comes due, where it
 * waits for a moment (`waitMs`).
 */
export function settleRetryMs(outcome: SettleOutcome, failures: number): number {
  return outcome.continued ? 0 : Math.max(retryDelayMs(failures), outcome.waitMs ?? 0);
}

/** How many settle runs in a row have failed (`countSettleFailures`). */
const META_SETTLE_FAILURES = 'settle_failures';

/**
 * How many settle runs in a row have failed, for the backoff of the alarm that comes back for what
 * a run left owed (`settleRetryMs`): written down as each run ends, forgotten once one owes nothing.
 * A run cut at its slice while making progress is no failure, however many of its records failed.
 * The count is bookkeeping: a failure to write it is logged and let go, and the next run counts again.
 */
export function countSettleFailures(sql: SqlStorage, log: Logger, outcome: SettleOutcome): number {
  let failures = 0;
  try {
    if (!(outcome.failed || outcome.pending)) {
      deleteMeta(sql, META_SETTLE_FAILURES);
      return 0;
    }
    failures =
      outcome.failed && !outcome.continued
        ? Number(readMeta(sql, META_SETTLE_FAILURES) ?? '0') + 1
        : 0;
    writeMeta(sql, META_SETTLE_FAILURES, String(failures));
  } catch (error) {
    log.error('settle outcome not recorded', { detail: detailOf(error) });
  }
  return failures;
}
