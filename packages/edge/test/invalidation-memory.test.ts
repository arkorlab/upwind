import { describe, expect, it } from 'vitest';

import { InvalidationMemory } from '../src/memory/invalidations.ts';

/**
 * What an isolate keeps of the invalidations its deployments' Functions said they made at once
 * (`memory/invalidations.ts`): for each tag the latest revision it was invalidated at, and a floor
 * for every tag, kept an hour; and, short of room, folded before anything is forgotten.
 */

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
/** Kept an hour from a scope's latest invalidation. */
const KEPT = 60 * MINUTE;
/** How long KV may still answer with what it held before an invalidation. */
const KV_SETTLES = 10 * MINUTE;
const SCOPE = 'dpl_invalidationMemory00001';
/** As `bytesOf` charges them: a scope, and one listing `posts`. */
const FOLDED_BYTES = 64;
const POSTS_BYTES = FOLDED_BYTES + 16 + 'posts'.length * 2;

function memoryAt(clock: { now: number }, maxBytes?: number): InvalidationMemory {
  return new InvalidationMemory(() => clock.now, maxBytes);
}

describe('invalidations taken in', () => {
  it('bind each tag to the latest revision it was invalidated at', () => {
    const memory = memoryAt({ now: NOW });

    memory.take(SCOPE, ['posts', 'comments'], 4);
    memory.take(SCOPE, ['posts'], 7);
    memory.take(SCOPE, ['comments'], 2);

    expect(memory.of(SCOPE)).toStrictEqual({
      tags: new Map([
        ['comments', 4],
        ['posts', 7],
      ]),
      every: undefined,
      stale: new Map(),
    });
  });

  it('bind every tag, apart from the tags they named, where they named every tag', () => {
    const memory = memoryAt({ now: NOW });

    memory.take(SCOPE, undefined, 5);
    memory.take(SCOPE, ['posts'], 3);
    memory.take(SCOPE, undefined, 4);

    expect(memory.of(SCOPE)).toStrictEqual({
      tags: new Map([['posts', 3]]),
      every: 5,
      stale: new Map(),
    });
  });

  it('are kept apart by scope', () => {
    const memory = memoryAt({ now: NOW });

    memory.take(SCOPE, ['posts'], 3);

    expect(memory.of('dpl_anotherDeployment000001')).toBeUndefined();
  });

  it('are kept an hour from the scope’s latest, and then forgotten', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock);
    memory.take(SCOPE, ['posts'], 3);
    clock.now += KEPT - MINUTE;
    memory.take(SCOPE, ['comments'], 4);

    clock.now += KEPT - MINUTE;
    const kept = memory.of(SCOPE);
    clock.now += MINUTE;
    const forgotten = memory.of(SCOPE);

    expect(kept?.tags).toStrictEqual(
      new Map([
        ['comments', 4],
        ['posts', 3],
      ]),
    );
    expect(forgotten).toBeUndefined();
    expect(memory.usedBytes).toBe(0);
  });

  it('hold the scope’s absences off until KV has settled past the latest, while they are kept', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock);
    memory.take(SCOPE, ['posts'], 3);
    clock.now += MINUTE;
    memory.take(SCOPE, ['comments'], 4);

    const heldFrom = memory.absencesHeldFrom(SCOPE);
    clock.now += KEPT;

    expect(heldFrom).toBe(NOW + MINUTE + KV_SETTLES);
    expect(memory.absencesHeldFrom(SCOPE)).toBeUndefined();
  });

  it('bind nothing where no revision was said, and hold absences off all the same', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock);
    memory.take(SCOPE, ['posts'], 3);
    clock.now += MINUTE;

    memory.take(SCOPE, ['comments'], undefined);

    expect(memory.of(SCOPE)).toStrictEqual({
      tags: new Map([['posts', 3]]),
      every: undefined,
      stale: new Map(),
    });
    expect(memory.absencesHeldFrom(SCOPE)).toBe(NOW + MINUTE + KV_SETTLES);
  });

  it('are folded into one floor once a scope names more tags than it lists', () => {
    const memory = memoryAt({ now: NOW });

    for (let revision = 1; revision <= 65; revision += 1) {
      memory.take(SCOPE, [`tag-${String(revision)}`], revision);
    }

    // A floor at the latest of them condemns at least what each did.
    expect(memory.of(SCOPE)).toStrictEqual({ tags: new Map(), every: 65, stale: new Map() });
    expect(memory.usedBytes).toBe(FOLDED_BYTES);
  });
});

