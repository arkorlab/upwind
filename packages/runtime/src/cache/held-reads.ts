import type { Validity } from '@stayingupwind/core/cache';

import { readNewerData } from './data.ts';
import type { HeldValue } from './held-writes.ts';
import type { DataReadRequest } from './host.ts';
import type { CacheRuntime, DataMemo } from './runtime.ts';

/**
 * A value of the data cache as a read holds it, and the later one a read that found it stale or
 * expired takes in its place where the host keeps one nearer than its read (`readNewerData`).
 */

/** What a read the host answered found, as a held value. */
export function heldIn(memo: DataMemo): HeldValue | undefined {
  return memo.kind === 'found'
    ? {
        entry: memo.response.entry,
        bytes: memo.bytes,
        invalidation: memo.response.invalidation,
        revision: memo.response.dependencyRevision,
      }
    : undefined;
}

/** How far each state keeps a value from being answered; `unknown` is answered as `fresh` is. */
const SEVERITY: Readonly<Record<Validity, number>> = { fresh: 0, unknown: 0, stale: 1, expired: 2 };

/**
 * The value read, or a later one the host keeps nearer than its read (`readNewerData`) where that
 * one stands no worse under `judge` — asked only of a value the read found stale or expired: a host
 * whose reads are cached answers with the value a later write replaced for as long as its cache
 * keeps it, and each isolate that judged it so would compute again what another has written.
 */
export async function laterIfAny(
  runtime: CacheRuntime,
  request: DataReadRequest,
  read: { readonly held: HeldValue; readonly validity: Validity },
  judge: (held: HeldValue) => Promise<Validity>,
): Promise<{ readonly held: HeldValue; readonly validity: Validity }> {
  const { held, validity } = read;
  if (SEVERITY[validity] === SEVERITY.fresh || held.revision === undefined) {
    return read;
  }
  const later = await readNewerData(runtime, request, held.revision);
  const value = later === undefined ? undefined : heldIn(later.memo);
  if (later === undefined || value === undefined) {
    return read;
  }
  let again: Validity;
  try {
    again = await judge(value);
  } catch {
    // The later value could not be judged: the one read is answered as it would have been.
    return read;
  }
  // Taken only where it stands no worse, and where nothing overtook it while it was read: a write
  // of the key this isolate began meanwhile, or a read that found one later still.
  if (SEVERITY[again] > SEVERITY[validity] || !later.keep()) {
    return read;
  }
  return { held: value, validity: again };
}
