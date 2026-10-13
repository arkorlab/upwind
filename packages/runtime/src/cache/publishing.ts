import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';

import type { CapturedRender } from './capture.ts';
import { nowMs } from './clock.ts';
import { entryIdOf } from './current.ts';
import type { AttemptReason } from './host.ts';
import { JUDGED_REASONS } from './lease.ts';
import type { CacheRuntime, Publishing } from './runtime.ts';
import { refusedTags } from './tag-bounds.ts';

/**
 * The renders this isolate is publishing as their entries' next generations, answering the
 * isolate's requests that would regenerate those entries meanwhile (`CacheRuntime.publishing`):
 * the page every request after a publish is answered with, already made, where the lease the
 * publish holds would have the host turn each of those requests away to a page of its own.
 *
 * A render answers only while the isolate's view of the tags says nothing it missed
 * (`unmovedSince`), and only by a view no older than the isolate holds any it judges by: within a
 * hold of the pull the render read against, without a word to the host (`answeringAtOnce`); past
 * it, once the host has turned the request away for a lease of the entry and the view has been
 * brought up to the host's (`answeringWhileBusy`). Once the publish has let go of its lease — the
 * host committed it while the answer was on its way here — by the host's word that the generation it
 * holds is the one the render became, and while no mark on the render's tags says what that word
 * could not (`answeringWhenSuperseded`) — and from then on only so (`lettingGo`).
 *
 * Only a regeneration a judgement of the entry asked for (`JUDGED_REASONS`) is answered so: one
 * that asked for a page to answer with. `revalidate()` and an invalidation ask for a render whatever
 * the entry holds, and one made before they asked is not it — they ask the host, and a lease that
 * has come free is theirs to take.
 */

/**
 * How long a request the host turned away waits for its pull of the tags before it is answered
 * from a render this isolate is publishing: past it, the request goes on as one turned away does.
 */
const PUBLISHING_PULL_MS = 1000;

/** What a failure says of itself, for the Function's log. */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The id of the entry, as the host derives it, to look its publishing render up by — or nothing
 * where it could not be derived here: a regeneration never throws, and the lease it asks for next
 * says what the entry is.
 */
export async function publishingKeyOf(
  runtime: CacheRuntime,
  descriptor: RouteEntryDescriptor,
): Promise<string | undefined> {
  try {
    return await entryIdOf(runtime, descriptor);
  } catch (error) {
    runtime.log('publishing render not looked for', {
      pathname: descriptor.pathname,
      detail: detail(error),
    });
    return undefined;
  }
}

/**
 * Whether none of the render's tags has a mark at or after the pull the render read against was
 * asked for (`observedAt`): an invalidation in force here that the render's reads may have missed —
 * one this isolate made, in force here before the delta says so (`applyLocal`), or one another read
 * was told of (`syncLocal`). Asks of each tag what `validityOf` asks of an entry made at that
 * moment. A mark from before the pull was asked for is one the pull brought or the view already
 * held, and the render's reads were judged against it.
 */
function unmarkedSince(runtime: CacheRuntime, publishing: Publishing): boolean {
  return runtime.tags.validityOf(publishing.tags, publishing.observedAt, nowMs()) === 'fresh';
}

/**
 * Whether nothing the view of the tags has taken in since the render's reads were judged says the
 * render missed an invalidation: the scope's delta has brought nothing since the pull the render
 * read against (`observedTagRevision`), and no mark on a tag of the render says so
 * (`unmarkedSince`) — which is what the first cannot see.
 */
function unmovedSince(runtime: CacheRuntime, publishing: Publishing): boolean {
  return (
    runtime.tags.revision <= publishing.observedTagRevision && unmarkedSince(runtime, publishing)
  );
}

/**
 * The render this isolate is publishing of the entry, for a regeneration a judgement asked for, while
 * its publish holds its lease: not one let go of (`CacheRuntime.letGo`).
 */
function publishingFor(
  runtime: CacheRuntime,
  reason: AttemptReason,
  entryId: string | undefined,
): Publishing | undefined {
  const publishing =
    entryId === undefined || !JUDGED_REASONS.has(reason)
      ? undefined
      : runtime.publishing.get(entryId);
  return publishing === undefined || runtime.letGo.has(publishing) ? undefined : publishing;
}

