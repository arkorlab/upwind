import { setTimeout as sleepFor } from 'node:timers/promises';

import { ApiError, type Client } from './client.ts';

/**
 * How long a finalize waits for the project's run before it to end, and how often it asks: as long as
 * a deployment may go without moving (`deploy.ts`), since that run is one, and from a few seconds up
 * to a poll's worth of them.
 */
const OTHER_RUN_TIMEOUT_MS = 900_000;
const OTHER_RUN_FIRST_WAIT_MS = 2000;
const OTHER_RUN_MAX_WAIT_MS = 15_000;

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
): Promise<string> {
  const deadline = Date.now() + OTHER_RUN_TIMEOUT_MS;
  let wait = OTHER_RUN_FIRST_WAIT_MS;
  let waited = false;
  for (;;) {
    try {
      return await client.finalize(deploymentId);
    } catch (error) {
      const another = error instanceof ApiError && error.code === 'run_in_progress';
      if (!another || Date.now() + wait > deadline) {
        throw error;
      }
      if (!waited) {
        log('another run of the project is still under way; waiting for it to end');
        waited = true;
      }
      await sleepFor(wait);
      wait = Math.min(wait * 2, OTHER_RUN_MAX_WAIT_MS);
    }
  }
}
