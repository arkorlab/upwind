import { describe, expect, it } from 'vitest';

import type { TagDelta, TagInvalidations } from '../src/cache/host.ts';
import { type TagHost, type TagMark, TagState } from '../src/cache/tags.ts';

/**
 * How an isolate judges a data-cache entry against the invalidations it knows of.
 *
 * The authority retains each deadline that still changes an older value's validity, bounded per
 * tag. A later SWR invalidation must not reopen a window on data an earlier one already expired.
 */

/** 2026-09-20T00:00:00Z */
const T0 = 1_789_862_400_000;
const SECOND = 1000;
const SIXTY = 60;
const MINUTE = SIXTY * SECOND;
const HOLD_MS = 5 * SECOND;

function tagState(): TagState {
  return new TagState({ holdMs: HOLD_MS });
}

/**
 * Two invalidations of one tag that say less each than the other of some entry: a `revalidateTag`,
 * and an `updateTag` stamped earlier, whose deadline reaches the entries made before it.
 */
const SOFT = { staleAt: T0 + 2 * SECOND, hardExpireAt: null };
const HARD = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
const EITHER_ORDER = [
  [SOFT, HARD],
  [HARD, SOFT],
] as const;

/** Two invalidations a delta brings, as a host that says no revision of a mark has them. */
const HOME = { value: 'home', staleAt: T0 + SECOND, hardExpireAt: null };
const FEED = { value: 'feed', staleAt: T0 + SECOND, hardExpireAt: null };

