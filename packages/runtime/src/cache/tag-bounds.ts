import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '@stayingupwind/core/cache';

/** Why a generation may not carry a render's tags, in the words its attempt is recorded with. */
export interface TagsRefusal {
  readonly code: string;
  /** What the render left, said after its pathname. */
  readonly message: string;
}

/**
 * Why a generation may not carry these tags, as the contract bounds them, or nothing where it may:
 * more of them than an entry carries (`MAX_TAGS_PER_ENTRY`), or one longer than a tag may be
 * (`MAX_TAG_LENGTH`). The host's schema turns such a commit away with a message that says nothing
 * of tags, so it is said here instead, before anything is sent — and before a render the commit
 * would refuse is kept to answer for its entry (`answeringUntilSettled`).
 */
export function refusedTags(values: readonly string[]): TagsRefusal | undefined {
  if (values.length > MAX_TAGS_PER_ENTRY) {
    return {
      code: 'too_many_tags',
      message: `left ${values.length} cache tags on the entry; a generation may carry ${MAX_TAGS_PER_ENTRY}`,
    };
  }
  const long = values.find((value) => value.length > MAX_TAG_LENGTH);
  return long === undefined
    ? undefined
    : {
        code: 'tag_too_long',
        message: `left a cache tag of ${long.length} characters on the entry; a tag may have ${MAX_TAG_LENGTH}`,
      };
}