describe('provisional invalidations moved to a manifest scope', () => {
  it('merges floors and per-tag bounds without renewing their age', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock);
    memory.take('deployment', ['posts'], 7);
    memory.take('deployment', undefined, 5);
    memory.takeEach('deployment', { atOnce: [], windowed: [{ tag: 'comments', revision: 8 }] });
    clock.now += MINUTE;
    memory.take('actual', ['posts'], 9);
    memory.take('actual', undefined, 4);
    memory.takeEach('actual', { atOnce: [], windowed: [{ tag: 'comments', revision: 6 }] });
    clock.now += 30 * MINUTE;

    const moved = memory.move('deployment', 'actual');
    const heldFrom = memory.absencesHeldFrom('actual');
    const merged = memory.of('actual');
    clock.now = NOW + MINUTE + KEPT;

    expect(moved).toBe('bounded');
    expect(merged).toStrictEqual({
      tags: new Map([['posts', 9]]),
      every: 5,
      stale: new Map([['comments', 8]]),
    });
    expect(heldFrom).toBe(NOW + MINUTE + KV_SETTLES);
    expect(memory.of('deployment')).toBeUndefined();
    expect(memory.of('actual')).toBeUndefined();
    expect(memory.usedBytes).toBe(0);
  });

  it('folds and charges the merged scope within the same memory limits', () => {
    const memory = memoryAt({ now: NOW });
    memory.take(
      'deployment',
      Array.from({ length: 40 }, (_, index) => `source-${String(index)}`),
      7,
    );
    memory.take(
      'actual',
      Array.from({ length: 40 }, (_, index) => `target-${String(index)}`),
      9,
    );

    memory.move('deployment', 'actual');

    expect(memory.of('actual')).toStrictEqual({ tags: new Map(), every: 9, stale: new Map() });
    expect(memory.usedBytes).toBe(FOLDED_BYTES);
    expect(memory.move('deployment', 'actual')).toBe('none');
  });

  it('keeps transferred older scopes first when memory must fold them', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock, 2 * POSTS_BYTES + FOLDED_BYTES);
    memory.take('deployment', ['posts'], 4);
    clock.now += MINUTE;
    memory.take('newer', ['posts'], 5);
    clock.now += MINUTE;

    memory.move('deployment', 'actual');
    memory.take('latest', ['posts'], 6);

    expect(memory.of('actual')).toStrictEqual({ tags: new Map(), every: 4, stale: new Map() });
    expect(memory.of('newer')?.tags.get('posts')).toBe(5);
    expect(memory.usedBytes).toBe(2 * POSTS_BYTES + FOLDED_BYTES);
  });

  it('does not revive expired bounds or replay a same-scope transfer', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock);
    memory.take('deployment', ['posts'], 4);

    expect(memory.move('deployment', 'deployment')).toBe('none');

    clock.now += KEPT;

    expect(memory.move('deployment', 'actual')).toBe('none');
    expect(memory.of('actual')).toBeUndefined();
    expect(memory.usedBytes).toBe(0);
  });

  it('preserves legacy revisionless notifications through later bounded ones', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock);
    memory.take('deployment', ['posts'], undefined);
    memory.take('deployment', ['comments'], 4);
    clock.now += MINUTE;

    expect(memory.move('deployment', 'actual')).toBe('unbounded');
    expect(memory.of('actual')?.tags.get('comments')).toBe(4);
    expect(memory.absencesHeldFrom('actual')).toBe(NOW + KV_SETTLES);
    expect(memory.move('deployment', 'actual')).toBe('none');
  });
});

