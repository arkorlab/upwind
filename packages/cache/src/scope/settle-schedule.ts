import { detailOf, type Logger } from '../logger.ts';
import type { SettleRun } from './settle.ts';

/** Projection may advance while history finishes, but neither phase overtakes its own predecessor. */
export interface PhasedSettleRun extends SettleRun {
  readonly projected: Promise<void>;
}

async function afterPrevious(previous: Promise<void>, log: Logger): Promise<void> {
  try {
    await previous;
  } catch (error) {
    // A later run repairs what the previous one left; an error must not poison the chain.
    log.warn('previous settle interrupted', { detail: detailOf(error) });
  }
}

/** This frame alone holds the projection callback, which may own carried value/record bytes. */
async function projectAfter<T extends { readonly early: boolean }>(
  previous: Promise<void>,
  log: Logger,
  project: () => Promise<T>,
  answered: () => void,
): Promise<T> {
  await afterPrevious(previous, log);
  const result = await project();
  if (result.early) answered();
  return result;
}

/** Only the small projection result crosses into the ordered history and retry phase. */
async function finishAfter<T>(
  previous: Promise<void>,
  projection: Promise<T>,
  log: Logger,
  finish: (projection: T) => Promise<void>,
): Promise<void> {
  await afterPrevious(previous, log);
  await finish(await projection);
}

/**
 * Preserve full completion for maintenance while letting the next projection start once this
 * projection is over. `answered` is independent: an AT_ONCE mutation may resolve it before either
 * phase begins, and cannot release the projection fence.
 */
export function chainSettlePhases<T extends { readonly early: boolean }>(
  previous: { readonly projected: Promise<void>; readonly done: Promise<void> },
  log: Logger,
  project: () => Promise<T>,
  finish: (projection: T) => Promise<void>,
): PhasedSettleRun {
  const answer = Promise.withResolvers<undefined>();
  const said = { early: false };
  const answerNow = (): void => {
    said.early = true;
    answer.resolve(undefined);
  };
  const projection = projectAfter(previous.projected, log, project, answerNow);
  const projected = projection.then(() => {});
  const done = finishAfter(previous.done, projection, log, finish);
  // A projection may fail while the previous history is still running. Hear it immediately,
  // while leaving the full run to report that failure after its predecessor has drained.
  void projected.catch(() => {});
  void answer.promise.catch(() => {});
  void done.then(
    () => answer.resolve(undefined),
    (error: unknown) => {
      if (said.early) {
        log.error('settle failed after the answer', { detail: detailOf(error) });
      } else {
        answer.reject(error);
      }
    },
  );
  return { answered: answer.promise, projected, done, answerNow };
}
