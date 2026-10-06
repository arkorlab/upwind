import { setTimeout as sleepFor } from 'node:timers/promises';

import { ApiError, type Client } from './client.ts';
import { hookOver, withinHook } from './hook.ts';

/**
 * How long a finalize waits for the project's run before it to end, and how often it asks: ten
 * minutes, which leaves the rest of the suite's hook — twenty minutes in the workflow
 * (`NEXT_E2E_TEST_TIMEOUT`) — to the fixture's own build, upload and deployment; and from a few
 * seconds up to a poll's worth of them. The run waited for is the one before, which outlasted the
 * suite's hook or is finishing its last steps, so it has most of its own deployment behind it.
 */
const OTHER_RUN_TIMEOUT_MS = 600_000;
const OTHER_RUN_FIRST_WAIT_MS = 2000;
const OTHER_RUN_MAX_WAIT_MS = 15_000;
const MS_PER_MINUTE = 60_000;

/** Why a finalize stopped waiting for the run before it: the suite's hook came to its end, or the wait did. */
function gaveUp(hookDeadline: number | undefined, refusal: unknown): Error {
  return new Error(
    hookOver(hookDeadline)
      ? "the suite's hook timeout came first; the project's previous run had not ended"
      : `the project's previous run did not end within the ${String(OTHER_RUN_TIMEOUT_MS / MS_PER_MINUTE)} minutes a finalize waits for it`,
    { cause: refusal },
  );
}

/**
 * Finalize, once the project has no other run under way.
 *
 * A host runs one deployment of a project at a time and refuses another while it does
 * (`run_in_progress`), and the run before this one can still be going: the previous fixture's, when
 * its deployment outlasted the suite's hook timeout — the suite stops waiting, the host does not — or
 * when the host finishes a run's last steps after it has said the deployment is live. That run ends on
 * its own, so it is waited for rather than reported as this fixture's failure, which is what it was:
 * eight suites of one run failed this way, each after the one before it had. A finalize made again is
 * safe — it answers with the run that began. The deadline is a run that never ends.
 */
export async function finalizeWhenFree(
  client: Client,
  log: (message: string) => void,
  deploymentId: string,
  hookDeadline?: number,
): Promise<string> {
  const deadline = withinHook(Date.now() + OTHER_RUN_TIMEOUT_MS, hookDeadline);
  let wait = OTHER_RUN_FIRST_WAIT_MS;
  let waited = false;
  for (;;) {
    try {
      return await client.finalize(deploymentId);
    } catch (error) {
      const another = error instanceof ApiError && error.code === 'run_in_progress';
      if (!another) {
        throw error;
      }
      // The whole of the wait is used: the last sleep is cut to the time that is left, and the run is
      // given up on only once none is.
      const left = deadline - Date.now();
      if (left <= 0) {
        throw gaveUp(hookDeadline, error);
      }
      if (!waited) {
        log('another run of the project is still under way; waiting for it to end');
        waited = true;
      }
      await sleepFor(Math.min(wait, left));
      wait = Math.min(wait * 2, OTHER_RUN_MAX_WAIT_MS);
    }
  }
}