describe('an isolate short of room for the invalidations it was told of', () => {
  it('forgets those past their keeping first', () => {
    const clock = { now: NOW };
    const memory = memoryAt(clock, 2 * POSTS_BYTES + FOLDED_BYTES);
    memory.take('dpl_a', ['posts'], 1);
    clock.now += KEPT;
    memory.take('dpl_b', ['posts'], 1);

    memory.take('dpl_c', ['posts'], 1);

    expect(memory.of('dpl_b')?.tags).toStrictEqual(new Map([['posts', 1]]));
    expect(memory.of('dpl_c')?.tags).toStrictEqual(new Map([['posts', 1]]));
    expect(memory.usedBytes).toBe(2 * POSTS_BYTES);
  });

  it('folds the scopes that list tags, oldest first, before it forgets any', () => {
    const memory = memoryAt({ now: NOW }, 3 * POSTS_BYTES + FOLDED_BYTES);
    memory.take('dpl_a', ['posts'], 4);
    memory.take('dpl_b', ['posts'], 5);
    memory.take('dpl_c', ['posts'], 6);

    memory.take('dpl_d', ['posts'], 7);

    expect(memory.of('dpl_a')).toStrictEqual({ tags: new Map(), every: 4, stale: new Map() });
    expect(memory.of('dpl_b')?.tags).toStrictEqual(new Map([['posts', 5]]));
    expect(memory.of('dpl_d')?.tags).toStrictEqual(new Map([['posts', 7]]));
    expect(memory.usedBytes).toBe(3 * POSTS_BYTES + FOLDED_BYTES);
  });

  it('forgets the oldest only once every scope is folded', () => {
    const memory = memoryAt({ now: NOW }, 2 * FOLDED_BYTES);
    memory.take('dpl_a', ['posts'], 4);
    memory.take('dpl_b', ['posts'], 5);

    memory.take('dpl_c', ['posts'], 6);

    expect(memory.of('dpl_a')).toBeUndefined();
    expect(memory.of('dpl_b')).toStrictEqual({ tags: new Map(), every: 5, stale: new Map() });
    expect(memory.of('dpl_c')).toStrictEqual({ tags: new Map(), every: 6, stale: new Map() });
    expect(memory.usedBytes).toBe(2 * FOLDED_BYTES);
  });

  it('takes a scope it took in before as its latest, not its oldest', () => {
    const memory = memoryAt({ now: NOW }, 2 * POSTS_BYTES + FOLDED_BYTES);
    memory.take('dpl_a', ['posts'], 4);
    memory.take('dpl_b', ['posts'], 5);
    memory.take('dpl_a', ['posts'], 6);

    memory.take('dpl_c', ['posts'], 7);

    expect(memory.of('dpl_b')).toStrictEqual({ tags: new Map(), every: 5, stale: new Map() });
    expect(memory.of('dpl_a')?.tags).toStrictEqual(new Map([['posts', 6]]));
  });

  /** So that what told the isolate of it is taken in again: nothing past its keeping or folded. */
  it('tells of a scope it forgot while still kept, and of none it let go of otherwise', () => {
    const clock = { now: NOW };
    const forgotten: string[] = [];
    const memory = new InvalidationMemory(
      () => clock.now,
      2 * FOLDED_BYTES,
      (scopeId) => {
        forgotten.push(scopeId);
      },
    );
    memory.take('dpl_a', ['posts'], 4);
    clock.now += KEPT;
    memory.take('dpl_b', ['posts'], 5);
    memory.take('dpl_c', ['posts'], 6);

    memory.take('dpl_d', ['posts'], 7);

    expect(memory.of('dpl_a')).toBeUndefined();
    expect(memory.of('dpl_b')).toBeUndefined();
    expect(forgotten).toStrictEqual(['dpl_b']);
  });
});
