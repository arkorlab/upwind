import { RepairPreparationRequiredError } from './repair-jobs.ts';
import type { TxInput } from './tx.ts';

/** The outer candidate rolls back before draining projection, arming and probing its retry. */
export function deferSeedRepair(
  input: TxInput,
  apply: (next: TxInput, probe: boolean) => unknown,
): never {
  function accepted(next: TxInput): TxInput {
    return { ...next, now: input.now, limits: input.limits };
  }
  throw new RepairPreparationRequiredError({
    kind: 'repair-start',
    preflight: (next) => {
      apply(accepted(next), true);
    },
    start: (next) => apply(accepted(next), false),
  });
}
