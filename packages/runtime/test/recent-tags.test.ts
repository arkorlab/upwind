import { TtlCache } from '@stayingupwind/core/util';
import { describe, expect, it, vi } from 'vitest';

import { withClock } from '../src/cache/clock.ts';
import { HeldTags } from '../src/cache/held-tags.ts';
import {
  type CacheHost,
  CacheHostError,
  type TagDelta,
  type TagInvalidation,
  type TagWindow,
} from '../src/cache/host.ts';
import { answeringAtOnce } from '../src/cache/publishing.ts';
import type { CacheRuntime, Publishing } from '../src/cache/runtime.ts';
import { type TagHost, TagState } from '../src/cache/tags.ts';

/**
 * What a window of a scope's recent invalidations (`TagState.recent`) does to an isolate's view of
 * the tags: its marks judge what a request reads, and the view stands at its revision for that
 * (`seen`) — but it holds the newest invalidations and none before them, so nothing a regeneration
 * claims of what its render held (`revision`, `holdsWhole`, `heldRevisionOf`) moves for it, and a
 * read of a tag it brought still asks the host of the tag.
 */

const HOLD_MS = 5000;
const NOW = 1_800_000_000_000;
const SECOND = 1000;
/** How many tags a view keeps (`MAX_TAGS_HELD`): one pull bringing more lets the first go. */
const TAGS_HELD = 4096;
const TAG = 'product-1';
/** The revision the delta brings `TAG`'s invalidation at, and the revision it is read at. */
const INVALIDATED = 5;
const REVISION = 10;
/** A later invalidation of `TAG`, which a window read past the delta brings. */
const LATER = 12;
const INVALIDATED_AT = NOW - 60 * SECOND;
const LATER_AT = NOW - 10 * SECOND;

/** What a test leaves out, which it does not wait for. */
function ignore(): void {
  // Nothing to report: it is never answered while the test looks.
}

/** `count` tags no read of these tests is under. */
function othersOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `other-${String(index)}`);
}

/** An invalidation of `value` at once, at `revision`, from `at`. */
function markOf(value: string, revision: number, at: number): TagInvalidation {
  return { value, revision, staleAt: at, hardExpireAt: at };
}

/**
 * A host whose delta brings `TAG`'s invalidation and `later` other tags after it, whose copy of the
 * tags says nothing of any, and whose window answers `window`: counting what it is asked.
 */
function hostOf(
  later: number,
  window: TagWindow | (() => Promise<TagWindow>),
): TagHost & { readonly asked: { windows: number; tags: number } } {
  const asked = { windows: 0, tags: 0 };
  const delta: TagDelta = {
    revision: REVISION,
    truncated: false,
    tags: [
      markOf(TAG, INVALIDATED, INVALIDATED_AT),
      ...othersOf(later).map((value) => markOf(value, 6, 1)),
    ],
  };
  return {
    asked,
    tagsDelta: (since) => {
      return Promise.resolve(
        since < REVISION ? delta : { revision: REVISION, truncated: false, tags: [] },
      );
    },
    getTags: () => {
      asked.tags += 1;
      return Promise.resolve({ tags: [] });
    },
    tagsRecent: () => {
      asked.windows += 1;
      return typeof window === 'function' ? window() : Promise.resolve(window);
    },
  };
}

const LATER_WINDOW: TagWindow = {
  revision: LATER,
  truncated: false,
  tags: [markOf(TAG, LATER, LATER_AT)],
};

/** The view a regeneration brings up through `host`'s delta. */
async function viewOf(host: TagHost): Promise<TagState> {
  const state = new TagState({ holdMs: HOLD_MS });
  await state.sync(host, NOW, { force: true });
  return state;
}