/**
 * Mark the render this isolate is publishing of the entry as let go of (`CacheRuntime.letGo`): a
 * lease of the entry has been handed to a request of the isolate, which the host does only once the
 * publish's own lease is free.
 */
export function lettingGo(runtime: CacheRuntime, entryId: string): void {
  const publishing = runtime.publishing.get(entryId);
  if (publishing !== undefined) {
    runtime.letGo.add(publishing);
  }
}

/**
 * The render this isolate is publishing of the entry, where it may answer without asking the host:
 * within a hold of the pull it read against, as the isolate holds every view of the tags it judges
 * by, and while nothing since says it missed an invalidation.
 */
export function answeringAtOnce(
  runtime: CacheRuntime,
  reason: AttemptReason,
  entryId: string | undefined,
): Publishing | undefined {
  const publishing = publishingFor(runtime, reason, entryId);
  if (publishing === undefined || nowMs() - publishing.observedAt >= runtime.holdMs) {
    return undefined;
  }
  return unmovedSince(runtime, publishing) ? publishing : undefined;
}

/** What `promise` settled to, or `otherwise` once `PUBLISHING_PULL_MS` have gone by first. */
async function settledWithin<T>(promise: Promise<T>, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(otherwise);
        }, PUBLISHING_PULL_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A regeneration the host turned away, answered from the render being published where it may be. */
interface Busy {
  readonly kind: 'busy';
  readonly publishing?: CapturedRender;
  /** That render's publish (`Publishing.published`). */
  readonly published?: Promise<unknown>;
}

/** A regeneration the host turned away: why it was asked for, of what, and whose lease stands. */
interface TurnedAway {
  readonly reason: AttemptReason;
  readonly entryId: string | undefined;
  /** The render this isolate kept of the entry when the lease was asked for, let go of or not. */
  readonly kept: Publishing | undefined;
  /** The attempt holding the lease, where the host says (`AttemptOutcome`). */
  readonly holder: string | undefined;
  /** When the holder's lease lapses unless renewed, where the host says. */
  readonly holderUntil: number | undefined;
}

/**
 * The render, where its publish says it became the generation the host named (`generationId`) —
 * waited for a second at the most (`PUBLISHING_PULL_MS`): an answer in flight lands within that,
 * and a render whose lease lapsed has its publish refused — and while no mark on its tags says it
 * missed an invalidation (`unmarkedSince`).
 *
 * The host's word speaks for every invalidation it had recorded when it named the generation: one
 * that reached the generation condemned it (`CurrentSummary.condemned`), and `supersededBy` takes a
 * condemned generation for none. What the word cannot speak for is an invalidation this isolate made
 * that the host had not recorded yet — an `updateTag` racing the lease, in force here at once — or
 * one recorded since that a read here has been told of. The scope's revision moving on says nothing
 * besides: it moves for other tags too, and for invalidations the host's word spoke for.
 */
async function identified(
  runtime: CacheRuntime,
  publishing: Publishing,
  generationId: string,
): Promise<CapturedRender | undefined> {
  const outcome = await settledWithin(publishing.published, undefined);
  return outcome?.kind === 'published' &&
    outcome.generationId === generationId &&
    unmarkedSince(runtime, publishing)
    ? publishing.render
    : undefined;
}

/**
 * The generation the host named when it handed out the lease it turned the regeneration away for:
 * where that is a lease this isolate gave back unused (`answeringWhenSuperseded`), and the
 * regeneration one a judgement of the entry asked for (`JUDGED_REASONS`).
 */
function givenBackFor(runtime: CacheRuntime, { reason, holder }: TurnedAway): string | undefined {
  return holder === undefined || !JUDGED_REASONS.has(reason)
    ? undefined
    : runtime.givenBack.get(holder);
}

