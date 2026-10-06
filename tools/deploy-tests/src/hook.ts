/**
 * The suite's hook, which the deployment is made inside: the harness gives it `NEXT_E2E_TEST_TIMEOUT`
 * and cuts it off there, mid-wait and saying nothing of where. The deploy hook stamps when it began
 * (`ADAPTER_TEST_HOOK_STARTED_MS`, ahead of the build, which spends the same time), and no wait of this
 * tool goes past the end that makes: one that would is ended first, with what it was waiting for.
 */

/**
 * What the hook still does once the deployment is served, taken off its end: the settle, a minute at
 * most (`config.ts`), and the harness's own steps after the URL.
 */
export const AFTER_SERVED_MS = 90_000;

/** When the suite's hook stops waiting for the deployment; none outside a suite's hook. */
export function hookDeadline(env: NodeJS.ProcessEnv): number | undefined {
  const timeout = Number(env['NEXT_E2E_TEST_TIMEOUT']);
  const started = Number(env['ADAPTER_TEST_HOOK_STARTED_MS']);
  return timeout > 0 && started > 0 ? started + timeout - AFTER_SERVED_MS : undefined;
}

/** Whether the suite's hook has reached its end (`hookDeadline`). */
export function hookOver(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

/** The earlier of a wait's own end and the hook's. */
export function withinHook(end: number, deadline: number | undefined): number {
  return Math.min(end, deadline ?? Infinity);
}

/** What aborts at the hook's end, for a call that cannot be left to run on past it. */
export function hookSignal(deadline: number | undefined): AbortSignal | undefined {
  return deadline === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(0, deadline - Date.now()));
}