describe('a window of recent invalidations in the tag view', () => {
  /**
   * The pull that brought `TAG`'s mark brought as many tags after it, which let the mark go, and the
   * host's copy says nothing of it. A window then brings a later invalidation of `TAG`: taken as what
   * the view knows of the tag, it would have the view hold the tag whole through its revision, and a
   * commit claim the mark it let go of — whose deadline it no longer has — was held.
   */
  it('holds no tag whole for a mark a window brought past one the view let go of', async () => {
    const host = hostOf(TAGS_HELD, LATER_WINDOW);
    const state = await viewOf(host);
    const before = { whole: state.holdsWhole(TAG), held: state.heldRevisionOf(TAG) };

    await expect(state.recent(host, 0)).resolves.toBe(true);

    expect(before).toStrictEqual({ whole: false, held: 0 });
    expect(state.holdsWhole(TAG)).toBe(false);
    expect(state.heldRevisionOf(TAG)).toBe(0);
    expect(state.knownRevisionOf(TAG)).toBe(0);
    expect(state.validityOf([TAG], LATER_AT - SECOND, NOW)).toBe('expired');
  });

  /**
   * A mark a window brought is held apart from the tags the delta brings and a read asks the host of
   * (`#recent`): however many of those the view lets go of after it, the request the view stands at
   * the window's revision for is judged by the mark, not by a regional copy of the tag that may be
   * behind it (Codex).
   */
  it('keeps a mark a window brought, however many tags the view lets go of after it', async () => {
    const host = hostOf(0, LATER_WINDOW);
    const state = new TagState({ holdMs: HOLD_MS });
    await state.recent(host, 0);

    await state.syncLocal(host, othersOf(TAGS_HELD), NOW);

    expect(state.validityOf([TAG], LATER_AT - SECOND, NOW)).toBe('expired');
    expect(state.seen).toBe(LATER);
    expect(state.heldRevisionOf(TAG)).toBe(0);
  });

  /**
   * A fresh isolate's delta brings the scope's whole history after the window, oldest first: more
   * tags than the view keeps, which let the first of its own go. The window's marks are not among
   * them (Codex).
   */
  it('keeps a window’s marks while the delta brings the scope’s history after them', async () => {
    const host = hostOf(TAGS_HELD, LATER_WINDOW);
    const state = new TagState({ holdMs: HOLD_MS });
    await state.recent(host, 0);

    await state.sync(host, NOW, { force: true });

    expect(state.validityOf([TAG], LATER_AT - SECOND, NOW)).toBe('expired');
    expect({ seen: state.seen, revision: state.revision }).toStrictEqual({
      seen: LATER,
      revision: REVISION,
    });
  });

  /**
   * Past as many marks of windows as are held apart, the first are let go of: the view stands no
   * further than the delta brought it (`seen`) — a request behind its scope is caught up again —
   * until the delta passes them.
   */
  it('stands where the delta brought it once a window’s mark is let go of, until the delta passes it', async () => {
    const many: TagWindow = {
      revision: LATER,
      truncated: false,
      tags: [markOf(TAG, LATER, LATER_AT), ...othersOf(TAGS_HELD).map((v) => markOf(v, 11, 1))],
    };
    const host: TagHost = {
      tagsDelta: (since) => {
        return Promise.resolve({
          revision: LATER,
          truncated: false,
          tags: since < LATER ? [markOf(TAG, LATER, LATER_AT)] : [],
        });
      },
      getTags: () => Promise.resolve({ tags: [] }),
      tagsRecent: () => Promise.resolve(many),
    };
    const state = new TagState({ holdMs: HOLD_MS });

    await state.recent(host, 0);
    const letGo = state.seen;
    await state.sync(host, NOW, { force: true });

    expect(letGo).toBe(0);
    expect(state.seen).toBe(LATER);
    expect(state.validityOf([TAG], LATER_AT - SECOND, NOW)).toBe('expired');
  });

  /**
   * The delta answers each tag's latest row: a tag invalidated again since the window comes at its
   * later revision, past pages that reach beyond the window's mark without it. The window's mark is
   * kept until the delta brings the tag itself (Codex).
   */
  it('keeps a window’s mark until the delta brings its tag, not until it passes its revision', async () => {
    const window: TagWindow = {
      revision: 20,
      truncated: false,
      tags: [markOf(TAG, INVALIDATED, INVALIDATED_AT)],
    };
    // The page before the tag's: past the window's mark, without the tag, whose row is at 30 now.
    const first: TagDelta = { revision: 10, truncated: true, tags: [markOf('other', 10, 1)] };
    const asked: number[] = [];
    const host: TagHost = {
      tagsDelta: (since) => {
        asked.push(since);
        // The page that brings the tag is still out once the first is in: judged between them.
        return since === 0
          ? Promise.resolve(first)
          : new Promise<TagDelta>(() => {
              // Never answered while the test looks.
            });
      },
      getTags: () => Promise.resolve({ tags: [] }),
      tagsRecent: () => Promise.resolve(window),
    };
    const state = new TagState({ holdMs: HOLD_MS });
    await state.recent(host, 0);

    void state.sync(host, NOW, { force: true }).catch(ignore);
    await vi.waitFor(() => {
      expect(asked).toStrictEqual([0, 10]);
    });

    expect(state.revision).toBe(10);
    expect(state.seen).toBe(20);
    expect(state.validityOf([TAG], INVALIDATED_AT - SECOND, NOW)).toBe('expired');
  });

  /**
   * A window's mark let go of past the bound is knowledge lost, as a mark the delta brought is: the
   * tag is held whole no more, and a render that began before it answers no more (Codex, Greptile).
   */
  it('counts a window’s mark let go of past the bound as lost', async () => {
    let windows = 0;
    const host: TagHost = {
      tagsDelta: () => Promise.resolve({ revision: 0, truncated: false, tags: [] }),
      getTags: () => Promise.resolve({ tags: [] }),
      tagsRecent: () => {
        windows += 1;
        return Promise.resolve({
          revision: LATER,
          truncated: false,
          tags:
            windows === 1
              ? [markOf(TAG, LATER, LATER_AT)]
              : othersOf(TAGS_HELD).map((v) => markOf(v, 11, 1)),
        });
      },
    };
    const state = new TagState({ holdMs: HOLD_MS });
    await state.recent(host, 0);
    const before = state.losses.count;

    await state.recent(host, 0);

    expect(state.holdsWhole(TAG)).toBe(false);
    expect(state.losses.lostSince(TAG, before)).toBe(true);
    expect(state.seen).toBe(0);
  });

  /**
   * A regeneration's commit claims the revision the delta brought the view to, and what it held of
   * each tag through it; a window read past it moves neither, though the view has seen past it.
   */
  it('stands a request at the window’s revision, and a commit at the delta’s', async () => {
    const host = hostOf(0, LATER_WINDOW);
    const state = await viewOf(host);

    await state.recent(host, 0);
    const held = new HeldTags();

    expect({ seen: state.seen, revision: state.revision }).toStrictEqual({
      seen: LATER,
      revision: REVISION,
    });
    expect(state.heldRevisionOf(TAG)).toBe(REVISION);
    expect(held.of([TAG], state.revision)).toStrictEqual({ [TAG]: REVISION });
  });

  /**
   * A window says nothing of when the host was last asked of a tag: a read of the tag asks its copy
   * all the same (`syncLocal`), and is told the tag's whole history there.
   */
  it('leaves a read of a tag a window brought to ask the host of it', async () => {
    const host = hostOf(0, LATER_WINDOW);
    const state = new TagState({ holdMs: HOLD_MS });

    await state.recent(host, 0);
    await state.syncLocal(host, [TAG], NOW);
    await state.syncLocal(host, [TAG], NOW);

    expect(host.asked.tags).toBe(1);
  });

  /**
   * One that left some out stands the view nowhere: the invalidations it left out are older ones it
   * may still be behind on. What it brought holds back what it reaches all the same, as a mark only
   * ever holds more back.
   */
  it('stands the view no further for a window that left some out, though it takes its marks in', async () => {
    const host = hostOf(0, { ...LATER_WINDOW, truncated: true });
    const state = new TagState({ holdMs: HOLD_MS });

    await expect(state.recent(host, 0)).resolves.toBe(false);

    expect(state.seen).toBe(0);
    expect(state.validityOf([TAG], LATER_AT - SECOND, NOW)).toBe('expired');
  });

  it('asks a window from where the view has seen, and from the moment it is handed', async () => {
    const asked: [number, number][] = [];
    const host: TagHost = {
      ...hostOf(0, LATER_WINDOW),
      tagsRecent: (since, from) => {
        asked.push([since, from]);
        return Promise.resolve(LATER_WINDOW);
      },
    };
    const state = await viewOf(host);

    await state.recent(host, NOW - 600 * SECOND);
    await state.recent(host, NOW - 590 * SECOND);

    expect(asked).toStrictEqual([
      [REVISION, NOW - 600 * SECOND],
      [LATER, NOW - 590 * SECOND],
    ]);
  });

  /** A host from before the window says so once, and is caught up with through its delta alone. */
  it('asks a host that has no window no more, and one without the call nothing', async () => {
    const unsupported = hostOf(0, () =>
      Promise.reject(new CacheHostError('no window here', { code: 'unsupported', status: 404 })),
    );
    const failing = hostOf(0, () => {
      return Promise.reject(
        new CacheHostError('the authority is away', { code: 'internal', status: 503 }),
      );
    });
    const without: TagHost = { getTags: unsupported.getTags, tagsDelta: unsupported.tagsDelta };
    const state = new TagState({ holdMs: HOLD_MS });

    const answers = [
      await state.recent(unsupported, 0),
      await state.recent(unsupported, 0),
      await state.recent(failing, 0),
      await state.recent(failing, 0),
      await state.recent(without, 0),
    ];

    expect(answers).toStrictEqual([false, false, false, false, false]);
    expect({
      unsupported: unsupported.asked.windows,
      failing: failing.asked.windows,
    }).toStrictEqual({
      unsupported: 1,
      failing: 2,
    });
    expect(state.seen).toBe(0);
  });
});

