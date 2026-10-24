import { describe, expect, it } from 'vitest';

import { ByteLru, Lru, TtlCache } from '../src/util/lru.ts';

describe('byteLru', () => {
  it('evicts the least recently used entry when the byte budget is exceeded', () => {
    const cache = new ByteLru<string, string>(10);
    cache.set('a', 'A', 4);
    cache.set('b', 'B', 4);

    expect(cache.get('a')).toBe('A');

    cache.set('c', 'C', 4);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.usedBytes).toBe(8);
  });

  it('ignores entries larger than the budget', () => {
    const cache = new ByteLru<string, string>(2);
    cache.set('big', 'B', 3);

    expect(cache.size).toBe(0);
  });
});

describe('lru', () => {
  it('evicts the least recently used entry once the count is exceeded', () => {
    const cache = new Lru<string, string>(2);
    cache.set('a', 'A');
    cache.set('b', 'B');

    // Reading `a` makes `b` the one that has gone longest unused.
    expect(cache.get('a')).toBe('A');

    cache.set('c', 'C');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.size).toBe(2);
  });

  it('replaces a key it already holds without spending a second of the count', () => {
    const cache = new Lru<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- writing `a` again is what is tested
    cache.set('a', 3);
    cache.set('c', 4);

    // Replacing `a` added no entry, and left `b` as the one that had gone longest unused.
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(3);
    expect(cache.get('c')).toBe(4);
    expect(cache.size).toBe(2);
  });
});

describe('ttlCache', () => {
  it('bounds retained bytes even when expired keys are never read again', () => {
    let now = 0;
    const cache = new TtlCache<string, Uint8Array>(100, 512, () => now, {
      maxBytes: 8,
      sizeOf: (value) => value.buffer.byteLength,
    });
    cache.set('old', new Uint8Array(4));
    now = 101;
    cache.set('new', new Uint8Array(6));

    expect(cache.peek('old')).toBeUndefined();
    expect(cache.usedBytes).toBe(6);
    expect(cache.size).toBe(1);

    cache.set('new', new Uint8Array(9));

    expect(cache.get('new')).toBeUndefined();
    expect(cache.usedBytes).toBe(0);
  });

  it('accounts for replacements, expiry and explicit deletion', () => {
    let now = 0;
    const cache = new TtlCache<string, string>(100, 2, () => now, {
      maxBytes: 10,
      sizeOf: (value) => value.length,
    });
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');

    expect(cache.usedBytes).toBe(8);

    cache.set('a', 'a');

    expect(cache.usedBytes).toBe(5);

    cache.delete('a');

    expect(cache.usedBytes).toBe(4);

    now = 101;

    expect(cache.get('b')).toBeUndefined();
    expect(cache.usedBytes).toBe(0);
  });

  /**
   * Entries whose values share what holds some of their bytes — one render kept by two keys, say —
   * are charged those bytes once, from the first of them set until the last of them is gone, and
   * each its own besides: two of them do not push each other out of a budget the bytes fit in once.
   */
  it('charges entries that share a holder its bytes once, until the last of them is gone', () => {
    const cache = new TtlCache<string, { readonly holder: string[] }>(100, 10, () => 0, {
      maxBytes: 10,
      sizeOf: () => 1,
      sharedOf: (value) => [{ holder: value.holder, bytes: 5 }],
    });
    const shared = { holder: ['five bytes, held once'] };
    cache.set('a', shared);
    cache.set('b', { holder: shared.holder });

    expect(cache.get('a')).toBe(shared);
    expect(cache.usedBytes).toBe(7);

    cache.delete('a');

    expect(cache.usedBytes).toBe(6);

    // Another holder past the budget: `b` goes, and the shared bytes with it.
    cache.set('c', { holder: ['another five'] });

    expect(cache.get('b')).toBeUndefined();
    expect(cache.usedBytes).toBe(6);

    cache.delete('c');

    expect(cache.usedBytes).toBe(0);
  });

  it('charges an entry each holder it shares once, and gives back each with the last entry of it', () => {
    const first = ['five bytes'];
    const second = ['three bytes'];
    const cache = new TtlCache<string, { readonly holders: readonly string[][] }>(
      100,
      10,
      () => 0,
      {
        maxBytes: 100,
        sizeOf: () => 1,
        sharedOf: (value) =>
          value.holders.map((holder) => ({ holder, bytes: holder === first ? 5 : 3 })),
      },
    );
    cache.set('a', { holders: [first, second] });
    cache.set('b', { holders: [first] });

    expect(cache.usedBytes).toBe(10);

    cache.delete('a');

    expect(cache.usedBytes).toBe(6);

    cache.delete('b');

    expect(cache.usedBytes).toBe(0);
  });

  /** A value that shares under no holder at all is charged and given back like any other. */
  it('gives back what entries sharing under an undefined holder were charged', () => {
    const cache = new TtlCache<string, string>(100, 10, () => 0, {
      maxBytes: 100,
      sizeOf: () => 1,
      sharedOf: () => [{ holder: undefined, bytes: 5 }],
    });
    cache.set('a', 'a');
    cache.set('b', 'b');

    expect(cache.usedBytes).toBe(7);

    cache.delete('a');
    cache.delete('b');

    expect(cache.usedBytes).toBe(0);
  });

  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new TtlCache<string, number>(100, 10, () => now);
    cache.set('k', 1);

    expect(cache.get('k')).toBe(1);

    now = 101;

    expect(cache.get('k')).toBeUndefined();
  });

  it('bounds the entry count', () => {
    const cache = new TtlCache<string, number>(1000, 2, () => 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
  });

  /** A first-byte path that already has the bytes may serve an expired entry and refresh behind it. */
  it('peeks an expired entry without dropping it', () => {
    let now = 0;
    const cache = new TtlCache<string, number>(100, 10, () => now);
    cache.set('k', 1);
    now = 101;

    expect(cache.peek('k')).toStrictEqual({ value: 1, stale: true });
    expect(cache.peek('k')).toStrictEqual({ value: 1, stale: true });
    expect(cache.get('k')).toBeUndefined();
    expect(cache.peek('k')).toBeUndefined();
  });
});