/**
 * A regeneration the host turned away for a lease of the entry, with the render this isolate is
 * publishing of it: only where the host names the attempt that holds the lease, and it is the
 * publish's own (`Publishing.attemptId`). An attempt that took the entry after the publish's lease
 * lapsed holds it otherwise, and the publish's commit is refused, though the publish may still be
 * out; a host that names no holder has a request it turns away answered as before, with a render of
 * its own.
 * Only once the request's own pull of the tags (`pulled`) has brought the view up to the host's —
 * not another pull's, which a clock reading the same moment could not tell from it — and while
 * nothing it brought says the render missed an invalidation; for a second at the most
 * (`PUBLISHING_PULL_MS`), and only while the lease the host named still stands once that pull is
 * in (`holderUntil`, which it has to say as well): one that lapsed meanwhile may be another
 * attempt's by then.
 *
 * Asked only past a hold of the render's pull (`answeringAtOnce`), which no lease lapses within: the
 * lease was taken before the render, for longer than that.
 *
 * Where the holder is instead a lease this isolate gave back unused once the publish had let go of
 * its own (`answeringWhenSuperseded`), and the host has yet to have it back, the request is answered
 * from the render it kept as the one the lease was handed to is: by the host's word to that request,
 * within a hold of it (`CacheRuntime.givenBack`), and once this request's own pull is in, which
 * brings what the host has recorded since.
 */
export async function answeringWhileBusy(
  runtime: CacheRuntime,
  turnedAway: TurnedAway,
  pulled: Promise<boolean>,
): Promise<Busy> {
  const named = givenBackFor(runtime, turnedAway);
  if (named !== undefined) {
    const { kept } = turnedAway;
    const render =
      kept !== undefined && (await settledWithin(pulled, false))
        ? await identified(runtime, kept, named)
        : undefined;
    return render === undefined ? { kind: 'busy' } : { kind: 'busy', publishing: render };
  }
  const { reason, entryId, holder, holderUntil } = turnedAway;
  const held = publishingFor(runtime, reason, entryId);
  // Not waited for where the view already says the render missed something: a pull only adds to it.
  if (
    entryId === undefined ||
    held === undefined ||
    holder !== held.attemptId ||
    !unmovedSince(runtime, held)
  ) {
    return { kind: 'busy' };
  }
  if (!(await settledWithin(pulled, false))) {
    return { kind: 'busy' };
  }
  // Looked up again: a publish that has settled meanwhile is one the host's answer now speaks for,
  // and one set since is not the one the host named.
  const publishing = runtime.publishing.get(entryId);
  const leaseStands = holderUntil !== undefined && nowMs() < holderUntil;
  return publishing === held && leaseStands && unmovedSince(runtime, publishing)
    ? { kind: 'busy', publishing: publishing.render, published: publishing.published }
    : { kind: 'busy' };
}

/**
 * A regeneration the host leased the entry to, and that a generation the host holds supersedes
 * (`supersededBy`), with the render this isolate kept of the entry when the lease was asked for
 * (`kept`): where that generation is the one the render's own publish committed — the host had
 * committed it, and let go of its lease, while the commit's answer was still on its way here — the
 * render answers, as it answers every request after its publish (`identified`).
 *
 * The lease, given back unused, is kept as given back with the generation the host named
 * (`CacheRuntime.givenBack`): until the host has it back, it turns a request of the entry away for
 * it, and that request is answered as this one is (`answeringWhileBusy`). The render, let go of
 * (`lettingGo`), answers no request at once any more: only as here, or as there.
 */
export async function answeringWhenSuperseded(
  runtime: CacheRuntime,
  kept: Publishing | undefined,
  lease: {
    readonly attemptId: string;
    readonly current?: { readonly generationId: string } | null | undefined;
  },
): Promise<CapturedRender | undefined> {
  const { attemptId, current } = lease;
  if (kept === undefined || current === undefined || current === null) {
    return undefined;
  }
  runtime.givenBack.set(attemptId, current.generationId);
  return identified(runtime, kept, current.generationId);
}

/**
 * `published`, the render it publishes answering the isolate's requests that would regenerate the
 * entry until it has settled, or until the isolate lets go of the render sooner (`publishing`).
 * Never rejects where `published` never does. Not a render whose tags a generation may not carry
 * (`refusedTags`): its publish refuses it before anything is sent, and nothing after it is
 * answered with it.
 */
export async function answeringUntilSettled<T>(
  runtime: CacheRuntime,
  entryId: string,
  own: Publishing,
  published: Promise<T>,
): Promise<T> {
  if (refusedTags(own.tags) !== undefined) {
    return published;
  }
  runtime.publishing.set(entryId, own);
  try {
    return await published;
  } finally {
    // Only where the entry is still this publish's, past its window or not: once the window or the
    // budget has let go of it, a later publish of the entry may have set its own.
    if (runtime.publishing.peek(entryId)?.value === own) {
      runtime.publishing.delete(entryId);
    }
  }
}
