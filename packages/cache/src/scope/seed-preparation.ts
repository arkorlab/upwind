import { RepairPreparationRequired } from './repair-jobs.ts';
import type { TxInput } from './tx.ts';

/** The outer candidate rolls back before draining projection, arming and probing its retry. */
export function deferSeedRepair<T>(
  input: TxInput,
  apply: (next: TxInput, probe: boolean) => T,
): never {
  const accepted = (next: TxInput): TxInput => ({
    ...next,
    now: input.now,
    limits: input.limits,
  });
  throw new RepairPreparationRequired({
    kind: 'repair-start',
    preflight: (next) => {
      apply(accepted(next), true);
    },
    start: (next) => apply(accepted(next), false),
  });
}
