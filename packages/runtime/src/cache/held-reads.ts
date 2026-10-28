import type { Validity } from '@stayingupwind/core/cache';
import { withDeadline } from '@stayingupwind/core/util';

import {
  EXPIRED_NEWER_DATA_DEADLINE_MS,
  type LaterData,
  NEWER_DATA_DEADLINE_MS,
  readNewerData,
} from './data.ts';
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
 * `work` — a judgement, or a read of what the isolate holds of the key — given up at `until`, on the
 * isolate's own clock (`performance.now()`), and never begun once that has gone by: `withDeadline`
 * refuses a spent wait at once, but only when it is handed the work, which by then has asked what
 * no read is waiting to hear.
 */
async function inTime<T>(until: number, what: string, work: () => Promise<T>): Promise<T> {
  const remaining = until - performance.now();
  if (remaining <= 0) {
    throw new Error(`${what} past the read's deadline`);
  }
  return withDeadline(work(), remaining, what);
}

/**
 * `judge` of `value` — its tags brought up to date — by `until` (`inTime`): past it the value first
 * read is answered, as it would have been.
 */
function judgedInTime(weighing: Weighing, value: HeldValue, until: number): Promise<Validity> {
  return inTime(until, 'a later data value judged', () => weighing.judge(value));
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
 * What the isolate holds of the key now, judged afresh, by `until`; `undefined` — a miss — for none,
 * or for none that could be read or judged by then: never the value something overtook. Reading it
 * again can go to the host, and so can its judgement's read of the tags: neither is waited for past
 * the read's deadline, past which the render computes the value itself.
 */
async function heldNow(weighing: Weighing, until: number): Promise<Judged | undefined> {
  try {
    const now = await inTime(until, 'the key read again', () => weighing.reread());
    return now === undefined
      ? undefined
      : { held: now, validity: await judgedInTime(weighing, now, until) };
  } catch {
    return undefined;
  }
}

/** A later value read and judged, and how to keep it (`readNewerData`). */
interface Candidate {
  readonly later: LaterData;
  readonly judged: Judged;
}

/**
 * The value read, or a later one the host keeps nearer than its read (`readNewerData`) where that
 * one stands no worse — asked only of a value the read found stale or expired: a host whose reads
 * are cached answers with the value a later write replaced for as long as its cache keeps it, and
 * each isolate that judged it so would compute again what another has written.
 *
 * A host can answer with the nearest value it keeps first — a copy beside its reads — that was
 * written before an invalidation the read already knows of, while a later one stands further off.
 * So where the later value stands no better than stale, one past it is asked for too, once, as a
 * probe that moves nothing of the key until it is kept: where it cannot be read whole or judged in
 * time, or stands worse than the first, the first is kept as it would have been. Where something
 * overtook the value kept — a write of the key this isolate began since the first was asked for, or
 * a read that found one later still — none is answered with: what the isolate holds of the key now
 * is, judged afresh, and a miss where it holds none (`undefined`).
 *
 * All of it by one deadline, set as the read asks past the value it judged: `NEWER_DATA_DEADLINE_MS`
 * past a stale value, `EXPIRED_NEWER_DATA_DEADLINE_MS` past an expired one. Each read and judgement
 * within it is given what is left, and nothing is begun once it has gone — the probe neither, which
 * would be a read no one waits for. A read whose wait runs out is answered as it would have been
 * had nothing later been found: with the value it judged, or, once that was overtaken, a miss.
 */
export async function laterIfAny(
  runtime: CacheRuntime,
  request: DataReadRequest,
  read: Judged,
  weighing: Weighing,
): Promise<Judged | undefined> {
  const until =
    performance.now() +
    (read.validity === 'expired' ? EXPIRED_NEWER_DATA_DEADLINE_MS : NEWER_DATA_DEADLINE_MS);
  const laterThan = async (from: Judged, probing: boolean): Promise<Candidate | undefined> => {
    const { held, validity } = from;
    if (SEVERITY[validity] === SEVERITY.fresh || held.revision === undefined) {
      return undefined;
    }
    const later = await readNewerData(runtime, request, held.revision, { probing, until });
    const value = later === undefined ? undefined : heldIn(later.memo);
    if (later === undefined || value === undefined) {
      return undefined;
    }
    let again: Validity;
    try {
      again = await judgedInTime(weighing, value, until);
    } catch {
      // The later value could not be judged, or not in time: the one held is answered as it would
      // have been.
      return undefined;
    }
    return SEVERITY[again] > SEVERITY[validity]
      ? undefined
      : { later, judged: { held: value, validity: again } };
  };
  const first = await laterThan(read, false);
  if (first === undefined) {
    return read;
  }
  const probe = performance.now() < until ? await laterThan(first.judged, true) : undefined;
  const kept = probe ?? first;
  if (!first.later.standing()) {
    return heldNow(weighing, until);
  }
  return kept.later.keep() ? kept.judged : heldNow(weighing, until);
}
