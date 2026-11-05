import { detailOf, type Logger } from '../logger.ts';
import {
  finishSettle,
  type OwnRecords,
  projectPending,
  type ProjectionOutcome,
  publishPending,
  type SettleDeps,
  type SettleOutcome,
} from './settle.ts';
import type { Timing } from './timing.ts';

export interface ScopeSettleHost {
  readonly tables: () => boolean;
  readonly deps: () => SettleDeps;
  readonly log: Logger;
  readonly projectStarted: () => void;
  readonly historyStarted: () => void;
  readonly historyWaiting: () => boolean;
  readonly after: (outcome: SettleOutcome) => Promise<void>;
}

/** This callback alone owns the projection's carried values and requested record bytes. */
export function scopeProjection(
  host: ScopeSettleHost,
  from: OwnRecords | null | undefined,
  timing: Timing | undefined,
): () => Promise<ProjectionOutcome> {
  return async () => {
    host.projectStarted();
    timing?.lap('settle-wait');
    if (!host.tables()) return { early: true, failed: false, continued: false };
    try {
      return await projectPending({ ...host.deps(), timing }, from);
    } catch (error) {
      host.log.error('settle projection failed', { detail: detailOf(error) });
      return {
        early: false,
        failed: true,
        continued: false,
        ...(from?.controlTags.projected === false && { controlTagsFailed: true }),
      };
    }
  };
}

async function historyOutcome(
  host: ScopeSettleHost,
  projection: ProjectionOutcome,
  timing: Timing | undefined,
): Promise<SettleOutcome> {
  try {
    return await publishPending(
      { ...host.deps(), timing, othersWaiting: host.historyWaiting },
      projection,
    );
  } catch (error) {
    host.log.error('settle history failed', { detail: detailOf(error) });
    return {
      pending: true,
      failed: true,
      continued: false,
      ...(projection.controlTagsFailed === true && { controlTagsFailed: true }),
    };
  }
}

/** A separate factory keeps queued history from capturing projection-only byte owners. */
export function scopeCompletion(
  host: ScopeSettleHost,
  ended: ((outcome: SettleOutcome) => void) | undefined,
  timing: Timing | undefined,
): (projection: ProjectionOutcome) => Promise<void> {
  return async (projection) => {
    host.historyStarted();
    let outcome: SettleOutcome;
    if (host.tables()) {
      outcome = await historyOutcome(host, projection, timing);
      await finishSettle(outcome, undefined, host.after);
    } else {
      outcome = { pending: false, failed: false, continued: false };
    }
    ended?.(outcome);
  };
}