describe('the tag view', () => {
  it('leaves an entry made after the invalidation alone, however long its window', () => {
    const tags = tagState();

    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });

    // The render that made this entry read what the invalidation had already changed.
    expect(tags.validityOf(['home'], T0 + SECOND, T0 + MINUTE + SECOND)).toBe('fresh');
  });

  it('holds an entry it reached stale until the window runs out, then expired', () => {
    const tags = tagState();

    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });

    expect(tags.validityOf(['home'], T0 - SECOND, T0 + MINUTE - SECOND)).toBe('stale');
    expect(tags.validityOf(['home'], T0 - SECOND, T0 + MINUTE)).toBe('expired');
  });

  it('judges by the latest invalidation, not by the halves of two', () => {
    const tags = tagState();
    const made = T0 + MINUTE;

    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + 2 * MINUTE });
    tags.applyLocal(['home'], { staleAt: T0 + 3 * MINUTE, hardExpireAt: T0 + 8 * MINUTE });

    // An entry made between the two: the second reached it, and its window is the one that ends.
    expect(tags.validityOf(['home'], made, T0 + 4 * MINUTE)).toBe('stale');
    expect(tags.validityOf(['home'], made, T0 + 8 * MINUTE)).toBe('expired');
  });

  it('reaches an entry made in the same millisecond as the invalidation', () => {
    const tags = tagState();

    // A Worker's clock moves only when I/O completes: a write and the update after it, with no
    // I/O between them, are stamped with the same moment.
    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 });
    tags.applyLocal(['feed'], { staleAt: T0, hardExpireAt: T0 + MINUTE });

    expect(tags.validityOf(['home'], T0, T0)).toBe('expired');
    expect(tags.validityOf(['feed'], T0, T0)).toBe('stale');
    expect(tags.validityOf(['home', 'feed'], T0 + 1, T0 + 1)).toBe('fresh');
  });

  it('settles two invalidations recorded in the same millisecond by the earlier deadline', () => {
    const tags = tagState();

    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + 8 * MINUTE });
    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });

    expect(tags.validityOf(['home'], T0 - SECOND, T0 + MINUTE)).toBe('expired');
  });

  /**
   * The host stamps an invalidation by its own clock as it records it, and a pull asked for a moment
   * before can still bring it: an entry made against the view that pull brought up was made knowing
   * of it, whatever its time says.
   */
  it('counts an invalidation recorded at or before the revision an entry was made against as known to it', () => {
    const tags = tagState();

    const call = tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });
    tags.confirmLocal(
      'home',
      { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND, revision: 5 },
      call,
    );

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 4)).toBe('expired');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
  });

  it('knows a mark the delta brought at the revision that page of it was read at', async () => {
    const tags = tagState();
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: null }],
          revision: 7,
          truncated: false,
        });
      },
    };

    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 7)).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 6)).toBe('stale');
  });

  it('knows its own invalidation at no revision until the host has answered it', () => {
    const tags = tagState();
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };

    const call = tags.applyLocal(['home'], applied);
    const unanswered = tags.validityOf(['home'], T0, T0 + MINUTE, 5);
    tags.confirmLocal('home', { ...applied, revision: 5 }, call);

    expect(unanswered).toBe('expired');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
  });

  /**
   * A moment two marks read is no proof they are one invalidation: one of this isolate's the host
   * has yet to answer is held against a view whatever revision it was brought up to.
   */
  it('hides no invalidation of its own the host has yet to answer behind one of the same moment it knows the revision of', () => {
    const tags = tagState();
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
    const call = tags.applyLocal(['home'], applied);
    tags.confirmLocal('home', { ...applied, revision: 5 }, call);

    tags.applyLocal(['home'], applied);

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('expired');
  });

  /**
   * Each part of what is known of a tag is asked of on its own: what a read was told at no revision,
   * from before the entry was made, keeps nothing from a later invalidation of its own that the
   * entry's view held.
   */
  it('asks nothing of a part of what it knows of a tag from before an entry, whatever its revision', async () => {
    const tags = tagState();
    const { host } = hostSaying('home', { staleAt: T0 - SECOND, hardExpireAt: null });
    await tags.syncLocal(host, ['home'], T0);
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
    const call = tags.applyLocal(['home'], applied);

    tags.confirmLocal('home', { ...applied, revision: 5 }, call);

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
  });

  /**
   * Two of its own out at once, of one moment: an answer takes out the call it answers, and what the
   * calls out applied stays in force at no revision until both have been answered; what is known of
   * the tag stands at their revisions then.
   */
  it('knows two of its own invalidations of one moment at a revision once both have been answered', () => {
    const tags = tagState();
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
    const first = tags.applyLocal(['home'], applied);
    const second = tags.applyLocal(['home'], {
      staleAt: T0 + SECOND,
      hardExpireAt: T0 + 2 * SECOND,
    });

    tags.confirmLocal('home', { ...applied, revision: 5 }, first);
    const oneAnswered = tags.validityOf(['home'], T0, T0 + MINUTE, 6);
    tags.confirmLocal('home', { ...applied, revision: 6 }, second);

    expect(oneAnswered).toBe('expired');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 6)).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('expired');
  });

  /**
   * An answer of the host's to an earlier invalidation, stamped by a clock that reads ahead, is not
   * taken for newer than one of this isolate's still out: the `updateTag` keeps its deadline.
   */
  it('keeps an invalidation of its own still out in force, though the host answers an earlier one at a later moment', () => {
    const tags = tagState();
    const earlier = tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });
    tags.applyLocal(['home'], { staleAt: T0 + 1, hardExpireAt: T0 + 1 });

    tags.confirmLocal(
      'home',
      { staleAt: T0 + 5 * SECOND, hardExpireAt: T0 + 5 * SECOND + MINUTE, revision: 5 },
      earlier,
    );

    expect(tags.validityOf(['home'], T0 - SECOND, T0 + 2 * SECOND)).toBe('expired');
  });

  /**
   * One of its own the host never answered stays in force at no revision, and holds back only an
   * entry it reaches: a later one the host answered is known at its revision all the same.
   */
  it('knows a later invalidation of its own at its revision after one the host never answered', () => {
    const tags = tagState();
    tags.settleLocal(
      tags.applyLocal(['home'], { staleAt: T0 - SECOND, hardExpireAt: T0 - SECOND }),
    );
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
    const call = tags.applyLocal(['home'], applied);

    tags.confirmLocal('home', { ...applied, revision: 5 }, call);

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
    expect(tags.validityOf(['home'], T0 - 2 * SECOND, T0 + MINUTE, 5)).toBe('expired');
  });

  it('counts a tag named twice in one invalidation of its own once', () => {
    const tags = tagState();
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
    const call = tags.applyLocal(['home', 'home'], applied);

    tags.confirmLocal('home', { ...applied, revision: 5 }, call);

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
  });

  it('settles a tag of its own invalidation the host recorded nothing of at no revision', () => {
    const tags = tagState();
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
    const call = tags.applyLocal(['home', 'feed'], applied);

    tags.answerLocal(
      call,
      { revision: 5, invalidations: [{ value: 'home', ...applied }] },
      T0 + SECOND,
    );
    const later = { staleAt: T0 + 2 * SECOND, hardExpireAt: T0 + 2 * SECOND };
    tags.confirmLocal('feed', { ...later, revision: 6 }, tags.applyLocal(['feed'], later));

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
    // The first is held against the entry at no revision; the second is known at its own.
    expect(tags.validityOf(['feed'], T0, T0 + MINUTE, 6)).toBe('expired');
    expect(tags.validityOf(['feed'], T0 + 1500, T0 + MINUTE, 6)).toBe('fresh');
  });

  it('asks nothing of an older mark a read was told at no revision beside a later one the delta brought', async () => {
    const tags = tagState();
    const { host } = hostSaying('home', { staleAt: T0 - SECOND, hardExpireAt: null });
    await tags.syncLocal(host, ['home'], T0);
    const delta: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: null, revision: 5 }],
          revision: 5,
          truncated: false,
        });
      },
    };

    await tags.sync(delta, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('fresh');
  });

  /**
   * Recorded past the revision an entry's view was brought up to, an invalidation is one that view
   * missed, though a clock that reads behind stamped it before the entry was made.
   */
  it('holds an invalidation known past the revision an entry was made against against it, whatever its time', async () => {
    const tags = tagState();
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 - SECOND, hardExpireAt: T0 - SECOND, revision: 11 }],
          revision: 11,
          truncated: false,
        });
      },
    };

    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 10)).toBe('expired');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 11)).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('fresh');
  });

  /** A host that says no revision of a mark: what it says is known at none, whatever came with it. */
  it('knows a mark a read was told at no revision at none, though the delta brought one of that moment', async () => {
    const tags = tagState();
    const host: TagHost = {
      getTags: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: null }],
        });
      },
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: null, revision: 5 }],
          revision: 5,
          truncated: false,
        });
      },
    };

    await tags.sync(host, T0, { force: true });
    const pulled = tags.validityOf(['home'], T0, T0 + MINUTE, 5);
    await tags.syncLocal(host, ['home'], T0 + HOLD_MS);

    expect(pulled).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('stale');
  });

  /**
   * Two revisions the host says of marks that say the same of every entry are two invalidations —
   * two `updateTag`s of one millisecond, say — and a view brought up between them missed the later.
   */
  it('stands at the later of two known revisions the same moment reads', async () => {
    const tags = tagState();
    const host: TagHost = {
      getTags: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: null, revision: 8 }],
        });
      },
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: null, revision: 5 }],
          revision: 7,
          truncated: false,
        });
      },
    };

    await tags.sync(host, T0, { force: true });
    const pulled = tags.validityOf(['home'], T0, T0 + MINUTE, 5);
    await tags.syncLocal(host, ['home'], T0 + HOLD_MS);

    expect(pulled).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 7)).toBe('stale');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 8)).toBe('fresh');
  });

  /**
   * A later invalidation the host says the revision of is one a view brought up short of it missed,
   * whatever its mark says: one stamped before the one held, by a clock that reads behind, too.
   */
  it('holds an invalidation the host says a later revision of against a view short of it, though its mark says less', async () => {
    const tags = tagState();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        pulls += 1;
        const revision = pulls === 1 ? 10 : 12;
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 - pulls * SECOND, hardExpireAt: null, revision }],
          revision,
          truncated: false,
        });
      },
    };

    await tags.sync(host, T0, { force: true });
    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 11)).toBe('stale');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 12)).toBe('fresh');
  });

  /**
   * Pulls overlap. Of a host that says no revision of a mark, a later page of the delta may bring the
   * same invalidation again — or another of the same mark, recorded since, which nothing it says
   * tells apart: it is counted as one, and a view brought up short of that page missed it.
   */
  it('counts a mark an overlapping pull brings again at a later page as an invalidation of that page', async () => {
    const tags = tagState();
    const { host, firstPage, secondPage } = overlappingPulls();
    const first = tags.sync(host, T0, { force: true });
    const second = tags.sync(host, T0, { force: true });

    firstPage.resolve({ tags: [HOME], revision: 10, truncated: false });
    await first;
    secondPage.resolve({ tags: [HOME, FEED], revision: 11, truncated: false });
    await second;

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 10)).toBe('stale');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 11)).toBe('fresh');
  });

  /**
   * A later invalidation stamped earlier by a clock that went back keeps its own deadline beside
   * the earlier recorded mark: the clock change cannot erase either invalidation's effect.
   */
  it('retains both deadlines when a clock that went back stamps a later revision earlier', async () => {
    const tags = tagState();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        pulls += 1;
        return Promise.resolve(
          pulls === 1
            ? {
                tags: [
                  { value: 'home', staleAt: T0 + 2 * SECOND, hardExpireAt: null, revision: 10 },
                ],
                revision: 10,
                truncated: false,
              }
            : {
                tags: [
                  { value: 'home', staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND, revision: 12 },
                ],
                revision: 12,
                truncated: false,
              },
        );
      },
    };

    await tags.sync(host, T0, { force: true });
    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
    expect(tags.validityOf(['home'], T0 + 1500, T0 + MINUTE)).toBe('stale');
  });

  /**
   * What a tag read says at no revision is held apart from what the host said at one: a later
   * invalidation the delta brings, stamped earlier by a clock that went back, keeps its deadline beside
   * it.
   */
  it('keeps the deadline of an invalidation the delta brings beside a later-stamped one a read said no revision of', async () => {
    const tags = tagState();
    const host: TagHost = {
      getTags: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + 2 * SECOND, hardExpireAt: null }],
        });
      },
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND, revision: 12 }],
          revision: 12,
          truncated: false,
        });
      },
    };

    await tags.syncLocal(host, ['home'], T0);
    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
  });

  /**
   * What a tag read says at no revision is asked of apart from this isolate's own invalidations: an
   * `updateTag` of its own still out keeps its deadline beside a later-stamped one the host told of
   * with a later deadline, by a clock that reads ahead.
   */
  it('keeps the deadline of its own invalidation still out beside a later-stamped one a read said no revision of', async () => {
    const tags = tagState();
    const { host } = hostSaying('home', {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + 100 * SECOND,
    });
    tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });

    await tags.syncLocal(host, ['home'], T0);

    expect(tags.validityOf(['home'], T0, T0 + 10 * SECOND)).toBe('expired');
  });

  /**
   * Of two of its own the host never answered, nothing tells which it recorded last: an `updateTag`
   * made first may be recorded after a `revalidateTag` made later, and one made later may be stamped
   * earlier by a clock that went back. Each is held as it was made, whichever came first, and no
   * window opens that neither did.
   */
  it('holds the deadline of each of its own calls never answered, whichever was made first', () => {
    const softFirst = tagState();
    softFirst.settleLocal(softFirst.applyLocal(['home'], SOFT));
    softFirst.settleLocal(softFirst.applyLocal(['home'], HARD));
    const hardFirst = tagState();
    hardFirst.settleLocal(hardFirst.applyLocal(['home'], HARD));
    hardFirst.settleLocal(hardFirst.applyLocal(['home'], SOFT));

    for (const tags of [softFirst, hardFirst]) {
      expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
      expect(tags.validityOf(['home'], T0 + 1500, T0 + MINUTE)).toBe('stale');
    }
  });

  /** So is each of two of its own still out, whichever was made first. */
  it('holds the deadline of each of its own calls still out, whichever was made first', () => {
    const softFirst = tagState();
    softFirst.applyLocal(['home'], SOFT);
    softFirst.applyLocal(['home'], HARD);
    const hardFirst = tagState();
    hardFirst.applyLocal(['home'], HARD);
    hardFirst.applyLocal(['home'], SOFT);

    for (const tags of [softFirst, hardFirst]) {
      expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
      expect(tags.validityOf(['home'], T0 + 1500, T0 + MINUTE)).toBe('stale');
    }
  });

  /**
   * And each of two marks a read was told at no revision, whichever it was told first: a host that
   * says no revision says nothing of which it recorded last either.
   */
  it('keeps the deadline of each mark a read was told at no revision, whichever it was told first', async () => {
    const told: TagState[] = [];
    for (const [first, second] of EITHER_ORDER) {
      const tags = tagState();
      let said = first;
      const host: TagHost = {
        getTags: () => Promise.resolve({ tags: [{ value: 'home', ...said }] }),
        tagsDelta: () => {
          throw new Error('the delta is not read here');
        },
      };
      await tags.syncLocal(host, ['home'], T0);
      said = second;
      await tags.syncLocal(host, ['home'], T0 + HOLD_MS);
      told.push(tags);
    }

    for (const tags of told) {
      expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
      expect(tags.validityOf(['home'], T0 + 1500, T0 + MINUTE)).toBe('stale');
    }
  });

  /**
   * What the host answered of this isolate's own invalidation is asked of apart from what it said of
   * the tag: an `updateTag` of its own keeps its deadline beside a later-stamped invalidation the host
   * told of with none.
   */
  it('keeps the deadline of its own invalidation beside a later-stamped one the host told of', async () => {
    const tags = tagState();
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 + 2 * SECOND, hardExpireAt: null, revision: 10 }],
          revision: 10,
          truncated: false,
        });
      },
    };
    await tags.sync(host, T0, { force: true });
    const applied = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };

    tags.confirmLocal('home', { ...applied, revision: 12 }, tags.applyLocal(['home'], applied));

    expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
  });

  /**
   * A page read from the revision a mark was known at on cannot be bringing that one again: what it
   * brings was recorded since, though its mark is the same, and a view brought up short of it missed
   * it.
   */
  it('holds a mark a page read from past it brings again against a view short of that page', async () => {
    const tags = tagState();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        pulls += 1;
        return Promise.resolve({ tags: [HOME], revision: pulls === 1 ? 10 : 12, truncated: false });
      },
    };

    await tags.sync(host, T0, { force: true });
    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 11)).toBe('stale');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 12)).toBe('fresh');
  });

  /**
   * A later invalidation of a tag is one a view that held only an earlier one missed, whatever
   * either's time: here both were stamped before the entry was made, by a clock that reads behind.
   */
  it('holds a later invalidation of a tag against a view that held only an earlier one', async () => {
    const tags = tagState();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        pulls += 1;
        return Promise.resolve({
          tags: [{ value: 'home', staleAt: T0 - SECOND + pulls, hardExpireAt: null }],
          revision: 9 + pulls,
          truncated: false,
        });
      },
    };

    await tags.sync(host, T0, { force: true });
    await tags.sync(host, T0, { force: true });

    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 10)).toBe('stale');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 11)).toBe('fresh');
  });
});

