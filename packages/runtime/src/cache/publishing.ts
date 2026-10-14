import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';

import type { CapturedRender } from './capture.ts';
import { nowMs } from './clock.ts';
import { entryIdOf } from './current.ts';
import type { AttemptReason, CurrentSummary } from './host.ts';
import { JUDGED_REASONS, namesStanding } from './lease.ts';
import type { CacheRuntime, GivenBack, Publishing } from './runtime.ts';
import { refusedTags } from './tag-bounds.ts';

/**
 * The renders this isolate is publishing as their entries' next generations, answering the
 * isolate's requests that would regenerate those entries meanwhile (`CacheRuntime.publishing`):
 * the page every request after a publish is answered with, already made, where the lease the
 * publish holds would have the host turn each of those requests away to a page of its own.
 *
 * A render answers only while the isolate's view of the tags says nothing it missed, and only where
 * its commit says it held each of its tags through the view it read against (`unmovedSince`), and
 * only by a view no older than the isolate holds any it judges by: within a hold of the pull the
 * render read against, without a word to the host (`answeringAtOnce`); past it, once the host has
 * turned the request away for a lease of the entry and the view has been brought up to the host's
 * (`answeringWhileBusy`). Once the publish has let go of its lease — the host committed it while
 * the answer was on its way here — by the host's word that the generation it holds is the one the
 * render became, and while no mark on the render's tags says what that word could not
 * (`answeringWhenSuperseded`) — and from then on only so (`lettingGo`).
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
 * held, and the render's reads were judged against it; so is one recorded at or before the revision
 * the pull brought the view to (`observedTagRevision`), whenever it says it was made — the
 * invalidation that sent the request here, recorded by the host as the pull was on its way, say.
 */
function unmarkedSince(runtime: CacheRuntime, publishing: Publishing): boolean {
  return (
    runtime.tags.validityOf(
      publishing.tags,
      publishing.observedAt,
      nowMs(),
      publishing.observedTagRevision,
    ) === 'fresh'
  );
}

/**
 * Whether the render held each of its tags through the revision its view was brought up to, as its
 * commit says (`Publishing.held`). One it held through less is one its reads may have missed an
 * invalidation of: the view had let go of the tag's mark, and what it read of the tag was behind
 * it. Nothing this isolate holds may say so — it let go of that mark — and the host may refuse the
 * commit for it: the render answers no one in the meantime.
 */
function heldThroughView(publishing: Publishing): boolean {
  const { held, observedTagRevision } = publishing;
  return publishing.tags.every(
    (tag) => held.revisionOf(tag, observedTagRevision) >= observedTagRevision,
  );
}

/**
 * Whether nothing says the render missed an invalidation while its commit is out: it held each of
 * its tags through the view it read against (`heldThroughView`), the scope's delta has brought
 * nothing since the pull the render read against (`observedTagRevision`), and no mark on a tag of
 * the render says so (`unmarkedSince`) — which is what the second cannot see.
 */
