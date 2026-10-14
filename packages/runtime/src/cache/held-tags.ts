import { AsyncLocalStorage } from 'node:async_hooks';

import { MAX_TAGS_PER_ENTRY, type Validity } from '@stayingupwind/core/cache';

import { recordValidity, type TagState } from './tags.ts';

/**
 * What a regeneration's render held of each of its tags, for its commit to say
 * (`CommitRequest.heldTagRevisions`): what a host may excuse an invalidation recorded after the
 * lease by, as one the render's reads were judged against.
 *
 * The revision the view of the tags was brought up to before the render (`observedTagRevision`) does
 * not say it of a tag the render read the data cache under. The view keeps so many tags
 * (`MAX_TAGS_HELD`), and its revision stays where it was as it lets one go; a read under a tag it let
 * go of is judged by what the host says of the tag then (`syncLocal`), which may be behind the very
 * invalidation the view was told of — by its cache, or by a record not written yet. So each read
 * notes, of each tag it is judged under, the revision through which what the view knows of the tag
 * is whole as it is judged (`TagState.heldRevisionOf`) — the view's own, unless it let go of a mark
 * of the tag past what it knows of it now — and the commit says the least of those.
 *
 * A tag no read was judged under is one nothing the render read from the cache was kept under: what
 * was made under it was made afresh, once the pull that brought the view up had answered, and the
 * commit says that revision of it.
 *
 * What is noted is what the render's own reads knew, and the commit says no revision of a tag past
 * the view's. A read behind the render's answer — in work it handed to `after()` or `waitUntil` —
 * runs in its context still, and knows what the view holds then, of a tag the render may never have
 * read: the record is closed as the render ends (`close`). A read of the render that knew a mark past
 * the view's revision — the view pulled further meanwhile, or a newer copy of the tags — is held at
 * the view's revision, which is all the commit claims the render was judged against.
 *
 * What the commit says of each tag is what the render answers the isolate's other requests by while
 * its publish is out (`cache/publishing.ts`): one it held through less than the view's revision is
 * one its reads may have missed an invalidation of, which the host may refuse it for.
 */

/** The render each regeneration runs, with what it holds of its tags (`HeldTags.run`). */
const renders = new AsyncLocalStorage<HeldTags>();

export class HeldTags {
  /** Of each tag a read was judged under, the least revision it was held through as one was. */
  readonly #known = new Map<string, number>();
  /**
   * Whether a read was judged under a tag past as many as `#known` keeps — as many as a generation
   * may carry. A tag not kept is then not known to be one no read was judged under.
   */
  #full = false;
  /** Whether the render is over (`close`), past which a read is noted nowhere. */
  #closed = false;

  /** Run `work`, the render, with each read it judges noted here (`judgedValidity`). */
  run<T>(work: () => Promise<T>): Promise<T> {
    return renders.run(this, work);
  }

  /** Note a read judged now under `tags`, by what `state` knows of each. */
  note(state: TagState, tags: readonly string[]): void {
    if (this.#closed) {
      return;
    }
    for (const tag of tags) {
      const known = state.heldRevisionOf(tag);
      const noted = this.#known.get(tag);
      if (noted !== undefined) {
        this.#known.set(tag, Math.min(noted, known));
      } else if (this.#known.size < MAX_TAGS_PER_ENTRY) {
        this.#known.set(tag, known);
      } else {
        this.#full = true;
      }
    }
  }

  /**
   * The render is over: a read from now on — behind its answer, in work it handed to `after()` or
   * `waitUntil` — is none of what it was made from, and is noted nowhere.
   */
  close(): void {
    this.#closed = true;
  }

  /**
   * What the commit says the render held of `value`, never past `observed`, the revision the view
   * was brought up to before the render: of a tag a read was judged under, the least revision it
   * was held through as one was; of one none was, `observed` itself. 0 — nothing — of a tag it held
   * nothing of: one the view knew no part of as it was read, or one not noted once more were judged
   * under than are kept.
   */
  revisionOf(value: string, observed: number): number {
    return Math.min(this.#known.get(value) ?? (this.#full ? 0 : observed), observed);
  }

  /** What the commit says of each of `values`, the generation's tags (`revisionOf`). */
  of(values: readonly string[], observed: number): Readonly<Record<string, number>> {
    const held: [string, number][] = [];
    for (const value of values) {
      const revision = this.revisionOf(value, observed);
      if (revision > 0) {
        held.push([value, revision]);
      }
    }
    return Object.fromEntries(held);
  }
}

/**
 * What `recordValidity` says of a read, noted under the tags it is judged under where the render
 * reading is a regeneration's (`HeldTags`): in the same turn, so that what is noted is what the
 * judgement knew.
 */
export function judgedValidity(
  state: TagState,
  input: Parameters<typeof recordValidity>[1],
): Validity {
  renders.getStore()?.note(state, input.tags);
  return recordValidity(state, input);
}

/** What `TagState.staleAtOf` says of `tags`, noted as `judgedValidity` notes a read. */
export function judgedStaleAt(state: TagState, tags: readonly string[]): number {
  renders.getStore()?.note(state, tags);
  return state.staleAtOf(tags);
}
