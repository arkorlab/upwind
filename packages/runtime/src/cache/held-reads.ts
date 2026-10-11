import type { Validity } from '@stayingupwind/core/cache';
import { withDeadline } from '@stayingupwind/core/util';

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

/**
 * How long the judgement of a later value — its tags brought up to date — is waited for, past the
 * read of it (`readNewerData`): past it the value first read is answered, as it would have been.
 */
const LATER_JUDGED_WITHIN_MS = 200;

/** `judge` of `value`, given up past `LATER_JUDGED_WITHIN_MS`. */
function judgedInTime(weighing: Weighing, value: HeldValue): Promise<Validity> {
  return withDeadline(weighing.judge(value), LATER_JUDGED_WITHIN_MS, 'a later data value judged');
}

/** How far each state keeps a value from being answered; `unknown` is answered as `fresh` is. */
const SEVERITY: Readonly<Record<Validity, number>> = { fresh: 0, unknown: 0, stale: 1, expired: 2 };

/** A value of the key as a read holds it, and how it stands. */
interface Judged {
  readonly held: HeldValue;
  readonly validity: Validity;
}

/** How a value of the key is judged, and how what the isolate holds of it is read again. */
export interface Weighing {
  readonly judge: (held: HeldValue) => Promise<Validity>;
  /** What the isolate holds of the key now: a write of it still out, or what the host keeps. */
  readonly reread: () => Promise<HeldValue | undefined>;
}

/**
 * What the isolate holds of the key now, judged afresh; `undefined` — a miss — for none, or for
 * none that could be read or judged: never the value something overtook.
 */
async function heldNow(weighing: Weighing): Promise<Judged | undefined> {
  try {
    const now = await weighing.reread();
    return now === undefined
      ? undefined
      : { held: now, validity: await judgedInTime(weighing, now) };
  } catch {
    return undefined;
  }
}

/**
 * The value read, or a later one the host keeps nearer than its read (`readNewerData`) where that
 * one stands no worse — asked only of a value the read found stale or expired: a host whose reads
 * are cached answers with the value a later write replaced for as long as its cache keeps it, and
 * each isolate that judged it so would compute again what another has written. Where something
 * overtook the later value while it was read — a write of the key this isolate began, or a read
 * that found one later still — neither is answered with: what the isolate holds of the key now is,
 * judged afresh, and a miss where it holds none (`undefined`).
 */
export async function laterIfAny(
  runtime: CacheRuntime,
  request: DataReadRequest,
  read: Judged,
  weighing: Weighing,
): Promise<Judged | undefined> {
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
    again = await judgedInTime(weighing, value);
  } catch {
    // The later value could not be judged, or not in time: the one read is answered as it would
    // have been.
    return read;
  }
  if (SEVERITY[again] > SEVERITY[validity]) {
    return read;
  }
  return later.keep() ? { held: value, validity: again } : heldNow(weighing);
}