/** A host whose delta answers two pulls as the test says, each when it says. */
function overlappingPulls(): {
  host: TagHost;
  firstPage: PromiseWithResolvers<TagDelta>;
  secondPage: PromiseWithResolvers<TagDelta>;
} {
  const firstPage = Promise.withResolvers<TagDelta>();
  const secondPage = Promise.withResolvers<TagDelta>();
  let pulls = 0;
  const host: TagHost = {
    getTags: () => Promise.resolve({ tags: [] }),
    tagsDelta: () => {
      pulls += 1;
      return pulls === 1 ? firstPage.promise : secondPage.promise;
    },
  };
  return { host, firstPage, secondPage };
}

/** As many distinct tags as it takes to push anything held before them out. */
const PAST_WHAT_IS_HELD = 4097;
/** What one `tags/get` carries; a read of more than this is made in several. */
const PER_READ = 128;

/**
 * A host that says one tag was invalidated and nothing of any other, and remembers what it was
 * asked. `tagsDelta` is never reached by these: `syncLocal` is the only call they make.
 */
function hostSaying(invalidated: string, mark: TagMark): { host: TagHost; asked: string[][] } {
  const asked: string[][] = [];
  const host: TagHost = {
    getTags: (values) => {
      asked.push([...values]);
      return Promise.resolve({
        tags: values.includes(invalidated)
          ? [{ value: invalidated, staleAt: mark.staleAt, hardExpireAt: mark.hardExpireAt }]
          : [],
      });
    },
    tagsDelta: () => {
      throw new Error('the delta is not read here');
    },
  };
  return { host, asked };
}

