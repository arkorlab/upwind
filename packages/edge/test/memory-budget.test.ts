import { describe, expect, it } from 'vitest';

import { IsolateBudget, SharedByteLru } from '../src/memory/budget.ts';

/**
 * A cache held against the isolate's one budget (`SharedByteLru`): what it says it holds, and the
 * order the budget lets its entries go in when it needs the room — least recently used first.
 */

/** A budget with room for two entries of ten bytes, and a cache of three put through it in turn. */
function full(use: (cache: SharedByteLru<string>) => void): readonly boolean[] {
  const cache = new SharedByteLru<string>(new IsolateBudget(20));
  cache.set('first', 'a', 10);
  cache.set('second', 'b', 10);
  use(cache);
  cache.set('third', 'c', 10);
  return ['first', 'second', 'third'].map((key) => cache.has(key));
}

describe('a cache held against the isolate budget', () => {
  it('says whether it holds an entry, without using it', () => {
    const held = full((cache) => {
      expect([cache.has('first'), cache.has('missing')]).toStrictEqual([true, false]);
    });

    // Asked about, the first is still the one used longest ago, and the first let go.
    expect(held).toStrictEqual([false, true, true]);
  });

  it('keeps an entry that was read, which is a use of it', () => {
    const held = full((cache) => {
      expect(cache.get('first')).toBe('a');
    });

    expect(held).toStrictEqual([true, false, true]);
  });
});