function unmovedSince(runtime: CacheRuntime, publishing: Publishing): boolean {
  return (
    heldThroughView(publishing) &&
    runtime.tags.revision <= publishing.observedTagRevision &&
    unmarkedSince(runtime, publishing)
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
export async function settledWithin<T>(promise: Promise<T>, otherwise: T): Promise<T> {
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
  /** The attempt holding the lease, where the host says (`AttemptOutcome`). */
  readonly holder: string | undefined;
  /** When the holder's lease lapses unless renewed, where the host says. */
  readonly holderUntil: number | undefined;
  /** The entry's current generation as the host held it when it turned the regeneration away. */
  readonly current: CurrentSummary | null | undefined;
}

/**
 * The lease the host turned the regeneration away for, as this isolate gave it back (`GivenBack`):
 * where it is one the isolate gave back unused (`givingBack`), and the regeneration is one a
 * judgement of the entry asked for (`JUDGED_REASONS`).
 */
function givenBackFor(
  runtime: CacheRuntime,
  { reason, holder }: TurnedAway,
): GivenBack | undefined {
  return holder === undefined || !JUDGED_REASONS.has(reason)
    ? undefined
    : runtime.givenBack.get(holder);
}

/** Whether the lease the host turned a regeneration away for stands yet, as it said (`holderUntil`). */
function leaseStands({ holderUntil }: TurnedAway): boolean {
  return holderUntil !== undefined && nowMs() < holderUntil;
}

/**
 * A regeneration the host turned away for a lease of the entry, with the render this isolate is
 * publishing of it: only where the host names the attempt that holds the lease, and it is the
 * publish's own (`Publishing.attemptId`). An attempt that took the entry after the publish's lease
 * lapsed holds it otherwise, and the publish's commit is refused, though the publish may still be
 * out; a host that names no holder has a request it turns away answered as before, with a render of
 * its own.
 * Only once a pull of the tags this request asked for as the host's answer came in (`pull`) has
 * brought the view up to the host's — not another pull's, which a clock reading the same moment
 * could not tell from it, nor one asked for before the lease was, which may have answered before
 * an invalidation the host recorded ahead of its answer — and while nothing it brought says the
 * render missed an invalidation; for a second at the most (`PUBLISHING_PULL_MS`), and only while the
 * lease the host named still stands once that pull is in (`holderUntil`, which it has to say as
 * well): one that lapsed meanwhile may be another attempt's by then.
 *
 * Asked only past a hold of the render's pull (`answeringAtOnce`), which no lease lapses within: the
 * lease was taken before the render, for longer than that.
 *
 * Where the holder is instead a lease this isolate gave back unused once the publish had let go of
 * its own (`givingBack`), which the host had yet to have back, the request is answered as the one
 * the lease was handed to is, from the render kept with the lease, its publish settled or not: by
 * the host's word to that request (`CacheRuntime.givenBack`), where its word to this one does not
 * name another generation current, or the same one condemned since (`namesStanding`); and once
 * this request's own pull is in, asked for as that word came in and waited for beside the render's
 * publish (`answeringAsNamed`), which brings what the host has recorded since — and only while that
 * word stands by then, as above: past the moment the host said the lease lapses (`holderUntil`),
 * it speaks for it no more.
 * The lease's return, which lets another attempt take the entry before that, keeps no request from
 * the render. The host names the lease only while it holds it, so no request asked once a later
 * generation was published is turned away for it, and a visitor answered with that generation is
 * not answered with this render after it; a render of the request's own would be one no other
 * request was answered with.
 */
export async function answeringWhileBusy(
  runtime: CacheRuntime,
  turnedAway: TurnedAway,
  pull: () => Promise<boolean>,
): Promise<Busy> {
  const givenBack = givenBackFor(runtime, turnedAway);
  if (givenBack !== undefined) {
    const render = namesStanding(turnedAway.current, givenBack.generationId, nowMs())
      ? await answeringAsNamed(runtime, givenBack.publishings, givenBack.generationId, pull)
      : undefined;
    return render === undefined || !leaseStands(turnedAway)
      ? { kind: 'busy' }
      : { kind: 'busy', publishing: render };
  }
  const { reason, entryId, holder } = turnedAway;
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
  if (!(await settledWithin(pull(), false))) {
    return { kind: 'busy' };
  }
  // Looked up again: a publish that has settled meanwhile is one the host's answer now speaks for,
  // and one set since is not the one the host named.
  const publishing = runtime.publishing.get(entryId);
  return publishing === held && leaseStands(turnedAway) && unmovedSince(runtime, publishing)
    ? { kind: 'busy', publishing: publishing.render, published: publishing.published }
    : { kind: 'busy' };
}

/**
 * A regeneration the host leased the entry to, and that a generation the host holds supersedes
 * (`supersededBy`), with the renders this isolate kept of the entry (`kept`) — the one it keeps once
 * the lease is in, and the one it kept when the lease was asked for, where they differ: where that
 * generation is the one a render's own publish committed — the host had committed it, and let go of
 * its lease, while the commit's answer was still on its way here — the first such render answers, as
 * it answers every request after its publish (`answeringAsNamed`). Only once a pull of the tags asked
 * for as the lease came in (`pull`) has brought the view up: an invalidation recorded since the host
 * named the generation, which its word cannot speak for, may be in it. The pull and each render are
 * waited for at once, a second at the most; where no render is the generation, nothing more is.
 * A render let go of (`lettingGo`) answers no request at once any more: only as here, or for a
 * request the host turns away for this lease (`givingBack`).
 */
export async function answeringWhenSuperseded(
  runtime: CacheRuntime,
  kept: readonly (Publishing | undefined)[],
  current: { readonly generationId: string } | null | undefined,
  pull: () => Promise<boolean>,
): Promise<CapturedRender | undefined> {
  // Nothing to wait for where there is no generation to name.
  return current === undefined || current === null
    ? undefined
    : answeringAsNamed(runtime, candidatesOf(kept), current.generationId, pull);
}

/**
 * The render of the first of `candidates` whose publish says it became the generation the host
 * named (`generationId`), where, once a pull of the tags asked for now (`pull`) is in as well, no
 * mark on its tags says it missed an invalidation (`unmarkedSince`): an `updateTag` made while
 * another was waited for is one too. The pull and each render are waited for at once, a second at
 * the most (`PUBLISHING_PULL_MS`): an answer in flight lands within that, and a render whose lease
 * lapsed has its publish refused. Where no render is the generation, nothing more is waited for.
 *
 * The host's word speaks for every invalidation it had recorded when it named the generation: one
 * that reached the generation condemned it (`CurrentSummary.condemned`), and `supersededBy` takes a
 * condemned generation for none. What the word cannot speak for is an invalidation this isolate made
 * that the host had not recorded yet — an `updateTag` racing the lease, in force here at once — or
 * one recorded since, which the pull brings. The scope's revision moving on says nothing besides: it
 * moves for other tags too, and for invalidations the host's word spoke for.
 */
async function answeringAsNamed(
  runtime: CacheRuntime,
  candidates: readonly Publishing[],
  generationId: string,
  pull: () => Promise<boolean>,
): Promise<CapturedRender | undefined> {
  // Nothing to wait for where there is no render to answer with.
  if (candidates.length === 0) {
    return undefined;
  }
  // Asked for now, beside the renders' answers: the host's word speaks for what it had recorded
  // when it named the generation, and a pull asked for once that word is in for what it has since.
  const pulled = settledWithin(pull(), false);
  const named = await namedAmong(candidates, generationId);
  if (named === undefined) {
    return undefined;
  }
  // Asked of once both are in: the pull may answer after the renders do.
  return (await pulled) && unmarkedSince(runtime, named) ? named.render : undefined;
}

/** The renders of `kept` there are, each once. */
function candidatesOf(kept: readonly (Publishing | undefined)[]): Publishing[] {
  return [...new Set(kept)].filter((each) => each !== undefined);
}

/**
 * The first of `candidates` whose publish says it became the generation the host named, each waited
 * for at once, a second at the most (`answeringAsNamed`).
 */
async function namedAmong(
  candidates: readonly Publishing[],
  generationId: string,
): Promise<Publishing | undefined> {
  const outcomes = await Promise.all(
    candidates.map((each) => settledWithin(each.published, undefined)),
  );
  return candidates.find((_, index) => {
    const outcome = outcomes[index];
    return outcome?.kind === 'published' && outcome.generationId === generationId;
  });
}

/**
 * The lease a superseded regeneration gives back unused, kept as given back with the renders the
 * isolate kept of the entry (`kept`) and the generation the host named (`CacheRuntime.givenBack`) for
 * as long as the host may name it: until the lease lapses, a hold at the least. Until the host has it back it
 * turns a request of the entry away for it, and that request is answered as the superseded one is
 * (`answeringWhileBusy`), the render's publish settled meanwhile or not — and an answer that turned
 * one away before the host had the lease back may come in after, however long it was on its way.
 * Waits for the lease's return (`returned`), as work of the request's that its end must not cut off.
 * Never rejects.
 */
export async function givingBack(
  runtime: CacheRuntime,
  kept: readonly (Publishing | undefined)[],
  lease: {
    readonly attemptId: string;
    readonly leaseExpiresAt: number;
    readonly current?: { readonly generationId: string } | null | undefined;
  },
  returned: Promise<unknown>,
): Promise<void> {
  const { current } = lease;
  const publishings = candidatesOf(kept);
  if (current !== undefined && current !== null && publishings.length > 0) {
    runtime.givenBack.set(
      lease.attemptId,
      { publishings, generationId: current.generationId },
      Math.max(runtime.holdMs, lease.leaseExpiresAt - nowMs()),
    );
  }
  await returned;
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