function manyTags(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `product-${index}`);
}

describe('what the tag view holds', () => {
  /**
   * A pull is cut off with the request whose work it is, and never answers then. A sync that needs a
   * pull makes its own, whatever pull is under way, rather than wait on one that may never answer;
   * and one that answers last takes the view back past nothing a later one brought.
   */
  it('makes a pull of its own rather than join one that never answered, and keeps the newer answer', async () => {
    const tags = tagState();
    const lost = Promise.withResolvers<TagDelta>();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => Promise.resolve({ tags: [] }),
      tagsDelta: () => {
        pulls += 1;
        return pulls === 1
          ? lost.promise
          : Promise.resolve({ tags: [], revision: 7, truncated: false });
      },
    };
    const first = tags.sync(host, T0, { force: true });

    await tags.sync(host, T0 + HOLD_MS - 1, { force: true });

    expect(pulls).toBe(2);
    expect(tags.revision).toBe(7);

    lost.resolve({ tags: [], revision: 3, truncated: false });
    await first;

    expect(tags.revision).toBe(7);
  });

  it('asks the host in batches, however many tags a read uses', async () => {
    const tags = tagState();
    const { host, asked } = hostSaying('home', { staleAt: T0, hardExpireAt: null });

    await tags.syncLocal(host, manyTags(PER_READ * 2 + 1), T0);

    expect(asked.map((batch) => batch.length)).toStrictEqual([PER_READ, PER_READ, 1]);
  });

  it('forgets a tag and what it had checked about it together, and asks again', async () => {
    const tags = tagState();
    const { host, asked } = hostSaying('home', { staleAt: T0, hardExpireAt: null });
    const made = T0 - SECOND;

    await tags.syncLocal(host, ['home'], T0);

    expect(tags.validityOf(['home'], made, T0)).toBe('stale');

    // Enough other tags to push `home` out — an application that invalidates by id hands the
    // isolate one of these per id it sees.
    await tags.syncLocal(host, manyTags(PAST_WHAT_IS_HELD), T0);

    expect(tags.validityOf(['home'], made, T0)).toBe('fresh');

    // Within the hold, and asked again all the same: what was checked went out with the mark, so
    // there is no memory left that would let a stale entry pass as fresh.
    asked.length = 0;
    await tags.syncLocal(host, ['home'], T0 + 1);

    expect(asked).toStrictEqual([['home']]);
    expect(tags.validityOf(['home'], made, T0 + 1)).toBe('stale');
  });

  /**
   * `currentGeneration` judges a delivery record against this view and asks the host nothing more,
   * because the record may say nothing yet of what this Worker just invalidated. A mark of that
   * kind must therefore survive whatever the synced view forgets.
   */
  it('keeps what this Worker invalidated itself, however much else it is told', async () => {
    const tags = tagState();
    const { host } = hostSaying('nothing-of-note', { staleAt: T0, hardExpireAt: null });
    const made = T0 - SECOND;

    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });
    await tags.syncLocal(host, manyTags(PAST_WHAT_IS_HELD), T0);

    expect(tags.validityOf(['home'], made, T0)).toBe('stale');
    expect(tags.validityOf(['home'], made, T0 + MINUTE)).toBe('expired');
    expect(tags.staleAtOf(['home'])).toBe(T0);
  });

  /**
   * An answer settles the call it answers: one out from before its tag was forgotten — this isolate
   * invalidated as many other tags meanwhile — takes nothing out of a later call of the tag.
   */
  it('lets an answer to a call from before its tag was forgotten take nothing out of a later call', () => {
    const tags = tagState();
    const first = tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });
    for (const value of manyTags(PAST_WHAT_IS_HELD)) {
      tags.applyLocal([value], { staleAt: T0, hardExpireAt: T0 + MINUTE });
    }
    tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });

    tags.answerLocal(
      first,
      { revision: 5, invalidations: [{ value: 'home', staleAt: T0, hardExpireAt: T0 + MINUTE }] },
      T0,
    );

    // The later call is out still: in force at no revision, whatever the entry's view held.
    expect(tags.validityOf(['home'], T0 + 1, T0 + 2 * SECOND, 5)).toBe('expired');
  });

  /**
   * A call out longer than the runtime lets work go on behind an answer may be one whose request is
   * running yet: the tag invalidated again meanwhile, its answer still takes it out.
   */
  it('takes a call out longer than work may run out once the host answers it, the tag invalidated again meanwhile', () => {
    const tags = tagState();
    const first = tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 });
    const again = T0 + 31 * SECOND;
    const second = tags.applyLocal(['home'], { staleAt: again, hardExpireAt: again });

    tags.confirmLocal('home', { ...first.mark, revision: 5 }, first);
    tags.confirmLocal('home', { ...second.mark, revision: 6 }, second);

    expect(tags.validityOf(['home'], T0 - 1, T0 + MINUTE, 6)).toBe('fresh');
  });

  /**
   * Past 4096 of its own out at once — calls whose requests ended under them piling up — the one out
   * longest is counted with the others past it: in force at no revision while any of them is out,
   * however long, and none once the host has answered every one.
   */
  it('counts calls of its own past 4096 together, in force until the host has answered every one', () => {
    const tags = tagState();
    const marks = Array.from({ length: 4097 }, (_, index) => T0 + index);
    const calls = marks.map((at) => tags.applyLocal(['home'], { staleAt: at, hardExpireAt: at }));
    const again = T0 + 31 * SECOND;
    calls.push(tags.applyLocal(['home'], { staleAt: again, hardExpireAt: again }));

    for (const call of calls.slice(1)) {
      tags.confirmLocal('home', { ...call.mark, revision: 5 }, call);
    }
    const oneOut = tags.validityOf(['home'], T0 - 1, T0 + MINUTE, 5);
    for (const call of calls.slice(0, 1)) {
      tags.confirmLocal('home', { ...call.mark, revision: 5 }, call);
    }

    expect(oneOut).toBe('expired');
    expect(tags.validityOf(['home'], T0 - 1, T0 + MINUTE, 5)).toBe('fresh');
  });

  /**
   * Of many of its own out at once, each answered takes its own mark out: the one still out reaches
   * no entry made after it, though calls made after it were out beside it.
   */
  it('holds only the marks of its own calls still out, though many were out at once', () => {
    const tags = tagState();
    const marks = Array.from({ length: 66 }, (_, index) => T0 + index);
    const calls = marks.map((at) => tags.applyLocal(['home'], { staleAt: at, hardExpireAt: at }));

    for (const call of calls.slice(1)) {
      tags.confirmLocal('home', { ...call.mark, revision: 5 }, call);
    }

    expect(tags.validityOf(['home'], T0 + 1, T0 + MINUTE, 5)).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('expired');
  });

  /**
   * The calls counted one by one are counted across every tag, not each tag's apart: an application
   * that invalidates by id hands the isolate one tag per id, and the one out longest of them is counted
   * with the others past it, in force until it is answered.
   */
  it('counts no more of its calls out one by one than it may across every tag', () => {
    const tags = tagState();
    // Two calls of each of fewer tags than the isolate keeps its own invalidations of.
    const calls = [];
    for (const value of manyTags(2500)) {
      for (const at of [T0, T0 + 1]) {
        calls.push(tags.applyLocal([value], { staleAt: at, hardExpireAt: at }));
      }
    }
    const counted = tags.callsOut;
    const outLongest = tags.validityOf(['product-0'], T0 - 1, T0 + MINUTE, 5);

    for (const call of calls) {
      tags.confirmLocal(call.values[0] ?? '', { ...call.mark, revision: 5 }, call);
    }

    expect(counted).toBe(4096);
    expect(outLongest).toBe('expired');
    expect(tags.validityOf(['product-0'], T0 - 1, T0 + MINUTE, 5)).toBe('fresh');
    expect(tags.callsOut).toBe(0);
  });

  /**
   * Past 4096, its calls are counted together, and the mark each made is held as it was made,
   * whichever was made first.
   */
  it('holds the deadline of each of its own calls counted together past 4096, whichever was made first', () => {
    const counted: TagState[] = [];
    for (const [first, second] of EITHER_ORDER) {
      const tags = tagState();
      tags.applyLocal(['home'], first);
      tags.applyLocal(['home'], second);
      for (const value of manyTags(2048)) {
        for (const at of [T0, T0 + 1]) {
          tags.applyLocal([value], { staleAt: at, hardExpireAt: null });
        }
      }
      counted.push(tags);
    }

    for (const tags of counted) {
      expect(tags.callsOut).toBe(4096);
      expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
      expect(tags.validityOf(['home'], T0 + 1500, T0 + MINUTE)).toBe('stale');
    }
  });

  /**
   * A call of its own answered takes out the mark it made, and what that mark said all of comes
   * forward from the calls still out: an earlier `revalidateTag` out yet holds back a render it
   * reached, though the render's view held the `updateTag` that said all of it, and no render it did
   * not reach.
   */
  it('holds back what its own calls still out reach, once a call that said all of it is answered', () => {
    const tags = tagState();
    tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: null });
    const update = tags.applyLocal(['home'], {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + MINUTE,
    });

    tags.confirmLocal('home', { ...update.mark, revision: 5 }, update);

    expect(tags.validityOf(['home'], T0, T0 + 10 * SECOND, 5)).toBe('stale');
    expect(tags.validityOf(['home'], T0 + 1500, T0 + 10 * SECOND, 5)).toBe('fresh');
  });

  /**
   * So it does among many out: the mark the answered call made comes out, and what it alone said all
   * of comes forward in its place.
   */
  it('holds back what its own calls still out reach, once a call that said all of it is answered, among many out', () => {
    const tags = tagState();
    for (let index = 0; index < 16; index += 1) {
      tags.applyLocal(['home'], { staleAt: T0 + index, hardExpireAt: T0 + index });
    }
    tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: null });
    const update = tags.applyLocal(['home'], {
      staleAt: T0 + 2 * SECOND,
      hardExpireAt: T0 + MINUTE,
    });

    tags.confirmLocal('home', { ...update.mark, revision: 5 }, update);

    expect(tags.validityOf(['home'], T0 + 500, T0 + 10 * SECOND, 5)).toBe('stale');
    expect(tags.validityOf(['home'], T0 + 1500, T0 + 10 * SECOND, 5)).toBe('fresh');
  });

  /**
   * However many of its own are out, each answered takes its own mark out, and no mark made of others
   * stands in for it: a render whose view held every call answered is held back by none of them,
   * though more are out beside them than are kept apart of those known at no revision for good.
   */
  it('holds nothing of its own calls answered against a render that held them, however many others are out', () => {
    const tags = tagState();
    for (let index = 0; index < 18; index += 1) {
      tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 });
    }
    const answered = Array.from({ length: 17 }, (_, index) => {
      const at = T0 + SECOND + index;
      return tags.applyLocal(['home'], { staleAt: at, hardExpireAt: at });
    });

    for (const call of answered) {
      tags.confirmLocal('home', { ...call.mark, revision: 5 }, call);
    }

    expect(tags.validityOf(['home'], T0 + 500, T0 + MINUTE, 5)).toBe('fresh');
    expect(tags.validityOf(['home'], T0, T0 + MINUTE, 5)).toBe('expired');
  });

  /**
   * Of its own calls out, an entry is judged by the earliest deadline of those that reach it, though
   * a call made before set a later one.
   */
  it('judges an entry by the earliest deadline of its own calls out that reach it', () => {
    const tags = tagState();
    tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: T0 + MINUTE });
    tags.applyLocal(['home'], { staleAt: T0 + 2 * SECOND, hardExpireAt: T0 + 10 * SECOND });

    expect(tags.validityOf(['home'], T0, T0 + 20 * SECOND)).toBe('expired');
  });

  /**
   * However many of its own are known at no revision, past so many taken together, each deadline is
   * held for every entry its mark reached, and none reaches an entry made after them all. Taken
   * together, the earliest hold an entry only the later of them reached to the earlier deadline:
   * more held back, never less.
   */
  it('holds every deadline of many of its own calls never answered, though past so many they are taken together', () => {
    const tags = tagState();
    for (let index = 0; index < 40; index += 1) {
      const at = T0 + index * SECOND;
      tags.settleLocal(tags.applyLocal(['home'], { staleAt: at, hardExpireAt: at + MINUTE }));
    }

    expect(tags.validityOf(['home'], T0 - 1, T0 + MINUTE)).toBe('expired');
    expect(tags.validityOf(['home'], T0 + 39 * SECOND, T0 + 39 * SECOND + MINUTE)).toBe('expired');
    expect(tags.validityOf(['home'], T0 + 39 * SECOND + 1, T0 + 2 * MINUTE)).toBe('fresh');
    expect(tags.validityOf(['home'], T0 + 20 * SECOND + 1, T0 + MINUTE)).toBe('expired');
  });

  /**
   * Of two of its own the host answered, the one answered at the later revision is held whole: one
   * stamped earlier, by a clock that went back, keeps its own deadline.
   */
  it('holds the deadline of its own invalidation answered at the later revision, though stamped earlier', () => {
    const tags = tagState();
    const soft = { staleAt: T0 + 2 * SECOND, hardExpireAt: null };
    const hard = { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };

    tags.confirmLocal('home', { ...soft, revision: 10 }, tags.applyLocal(['home'], soft));
    tags.confirmLocal('home', { ...hard, revision: 12 }, tags.applyLocal(['home'], hard));

    expect(tags.validityOf(['home'], T0, T0 + MINUTE)).toBe('expired');
  });

  /** However many of its own are out at once, none the host answers is held at no revision after. */
  it('holds nothing of a burst of its own calls at no revision once the host has answered every one', () => {
    const tags = tagState();
    const marks = Array.from({ length: 100 }, (_, index) => T0 + index);
    const calls = marks.map((at) => tags.applyLocal(['home'], { staleAt: at, hardExpireAt: at }));

    for (const call of calls) {
      tags.confirmLocal('home', { ...call.mark, revision: 5 }, call);
    }

    expect(tags.validityOf(['home'], T0 - 1, T0 + MINUTE, 5)).toBe('fresh');
  });

  /**
   * A later call the host has answered — an `updateTag` a render's pull brought — holds no render
   * back that its view held, though an earlier call of the tag is still out: what is out is what the
   * calls still out applied.
   */
  it('lets a later call of its own the host answered stop holding a render back, though an earlier one is out', () => {
    const tags = tagState();
    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: null });
    const later = tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });

    tags.confirmLocal('home', { ...later.mark, revision: 5 }, later);

    expect(tags.validityOf(['home'], T0 + 1, T0 + MINUTE, 5)).toBe('fresh');
    expect(tags.validityOf(['home'], T0 + 1, T0 + MINUTE, 4)).toBe('expired');
  });

  it('settles a call once, however many times it is settled', () => {
    const tags = tagState();
    const call = tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });
    tags.applyLocal(['home'], { staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND });

    tags.settleLocal(call);
    tags.settleLocal(call);

    expect(tags.validityOf(['home'], T0 + 1, T0 + 2 * SECOND, 5)).toBe('expired');
  });

  it('answers with the stronger of what it was told and what it did itself', async () => {
    const tags = tagState();
    const { host } = hostSaying('home', { staleAt: T0, hardExpireAt: null });
    const made = T0 - SECOND;

    // The host knows of an invalidation with no deadline; this Worker then set one.
    await tags.syncLocal(host, ['home'], T0);
    tags.applyLocal(['home'], { staleAt: T0, hardExpireAt: T0 + MINUTE });

    expect(tags.validityOf(['home'], made, T0 + MINUTE)).toBe('expired');
  });
});

