import { MAX_TAGS_PER_ENTRY, type RouteEntryDescriptor } from '@stayingupwind/core/cache';

import type { CapturedRender } from './capture.ts';
import { nowMs } from './clock.ts';
import { entryIdOf } from './current.ts';
import { settledWithin } from './pulls.ts';
import type { CacheRuntime, Publishing } from './runtime.ts';

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
 * brought up to the host's (`answeringWhileBusy`).
 */

/**
 * How long a request the host turned away waits for its pull of the tags before it is answered
 * from a render this isolate is publishing: past it, the request goes on as one turned away does.
 */
const PUBLISHING_PULL_MS = 1000;

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
 * Whether nothing the view of the tags has taken in since the render's reads were judged says the
 * render missed an invalidation: the scope's delta has brought nothing since the pull the render
 * read against (`observedTagRevision`), and none of the render's tags has a mark at or after that
 * pull was asked for (`observedAt`). The second is what the first cannot see — an invalidation this
 * isolate made, in force here before the delta says so (`applyLocal`), and one another read was
 * told of (`syncLocal`) — and asks of each tag what `validityOf` asks of an entry made at that
 * moment. A mark from before the pull was asked for is one the pull brought or the view already
 * held, and the render's reads were judged against it.
 */
function unmovedSince(runtime: CacheRuntime, publishing: Publishing): boolean {
  return (
    runtime.tags.revision <= publishing.observedTagRevision &&
    runtime.tags.validityOf(publishing.tags, publishing.observedAt, nowMs()) === 'fresh'
  );
}

/**
 * The render this isolate is publishing of the entry, where it may answer without asking the host:
 * within a hold of the pull it read against, as the isolate holds every view of the tags it judges
 * by, and while nothing since says it missed an invalidation.
 */
export function answeringAtOnce(
  runtime: CacheRuntime,
  entryId: string | undefined,
): CapturedRender | undefined {
  const publishing = entryId === undefined ? undefined : runtime.publishing.get(entryId);
  if (publishing === undefined || nowMs() - publishing.observedAt >= runtime.holdMs) {
    return undefined;
  }
  return unmovedSince(runtime, publishing) ? publishing.render : undefined;
}

/** A regeneration the host turned away, answered from the render being published where it may be. */
interface Busy {
  readonly kind: 'busy';
  readonly publishing?: CapturedRender;
}

/**
 * A regeneration the host turned away for a lease of the entry, with the render this isolate is
 * publishing of it: the publish's own lease, while it is out — one whose lease lapsed has its next
 * call refused, and that ends it. Only once the pull the request asked for at `askedAt` (`synced`)
 * has brought the view of the tags up to the host's, and while nothing it brought says the render
 * missed an invalidation; for a second at the most (`PUBLISHING_PULL_MS`).
 */
export async function answeringWhileBusy(
  runtime: CacheRuntime,
  entryId: string | undefined,
  pull: { readonly synced: Promise<void>; readonly askedAt: number },
): Promise<Busy> {
  const held = entryId === undefined ? undefined : runtime.publishing.get(entryId);
  // Not waited for where the view already says the render missed something: a pull only adds to it.
  if (entryId === undefined || held === undefined || !unmovedSince(runtime, held)) {
    return { kind: 'busy' };
  }
  await settledWithin(pull.synced, PUBLISHING_PULL_MS);
  // Looked up again: a publish that has settled meanwhile is one the host's answer now speaks for.
  const publishing = runtime.publishing.get(entryId);
  if (publishing === undefined || !runtime.tags.syncedSince(pull.askedAt)) {
    return { kind: 'busy' };
  }
  return unmovedSince(runtime, publishing)
    ? { kind: 'busy', publishing: publishing.render }
    : { kind: 'busy' };
}

/**
 * `published`, the render it publishes answering the isolate's requests that would regenerate the
 * entry until it has settled, or until the isolate lets go of the render sooner (`publishing`).
 * Never rejects where `published` never does. Not a render that carries more tags than a generation
 * may: its publish refuses it before anything is sent, and nothing after it is answered with it.
 */
export async function answeringUntilSettled<T>(
  runtime: CacheRuntime,
  entryId: string,
  own: Publishing,
  published: Promise<T>,
): Promise<T> {
  if (own.tags.length > MAX_TAGS_PER_ENTRY) {
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
