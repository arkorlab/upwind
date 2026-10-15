import { MAX_TAG_HISTORY, type TagHistoryMark, withTagHistory } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

import type { TagInvalidation } from '../src/cache/host.ts';
import { type TagHost, TagState } from '../src/cache/tags.ts';

const T0 = 1_800_000_000_000;
const SECOND = 1000;
const HARD = { revision: 4, staleAt: T0 + SECOND, hardExpireAt: T0 + SECOND };
const SOFT = { revision: 6, staleAt: T0 + 3 * SECOND, hardExpireAt: T0 + 303 * SECOND };

function hostFor(tags: readonly TagInvalidation[]): TagHost {
  return {
    getTags: () => Promise.resolve({ tags }),
    tagsDelta: () => {
      return Promise.resolve({
        tags,
        revision: Math.max(0, ...tags.map((tag) => tag.revision ?? 0)),
        truncated: false,
      });
    },
  };
}

describe('tag invalidation history', () => {
  it('keeps an earlier expiry after a later SWR invalidation is synced', async () => {
    const tags = new TagState({ holdMs: SECOND });
    await tags.sync(hostFor([{ value: 'article', ...HARD }]), T0, { force: true });

    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND)).toBe('expired');

    await tags.sync(hostFor([{ value: 'article', ...SOFT }]), T0, { force: true });

    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND)).toBe('expired');
    expect(tags.validityOf(['article'], T0 + 2 * SECOND, T0 + 4 * SECOND)).toBe('stale');
    expect(tags.validityOf(['article'], T0 + 4 * SECOND, T0 + 4 * SECOND)).toBe('fresh');
  });

  it.each([
    {
      source: 'delta',
      read: (tags: TagState, host: TagHost) => tags.sync(host, T0, { force: true }),
    },
    {
      source: 'regional',
      read: (tags: TagState, host: TagHost) => tags.syncLocal(host, ['article'], T0),
    },
  ])('brings earlier deadlines to a cold isolate through $source', async ({ read }) => {
    const tags = new TagState({ holdMs: SECOND });
    const host = hostFor([{ value: 'article', ...SOFT, history: [HARD, SOFT] }]);
    await read(tags, host);

    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND)).toBe('expired');
    // This value already read afresh against the hard invalidation, and missed only the SWR.
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND, HARD.revision)).toBe('stale');
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND, SOFT.revision)).toBe('fresh');
  });

  it('retains the deadlines of its own confirmed invalidations', () => {
    const tags = new TagState({ holdMs: SECOND });
    const first = tags.applyLocal(['article'], HARD);
    tags.confirmLocal('article', HARD, first);
    const second = tags.applyLocal(['article'], SOFT);
    tags.confirmLocal('article', SOFT, second);

    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND)).toBe('expired');
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND, HARD.revision)).toBe('stale');
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND, SOFT.revision)).toBe('fresh');
  });

  it('merges overlapping revisions that arrive newest first', async () => {
    const tags = new TagState({ holdMs: SECOND });
    const old = Promise.withResolvers<{ tags: TagInvalidation[] }>();
    let reads = 0;
    const host: TagHost = {
      getTags: () => {
        reads += 1;
        return reads === 1
          ? old.promise
          : Promise.resolve({ tags: [{ value: 'article', ...SOFT }] });
      },
      tagsDelta: () => Promise.resolve({ tags: [], revision: 0, truncated: false }),
    };
    const first = tags.syncLocal(host, ['article'], T0);
    await tags.syncLocal(host, ['article'], T0 + SECOND);
    old.resolve({ tags: [{ value: 'article', ...HARD }] });
    await first;

    expect(tags.knownRevisionOf('article')).toBe(SOFT.revision);
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND)).toBe('expired');
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND, HARD.revision)).toBe('stale');
  });

  it('relearns all deadlines after the bounded tag view evicts a tag', async () => {
    const tags = new TagState({ holdMs: SECOND });
    const article = { value: 'article', ...SOFT, history: [HARD, SOFT] };
    await tags.syncLocal(hostFor([article]), ['article'], T0);
    const others = Array.from({ length: 4096 }, (_, index) => {
      return {
        value: `other-${index}`,
        ...SOFT,
      };
    });
    await tags.sync(hostFor(others), T0, { force: true });

    expect(tags.knownRevisionOf('article')).toBe(0);

    await tags.syncLocal(hostFor([article]), ['article'], T0 + SECOND);

    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND)).toBe('expired');
    expect(tags.validityOf(['article'], T0, T0 + 4 * SECOND, HARD.revision)).toBe('stale');
  });

  it('honours each missed revision when an authority clock moves backwards', async () => {
    const tags = new TagState({ holdMs: SECOND });
    const later = { revision: 8, staleAt: T0, hardExpireAt: T0 + 300 * SECOND };
    await tags.sync(hostFor([{ value: 'article', ...later, history: [HARD, later] }]), T0);

    expect(tags.validityOf(['article'], T0 - SECOND, T0 + 4 * SECOND)).toBe('expired');
    expect(tags.validityOf(['article'], T0 + 2 * SECOND, T0 + 4 * SECOND, HARD.revision)).toBe(
      'stale',
    );
    expect(tags.validityOf(['article'], T0 + 2 * SECOND, T0 + 4 * SECOND, later.revision)).toBe(
      'fresh',
    );
    expect(tags.staleAtOf(['article'])).toBe(HARD.staleAt);
  });

  it('bounds retained deadlines without reviving old values under repeated SWR invalidations', async () => {
    let history: TagHistoryMark[] = [HARD];
    let latest = HARD;
    for (let index = 1; index <= MAX_TAG_HISTORY * 3; index += 1) {
      latest = {
        revision: HARD.revision + index,
        staleAt: HARD.staleAt + index * SECOND,
        hardExpireAt: HARD.hardExpireAt + index * SECOND + 300 * SECOND,
      };
      history = withTagHistory(history, latest);

      expect(history.length).toBeLessThanOrEqual(MAX_TAG_HISTORY);
    }
    const tags = new TagState({ holdMs: SECOND });
    await tags.syncLocal(hostFor([{ value: 'article', ...latest, history }]), ['article'], T0);

    expect(tags.validityOf(['article'], T0, latest.staleAt)).toBe('expired');
    expect(tags.validityOf(['article'], latest.staleAt + 1, latest.staleAt)).toBe('fresh');
    expect(tags.validityOf(['article'], T0, latest.staleAt, latest.revision)).toBe('fresh');
  });
});
