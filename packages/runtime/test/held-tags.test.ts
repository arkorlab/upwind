import type { Validity } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import { HeldTags, judgedStaleAt, judgedValidity } from '../src/cache/held-tags.ts';
import type { TagDelta, TagInvalidation } from '../src/cache/host.ts';
import { type TagHost, TagState } from '../src/cache/tags.ts';

/**
 * What a regeneration's commit says its render held of each of its tags (`HeldTags`), against the
 * view of the tags an isolate keeps (`TagState`). The view keeps so many tags and lets the oldest
 * go, its revision staying where it was; a read under a tag it let go of is judged by what the host
 * says of the tag then, which may say nothing yet of the invalidation the view was told of.
 */

/** How many tags a view keeps (`MAX_TAGS_HELD`): one pull bringing more lets the first go. */
const TAGS_HELD = 4096;
/** How many tags a commit says anything of (`MAX_TAGS_PER_ENTRY`). */
const TAGS_NOTED = 1024;
const HOLD_MS = 5000;
const TAG = 'product-1';
/** A tag of the generation no read was judged under. */
const UNREAD = 'listing';
/** The revision `TAG` was invalidated at, at once, and when that took effect. */
const INVALIDATED = 5;
const INVALIDATED_AT = 1000;
/** The revision the delta is read at, past every invalidation it brings. */
const REVISION = 10;
/** When the entry read under `TAG` was made: before its invalidation, which reaches it. */
const MADE = 500;
const NOW = 2000;

/** `count` tags no read of these tests is under. */
function othersOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `other-${String(index)}`);
}

/**
 * A host whose delta brings `TAG`'s invalidation and, after it, one of each of `later` other tags,
 * in one pull; and whose copy of the tags says only `copies` — nothing of any of them, unless a test
 * says, as one read through its cache or before the records are written.
 */
function hostOf(later: number, copies: readonly TagInvalidation[] = []): TagHost {
  const delta: TagDelta = {
    revision: REVISION,
    truncated: false,
    tags: [
      { value: TAG, staleAt: INVALIDATED_AT, hardExpireAt: INVALIDATED_AT, revision: INVALIDATED },
      ...othersOf(later).map((value) => ({ value, staleAt: 900, hardExpireAt: null, revision: 6 })),
    ],
  };
  const past: TagDelta = { revision: REVISION, truncated: false, tags: [] };
  return {
    tagsDelta: (since) => Promise.resolve(since < REVISION ? delta : past),
    getTags: (values) =>
      Promise.resolve({ tags: copies.filter((copy) => values.includes(copy.value)) }),
  };
}

/** What the host's copy says of `TAG`: an invalidation at `revision`, at once from `at`. */
function copyOf(revision: number, at: number): TagInvalidation {
  return { value: TAG, staleAt: at, hardExpireAt: at, revision };
}

/** The view a regeneration brings up before its render, through `host`'s delta. */
async function viewOf(host: TagHost): Promise<TagState> {
  const state = new TagState({ holdMs: HOLD_MS });
  await state.sync(host, NOW, { force: true });
  return state;
}

/** A read of the entry made under `TAG`, as a data cache makes one: its tags synced, then judged. */
async function readUnder(state: TagState, host: TagHost): Promise<Validity> {
  await state.syncLocal(host, [TAG], NOW);
  return judgedValidity(state, { tags: [TAG], timestamp: MADE, now: NOW });
}