describe('a render being published, after a window', () => {
  /**
   * The render read against the delta at `REVISION`, and a window since brings an invalidation of one
   * of its tags past it, stamped before the pull the render read against was asked for: known past
   * the revision the render's view stood at, it is one the render missed, whatever its time says, and
   * the render answers no request of the isolate's at once.
   */
  it('answers no request at once once a window brings a mark of its tags past its revision', async () => {
    const host = hostOf(0, {
      revision: LATER,
      truncated: false,
      tags: [markOf(TAG, LATER, INVALIDATED_AT - SECOND)],
    });
    const tags = await viewOf(host);
    const publishing: Publishing = {
      render: {} as Publishing['render'],
      attemptId: 'attempt',
      tags: [TAG],
      observedTagRevision: REVISION,
      observedLosses: tags.losses.count,
      held: new HeldTags(),
      observedAt: NOW,
      published: new Promise(() => {
        // The publish is out while the test looks.
      }),
    };
    const frozen = (): number => NOW;
    const runtime = {
      tags,
      holdMs: HOLD_MS,
      publishing: new TtlCache<string, Publishing>(HOLD_MS, 4, frozen),
      letGo: new WeakSet(),
      host: host as unknown as CacheHost,
      log: vi.fn(),
    } as unknown as CacheRuntime;
    runtime.publishing.set('entry', publishing);

    const before = await withClock(NOW, () =>
      Promise.resolve(answeringAtOnce(runtime, 'expired', 'entry')),
    );
    await tags.recent(host, 0);
    const after = await withClock(NOW, () =>
      Promise.resolve(answeringAtOnce(runtime, 'expired', 'entry')),
    );

    expect(before).toBe(publishing);
    expect(after).toBeUndefined();
  });
});
