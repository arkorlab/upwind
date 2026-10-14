import type { CapturedRender } from './capture.ts';
import { nowMs } from './clock.ts';
import { carriedGeneration, type CurrentGeneration } from './current.ts';
import type { AttemptOutcome, AttemptReason, CurrentSummary } from './host.ts';
import { supersededBy } from './lease.ts';
import { answeringWhileBusy, settledWithin } from './publishing.ts';
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

/** What a regeneration asked a lease for: the entry, and a pull of the tags it may ask for now. */
interface Asked {
  readonly entryId: string | undefined;
  readonly pull: () => Promise<boolean>;
}

/** The judgement a regeneration asked a lease for, as `supersededBy` weighs it. */
interface Judged {
  readonly reason: AttemptReason;
  readonly replaces?: string | null | undefined;
}

/** Whether `render` is one a visitor may be answered with as it says (`servable`). */
function servableRender(render: CapturedRender | undefined): render is CapturedRender {
  return render !== undefined && servable(render.status, render.headers);
}

/**
 * A later generation than the one the request judged that the host holds (`supersededBy`), from
 * the record its answer for the lease carried (`carriedGeneration`): what the request is answered
 * with where this isolate holds no render of it to answer with — another isolate published it, and
 * neither KV nor the data center's copies have it yet — rather than a page of the visitor's own,
 * which no other request is answered with. Judged as a record read is, by this isolate's view of
 * the tags once a pull asked for now is in, a second at the most: the host's answer speaks for
 * every invalidation it had recorded by then (`CurrentSummary.condemned`), and the pull for one
 * recorded since. None where no record came back, nothing being asked for then, or where the pull
 * did not come in.
 */
export async function laterCarried(
  runtime: CacheRuntime,
  asked: Asked,
  target: Judged,
  lease: AttemptOutcome,
): Promise<CurrentGeneration | undefined> {
  const { current, record } = lease;
  if (
    record === undefined ||
    current === undefined ||
    current === null ||
    asked.entryId === undefined ||
    !supersededBy(target, current, nowMs()) ||
    !answerable(current) ||
    !(await settledWithin(asked.pull(), false))
  ) {
    return undefined;
  }
  return carriedGeneration(
    runtime,
    asked.entryId,
    { record, generationId: current.generationId },
    nowMs(),
  );
}

/**
 * A regeneration the host leased the entry to that a later generation supersedes, answered from the
 * render of it this isolate published where one may answer (`answeringWhenSuperseded`), or else
 * with that generation, where the host's answer carried its record (`laterCarried`).
 */
export async function supersededWith(
  runtime: CacheRuntime,
  target: Judged,
  lease: AttemptOutcome,
  asked: Asked & { readonly ours: CapturedRender | undefined },
): Promise<{
  readonly kind: 'superseded';
  readonly publishing?: CapturedRender | undefined;
  readonly current?: CurrentGeneration | undefined;
}> {
  const { ours } = asked;
  return servableRender(ours)
    ? { kind: 'superseded', publishing: ours }
    : {
        kind: 'superseded',
        publishing: ours,
        current: await laterCarried(runtime, asked, target, lease),
      };
}

/**
 * A regeneration the host turned away (`answeringWhileBusy`): answered from the render this isolate
 * is publishing where one may answer, or else with a later generation the host holds whose record
 * its answer carried (`laterCarried`).
 */
export async function turnedAway(
  runtime: CacheRuntime,
  target: Judged,
  lease: Extract<AttemptOutcome, { readonly kind: 'busy' }>,
  asked: Asked,
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
  return servableRender(busy.publishing)
    ? busy
    : { ...busy, current: await laterCarried(runtime, asked, target, lease) };
}