describe('what a regeneration says its render held of its tags', () => {
  /**
   * The view stands past the invalidation, but its mark went with the tags the same pull brought
   * after it, and the host's copy says nothing of it yet: the read passes the entry the invalidation
   * reached as fresh, and the commit says nothing of the tag — where the revision the view stands at
   * would have vouched for the invalidation.
   */
  it('vouches for no invalidation of a tag the view let go of, whatever revision the view is at', async () => {
    const host = hostOf(TAGS_HELD);
    const state = await viewOf(host);
    const held = new HeldTags();

    const validity = await held.run(() => readUnder(state, host));

    expect(validity).toBe('fresh');
    expect(state.revision).toBe(REVISION);
    expect(state.knownRevisionOf(TAG)).toBe(0);
    expect(state.heldRevisionOf(TAG)).toBe(0);
    expect(held.of([TAG, UNREAD], state.revision)).toStrictEqual({ [UNREAD]: REVISION });
  });

  /**
   * What the host's copy says of the tag once the view let go of its mark is all the view knows of
   * it: an invalidation from before the one let go of, which the read is judged by, and which is
   * what the commit holds the tag at — until the copy says the one let go of, or a later one.
   */
  it('holds a tag whose mark the view let go of at what the host’s copy says of it', async () => {
    const behind = hostOf(TAGS_HELD, [copyOf(3, 100)]);
    const caughtUp = hostOf(TAGS_HELD, [copyOf(INVALIDATED, INVALIDATED_AT)]);
    const behindState = await viewOf(behind);
    const caughtUpState = await viewOf(caughtUp);
    const behindHeld = new HeldTags();
    const caughtUpHeld = new HeldTags();

    await behindHeld.run(() => readUnder(behindState, behind));
    await caughtUpHeld.run(() => readUnder(caughtUpState, caughtUp));

    expect(behindHeld.of([TAG], REVISION)).toStrictEqual({ [TAG]: 3 });
    expect(caughtUpHeld.of([TAG], REVISION)).toStrictEqual({ [TAG]: REVISION });
  });

  /** A view that let go of nothing of a tag knows the whole of it up to its revision. */
  it('holds a tag whose mark the view kept through the view’s revision', async () => {
    const host = hostOf(TAGS_HELD - 1);
    const state = await viewOf(host);
    const held = new HeldTags();

    const validity = await held.run(() => readUnder(state, host));

    expect(validity).toBe('expired');
    expect(state.heldRevisionOf(TAG)).toBe(REVISION);
    expect(held.of([TAG, UNREAD], state.revision)).toStrictEqual({
      [TAG]: REVISION,
      [UNREAD]: REVISION,
    });
  });

  /** Other reads of the isolate let the mark go between two reads of the render under the tag. */
  it('says the least of what the reads under a tag knew', async () => {
    const host = hostOf(TAGS_HELD - 1);
    const state = await viewOf(host);
    const held = new HeldTags();

    const [first, second] = await held.run(async () => {
      const before = await readUnder(state, host);
      await state.syncLocal(
        host,
        othersOf(TAGS_HELD).map((value) => `elsewhere-${value}`),
        NOW,
      );
      return [before, await readUnder(state, host)];
    });

    expect([first, second]).toStrictEqual(['expired', 'fresh']);
    expect(held.of([TAG], state.revision)).toStrictEqual({});
  });

  it('notes what asking when the tags were last invalidated knew', async () => {
    const kept = hostOf(TAGS_HELD - 1);
    const keptState = await viewOf(kept);
    const lost = hostOf(TAGS_HELD);
    const lostState = await viewOf(lost);
    const keptHeld = new HeldTags();
    const lostHeld = new HeldTags();

    const staleAts = [
      await keptHeld.run(() => Promise.resolve(judgedStaleAt(keptState, [TAG]))),
      await lostHeld.run(() => Promise.resolve(judgedStaleAt(lostState, [TAG]))),
    ];

    expect(staleAts).toStrictEqual([INVALIDATED_AT, 0]);
    expect(keptHeld.of([TAG], REVISION)).toStrictEqual({ [TAG]: REVISION });
    expect(lostHeld.of([TAG], REVISION)).toStrictEqual({});
  });

  /** A read of another request of the isolate, or of another regeneration, is not this render's. */
  it('notes only the reads of its own render', async () => {
    const host = hostOf(TAGS_HELD);
    const state = await viewOf(host);
    const held = new HeldTags();
    const other = new HeldTags();

    await other.run(() => readUnder(state, host));
    await readUnder(state, host);

    expect(held.of([TAG], REVISION)).toStrictEqual({ [TAG]: REVISION });
    expect(other.of([TAG], REVISION)).toStrictEqual({});
  });

  /**
   * Past as many tags as a generation may carry, a tag not noted may be one a read was judged
   * under: it is said to have been held through no revision, and a tag noted keeps what it was.
   */
  it('vouches for no tag it did not note once more were judged under than it keeps', async () => {
    const host = hostOf(TAGS_HELD - 1);
    const state = await viewOf(host);
    const full = new HeldTags();
    const room = new HeldTags();

    full.note(state, [TAG, ...othersOf(TAGS_NOTED)]);
    room.note(state, [TAG, ...othersOf(TAGS_NOTED - 1)]);

    expect(full.of([TAG, UNREAD], REVISION)).toStrictEqual({ [TAG]: REVISION });
    expect(room.of([TAG, UNREAD], REVISION)).toStrictEqual({
      [TAG]: REVISION,
      [UNREAD]: REVISION,
    });
  });
});
