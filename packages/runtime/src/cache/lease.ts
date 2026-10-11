import { evaluateFreshness } from '@stayingupwind/core/cache';

import { nowMs } from './clock.ts';
import type { AttemptOutcome, AttemptReason, CurrentSummary } from './host.ts';
import type { CacheRuntime } from './runtime.ts';

/**
 * The lease a regeneration holds on its entry, as the runtime keeps it: beaten while the render and
 * the publish run, given back when the attempt ends without a generation — and given back at once
 * where the generation the host holds is a later one than the request judged (`supersededBy`).
 */

/** What of a regeneration the lease's bookkeeping reads. */
interface LeaseHolder {
  readonly runtime: CacheRuntime;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly target: { readonly descriptor: { readonly pathname: string } };
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A regeneration this runtime refuses itself, under the word the attempt is recorded with.
 *
 * The gateway records whatever word a failure carries (`attemptErrorSchema.code` enumerates none),
 * so a refusal decided here is told apart in the inspector from a render that threw.
 */
export class RegenerationError extends Error {
  readonly code: string;

  constructor(message: string, options: RegenerationErrorOptions) {
    super(message, options);
    this.name = 'RegenerationError';
    this.code = options.code;
  }
}

interface RegenerationErrorOptions extends ErrorOptions {
  readonly code: string;
}

export async function abandon(
  input: LeaseHolder,
  lease: { attemptId: string; fencingToken: number },
  outcome: 'failed' | 'skipped',
  error?: unknown,
): Promise<void> {
  try {
    await input.runtime.host.fail(lease.attemptId, {
      fencingToken: lease.fencingToken,
      outcome,
      // The failure's own word where it has one, so a refusal decided here reads as itself and
      // not as a render that threw; the gateway enumerates none of them.
      ...(error !== undefined && {
        error: {
          code: error instanceof RegenerationError ? error.code : 'render_failed',
          message: detail(error),
        },
      }),
    });
  } catch (error_) {
    input.runtime.log('attempt not ended', { attemptId: lease.attemptId, detail: detail(error_) });
  }
}

/** End the attempt as failed, and say why in the Function's log; what it says is returned. */
export async function giveUp(
  input: LeaseHolder,
  lease: Leased,
  error: unknown,
  began: number,
): Promise<string> {
  await abandon(input, lease, 'failed', error);
  input.runtime.log('regeneration failed', {
    pathname: input.target.descriptor.pathname,
    detail: detail(error),
    elapsedMs: elapsedSince(began),
  });
  return detail(error);
}

/**
 * How long the attempt has held its lease, as the logs of one that came to nothing say: its publish
 * runs behind the answer, within what the runtime gives work handed to it after the response —
 * about 30 s on Workers — and an attempt that ran out of it says nothing of its own. One that took
 * nearly all of that to fail says where the time went. Read off `performance`, as the clock is
 * (`clock.ts`), and never off a clock a test handed the request, which does not move.
 */
export function elapsedSince(began: number): number {
  return Math.round(performance.now() - began);
}

export type Leased = Extract<AttemptOutcome, { kind: 'leased' }>;

/** A third of what is left of the lease, and never so often that the beats are the work. */
const HEARTBEAT_DIVISOR = 3;
const MIN_HEARTBEAT_MS = 5000;

/**
 * Keep the lease while the render, the uploads and the commit run.
 *
 * The host hands a lease out for a fixed time and gives it to someone else when it runs out,
 * and a render of a page with much to fetch plus the uploads of everything it produced can take
 * longer than that. Without a beat, exactly the pages that need the longest to build are the ones
 * whose commit is always refused, and every request for one renders it again from nothing.
 *
 * A beat that fails is not the end of the attempt: the commit is what finds out whether the lease
 * was kept, and it says so in one place.
 */
export function heartbeat(input: LeaseHolder, lease: Leased): () => void {
  const remaining = lease.leaseExpiresAt - nowMs();
  const every = Math.max(Math.floor(remaining / HEARTBEAT_DIVISOR), MIN_HEARTBEAT_MS);
  const beat = async (): Promise<void> => {
    try {
      await input.runtime.host.heartbeat(lease.attemptId, lease.fencingToken);
    } catch (error) {
      input.runtime.log('lease not renewed', {
        attemptId: lease.attemptId,
        detail: detail(error),
      });
    }
  };
  const timer = setInterval(() => {
    // Handed to the runtime rather than left loose: a beat comes behind the response as often as
    // not, since the uploads and the commit do, and it is a request of its own that the isolate
    // may not be torn down in the middle of.
    input.waitUntil(beat());
  }, every);
  return () => {
    clearInterval(timer);
  };
}

/** The reasons a judgement of the entry gave, which a later generation answers as a render would. */
const JUDGED_REASONS: ReadonlySet<AttemptReason> = new Set<AttemptReason>([
  'expired',
  'miss',
  'stale',
]);

/**
 * Whether the host already holds a later generation than the one the request judged — one published
 * by another isolate since this one read the entry — and one that may be served as it stands.
 *
 * A host whose reads are cached answers with the generation a later one replaced, or with none, for
 * as long as its cache keeps that answer. An isolate that read it there judges the entry missing,
 * stale or expired and asks for the lease, which the host hands out: rendered again, the later
 * generation would be replaced by a render of the same thing, and a page asked for again and again
 * would be answered with a different render each time. Given back instead, the request is answered
 * as one that could not have the lease is (`busy`), and the generation the host holds stands.
 *
 * Only for a regeneration a judgement of the entry asked for (`JUDGED_REASONS`), and only where the
 * request said which generation it judged (`replaces`): `revalidate()` asks for a render whatever
 * the entry holds, and an invalidation for one of what it wrote.
 */
export function supersededBy(
  target: { readonly reason: AttemptReason; readonly replaces?: string | null | undefined },
  current: CurrentSummary | null | undefined,
  now: number,
): boolean {
  if (
    current === undefined ||
    current === null ||
    target.replaces === undefined ||
    !JUDGED_REASONS.has(target.reason) ||
    current.generationId === target.replaces
  ) {
    return false;
  }
  const { validity } = evaluateFreshness({
    policy: current.policy,
    cacheTimestamp: current.cacheTimestamp,
    invalidation: current.condemned ?? undefined,
    now,
  });
  // `unknown` is served as `fresh` is (`currentGeneration`).
  return validity === 'fresh' || validity === 'unknown';
}
