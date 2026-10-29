import { detailOf, type Logger } from '../logger.ts';
import type { SettleRun } from './settle.ts';

/**
 * Start a run once the one before it is over. Its change waits for `answered`, which comes early
 * when the run says so, or at once when the change does (`answerNow`), and otherwise with the end
 * of the run — or with its failure, so a run that fails before its change has an answer fails the
 * change as well.
 */
export function chainSettle(
  previous: Promise<void>,
  log: Logger,
  run: (answered: () => void) => Promise<void>,
): SettleRun {
  const answer = Promise.withResolvers<undefined>();
  void answer.promise.catch(() => {
    // Not every caller asks for the answer — `tick` waits for `done`, which carries the same
    // failure — and one nobody asked for must not go unhandled.
  });
  const said = { early: false };
  const answerNow = (): void => {
    said.early = true;
    answer.resolve(undefined);
  };
  const done = (async (): Promise<void> => {
    try {
      await previous;
    } catch (error) {
      // What a run waits for is that the one before it is over, not that it went well. Passed
      // on, one failure would fail every later run before it began — and with it every mutation
      // after, each committed and answered as an error — for as long as the object stayed in
      // memory. The run that follows a failure is the one that would repair it.
      log.warn('previous settle interrupted', { detail: detailOf(error) });
    }
    await run(answerNow);
  })();
  const over = async (): Promise<void> => {
    await done;
    answer.resolve(undefined);
  };
  void over().catch((error: unknown) => {
    if (said.early) {
      // The change had its answer; what is still owed, the next run or the alarm settles.
      log.error('settle failed after the answer', { detail: detailOf(error) });
    } else {
      answer.reject(error);
    }
  });
  return { answered: answer.promise, done, answerNow };
}
