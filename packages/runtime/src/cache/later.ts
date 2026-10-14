import { nowMs } from './clock.ts';
import { carriedGeneration, type CurrentGeneration } from './current.ts';
import type { AttemptOutcome, AttemptReason, CurrentSummary } from './host.ts';
import { supersededBy } from './lease.ts';
import { answeringWhileBusy } from './publishing.ts';
import type { CacheRuntime } from './runtime.ts';
import { servable } from './servable.ts';

/**
 * A later generation than the one a regeneration's request judged, as the host's answer for the
 * lease names it (`supersededBy`) and carries its record (`AttemptOutcome.record`).
 */

/**
 * Whether a visitor may be answered with the generation a lease says stands (`servable`): one whose
 * status the host did not say is not taken to be, so that a regeneration is never given up for a
 * generation that answers no visitor — a redirect that says not where to, say.
 */
export function answerable(current: CurrentSummary | null | undefined): boolean {
  if (current?.status === undefined) {
    return false;
  }
  const location = current.location ?? undefined;
  return servable(current.status, location === undefined ? {} : { location });
}

/**
 * A later generation than the one the request judged that the host holds (`supersededBy`), from
 * the record its answer for the lease carried (`carriedGeneration`): what the request is answered
 * with where this isolate holds no render of it — another isolate published it, and neither KV nor
 * the data center's copies have it yet — rather than a page of the visitor's own, which no other
 * request is answered with. Judged as a record read is, by this isolate's view of the tags as it
 * stands: the host's answer is newer than any read of the record, and speaks for every
 * invalidation it had recorded by then (`CurrentSummary.condemned`).
 */
export async function laterCarried(
  runtime: CacheRuntime,
  entryId: string | undefined,
  target: { readonly reason: AttemptReason; readonly replaces?: string | null | undefined },
  lease: AttemptOutcome,
): Promise<CurrentGeneration | undefined> {
  const { current } = lease;
  const now = nowMs();
  if (
    entryId === undefined ||
    current === undefined ||
    current === null ||
    !supersededBy(target, current, now) ||
    !answerable(current)
  ) {
    return undefined;
  }
  return carriedGeneration(
    runtime,
    entryId,
    { record: lease.record, generationId: current.generationId },
    now,
  );
}

/**
 * A regeneration the host turned away (`answeringWhileBusy`): answered from the render this isolate
 * is publishing where it may be, or else with a later generation the host holds whose record its
 * answer carried (`laterCarried`).
 */
export async function turnedAway(
  runtime: CacheRuntime,
  target: { readonly reason: AttemptReason; readonly replaces?: string | null | undefined },
  lease: Extract<AttemptOutcome, { readonly kind: 'busy' }>,
  asked: { readonly entryId: string | undefined; readonly pull: () => Promise<boolean> },
): Promise<
  Awaited<ReturnType<typeof answeringWhileBusy>> & {
    readonly current?: CurrentGeneration | undefined;
  }
> {
  const busy = await answeringWhileBusy(
    runtime,
    {
      reason: target.reason,
      entryId: asked.entryId,
      holder: lease.attemptId,
      holderUntil: lease.leaseExpiresAt,
      current: lease.current,
    },
    asked.pull,
  );
  return busy.publishing === undefined
    ? { ...busy, current: await laterCarried(runtime, asked.entryId, target, lease) }
    : busy;
}
