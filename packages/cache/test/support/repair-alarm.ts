import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';

import { readRepairJob } from '../../src/scope/repair-jobs.ts';

const MAX_POLLS = 10_000;

/** Run only an active repair's alarms; unrelated retention alarms must keep their own clock. */
export async function withRepairAlarms<T>(
  stub: DurableObjectStub,
  pending: PromiseLike<T>,
): Promise<T> {
  const state: { answer?: { value: T } | { error: unknown } } = {};
  const receiving = (async () => {
    try {
      state.answer = { value: await pending };
    } catch (error) {
      state.answer = { error };
    }
  })();
  for (let index = 0; index < MAX_POLLS && state.answer === undefined; index += 1) {
    const repairing = await runInDurableObject(
      stub,
      (_instance, context) => readRepairJob(context.storage.sql) !== undefined,
    );
    if (repairing) await runDurableObjectAlarm(stub);
    else
      await new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, 0);
      });
  }
  if (state.answer === undefined)
    throw new Error('the mutation did not complete after its repair alarms');
  await receiving;
  if ('error' in state.answer) throw state.answer.error;
  return state.answer.value;
}