/** Longer than any answer of a host that answers at once takes. */
const SETTLE_MS = 100;

/** What a call came to within a moment, or that it was still waiting then. */
function settledWithin<T>(call: Promise<T>): Promise<T | 'still waiting'> {
  const moment = new Promise<'still waiting'>((resolve) => {
    setTimeout(() => {
      resolve('still waiting');
    }, SETTLE_MS);
  });
  return Promise.race([call, moment]);
}

/**
 * A question to the host under way is I/O of the request that asked it, which the Workers runtime
 * cancels once that request is over: it never settles. A read of another request that waited on
 * it waited with it, and judged its value by nothing.
 */
describe('a question another request is still asking the host', () => {
  it('is asked again for a read that needs the answer', async () => {
    const tags = tagState();
    const asked: string[][] = [];
    const host: TagHost = {
      getTags: (values) => {
        asked.push([...values]);
        // The first request's question, cancelled with its request.
        return asked.length === 1
          ? Promise.withResolvers<TagInvalidations>().promise
          : Promise.resolve({ tags: [{ value: 'home', staleAt: T0, hardExpireAt: null }] });
      },
      tagsDelta: () => {
        throw new Error('the delta is not read here');
      },
    };

    const stalled = tags.syncLocal(host, ['home'], T0);
    const answer = await settledWithin(tags.syncLocal(host, ['home'], T0));

    expect(answer).toBeUndefined();
    expect(asked).toStrictEqual([['home'], ['home']]);
    expect(tags.validityOf(['home'], T0 - SECOND, T0)).toBe('stale');
    await expect(settledWithin(stalled)).resolves.toBe('still waiting');
  });

  it('is asked again for a regeneration that brings the view up to date', async () => {
    const tags = tagState();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => {
        throw new Error('no tag is read here');
      },
      tagsDelta: () => {
        pulls += 1;
        // The first request's pull, cancelled with its request.
        return pulls === 1
          ? Promise.withResolvers<TagDelta>().promise
          : Promise.resolve({ revision: 7, truncated: false, tags: [] });
      },
    };

    const stalled = tags.sync(host, T0, { force: true });
    const answer = await settledWithin(tags.sync(host, T0, { force: true }));

    expect(answer).toBe(true);
    expect(tags.revision).toBe(7);
    await expect(settledWithin(stalled)).resolves.toBe('still waiting');
  });

  /**
   * What a sync answers is whether the view stands brought up by it: its own pull answered, or the
   * view held. Two pulls asked at the same moment are told apart by that and not by the moment, so
   * one that failed is not taken for answered because the other was.
   */
  it('answers whether its own pull brought the view up', async () => {
    const tags = tagState();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => {
        throw new Error('no tag is read here');
      },
      tagsDelta: () => {
        pulls += 1;
        return pulls === 1
          ? Promise.resolve({ revision: 3, truncated: false, tags: [] })
          : Promise.reject(new Error('the host is away'));
      },
    };

    await expect(tags.sync(host, T0, { force: true })).resolves.toBe(true);
    await expect(tags.sync(host, T0, { force: true })).resolves.toBe(false);
    // Within the hold, a sync that pulls nothing stands on the view as it is held.
    await expect(tags.sync(host, T0 + SECOND)).resolves.toBe(true);
    expect(pulls).toBe(2);
  });

  /**
   * Questions asked apart can answer out of order. The view already holds what the later one was
   * told, and it is held from when that one was asked, not from the earlier.
   */
  it('keeps the hold of a later answer when an earlier question answers after it', async () => {
    const tags = tagState();
    const earlier = Promise.withResolvers<TagInvalidations>();
    let asked = 0;
    const host: TagHost = {
      getTags: () => {
        asked += 1;
        return asked === 1 ? earlier.promise : Promise.resolve({ tags: [] });
      },
      tagsDelta: () => {
        throw new Error('the delta is not read here');
      },
    };

    const first = tags.syncLocal(host, ['home'], T0);
    await tags.syncLocal(host, ['home'], T0 + SECOND);
    earlier.resolve({ tags: [] });
    await first;
    // A hold after the earlier question, and within the later one's.
    await tags.syncLocal(host, ['home'], T0 + HOLD_MS);

    expect(asked).toBe(2);
  });

  it('keeps the hold of a later pull when an earlier one answers after it', async () => {
    const tags = tagState();
    const earlier = Promise.withResolvers<TagDelta>();
    let pulls = 0;
    const host: TagHost = {
      getTags: () => {
        throw new Error('no tag is read here');
      },
      tagsDelta: () => {
        pulls += 1;
        return pulls === 1
          ? earlier.promise
          : Promise.resolve({ revision: 7, truncated: false, tags: [] });
      },
    };

    const first = tags.sync(host, T0);
    await tags.sync(host, T0 + SECOND);
    earlier.resolve({ revision: 6, truncated: false, tags: [] });
    await first;
    await tags.sync(host, T0 + HOLD_MS);

    expect(pulls).toBe(2);
    expect(tags.revision).toBe(7);
  });
});
