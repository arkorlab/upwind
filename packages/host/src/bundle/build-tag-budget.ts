import { MAX_MANIFEST_BYTES, type RouteCache } from '@stayingupwind/core/manifest';

/** A list container and each object beside its strings; larger than the manifest's object charge. */
const CONTAINER_BYTES = 128;
/** At most six JSON escape bytes and two retained string bytes per UTF-16 code unit. */
const CHARACTER_BYTES = 8;

/** A bounded amount of optional membership, admitted while routes are collected, before cloning. */
export class BuildTagBudget {
  #remaining = MAX_MANIFEST_BYTES;

  /** Keep a whole membership only when its conservative byte/object charge fits what remains. */
  fit(cache: RouteCache): RouteCache {
    const tags = cache.buildTags;
    if (tags === undefined) {
      return cache;
    }
    let bytes = CONTAINER_BYTES;
    for (const tag of tags) {
      bytes += CONTAINER_BYTES + CHARACTER_BYTES * (tag.kind.length + tag.value.length);
      if (bytes > this.#remaining) {
        break;
      }
    }
    if (bytes > this.#remaining) {
      const without = { ...cache };
      delete without.buildTags;
      return without;
    }
    this.#remaining -= bytes;
    return cache;
  }
}
