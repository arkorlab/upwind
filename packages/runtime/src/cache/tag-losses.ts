import { Lru } from '@stayingupwind/core/util';

/**
 * The marks of tags a view of them has let go of, counted (`count`): of whichever kind — one it was
 * told, at a revision or at none, or one of the isolate's own — since a mark known at no revision
 * says nothing of when it was let go of by the revisions the view knows (`TagState.holdsWhole`).
 * Of each tag, the count it was last let go of at, as many tags as `capacity`; past that many, the
 * count of the ones let go of from here is held against every tag.
 */
export class TagLosses {
  #count = 0;
  #past = 0;
  readonly #at: Lru<string, number>;

  constructor(capacity: number) {
    this.#at = new Lru<string, number>(capacity, (_tag, at) => {
      this.#past = Math.max(this.#past, at);
    });
  }

  /** How many marks of tags have been let go of so far: what `lostSince` is asked against. */
  get count(): number {
    return this.#count;
  }

  /** Count a mark of `tag` let go of. */
  forget(tag: string): void {
    this.#count += 1;
    this.#at.set(tag, this.#count);
  }

  /**
   * Whether a mark of `tag` has been let go of since `since` had been (`count`): what is held of the
   * tag says nothing then of an invalidation that came after that.
   */
  lostSince(tag: string, since: number): boolean {
    return Math.max(this.#at.get(tag) ?? 0, this.#past) > since;
  }
}
