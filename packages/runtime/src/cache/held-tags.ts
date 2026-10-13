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
 * notes, of each tag it is judged under, the latest revision an invalidation of the tag is known at
 * here as it is judged (`TagState.knownRevisionOf`), and the commit says the least of those.
 *
 * A tag no read was judged under is one nothing the render read from the cache was kept under: what
 * was made under it was made afresh, once the pull that brought the view up had answered, and the
 * commit says that revision of it.
 */

/** The render each regeneration runs, with what it holds of its tags (`HeldTags.run`). */
const renders = new AsyncLocalStorage<HeldTags>();

export class HeldTags {
  /** Of each tag a read was judged under, the least revision it was known at as one was. */
  readonly #known = new Map<string, number>();
  /**
   * Whether a read was judged under a tag past as many as `#known` keeps — as many as a generation
   * may carry. A tag not kept is then not known to be one no read was judged under.
   */
  #full = false;

  /** Run `work`, the render, with each read it judges noted here (`judgedValidity`). */
  run<T>(work: () => Promise<T>): Promise<T> {
    return renders.run(this, work);
  }

  /** Note a read judged now under `tags`, by what `state` knows of each. */
  note(state: TagState, tags: readonly string[]): void {
    for (const tag of tags) {
      const known = state.knownRevisionOf(tag);
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
   * What the commit says the render held of each of `values`, the generation's tags: of one a read
   * was judged under, the least revision an invalidation of it was known at as one was; of one none
   * was, `observed`, the revision the view was brought up to before the render. Nothing of a tag it
   * held nothing of: one known at no revision, or one not noted once more were judged under than are
   * kept.
   */
  of(values: readonly string[], observed: number): Readonly<Record<string, number>> {
    const held: [string, number][] = [];
    for (const value of values) {
      const revision = this.#known.get(value) ?? (this.#full ? 0 : observed);
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
