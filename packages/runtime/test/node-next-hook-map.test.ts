import { describe, expect, it } from 'vitest';

import { assertNodeNextHookMap, captureNodeNextHookMap } from '../src/node-next-hook-map.ts';

type ObjectValue = Record<PropertyKey, unknown>;
type Entry = [request: string, target: string];
const ENTRIES: readonly Entry[] = [
  ['styled-jsx', '/bundle/node_modules/styled-jsx'],
  ['styled-jsx/style', '/bundle/node_modules/styled-jsx/style.js'],
  ['styled-jsx/style.js', '/bundle/node_modules/styled-jsx/style.js'],
];
function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null;
}
function ordinary() {
  return 0;
}
function fixture(count = ENTRIES.length) {
  const expected: Entry[] = ENTRIES.slice(0, count).map(([request, target]) => [request, target]);
  const map = new Map(expected);
  const proxies = new WeakSet();
  const isProxy = (value: unknown) => isObject(value) && proxies.has(value);
  const input = { map, expected, isProxy };
  return { input, map, expected, proxies, guard: captureNodeNextHookMap(input) };
}
function check(own: ReturnType<typeof fixture>) {
  return () => {
    assertNodeNextHookMap(own.guard, own.map);
  };
}

describe('fixed Next hook alias Map DATA identity', () => {
  it.each([0, 1, 2, 3])('accepts an exact fixed inventory with %i entries', (count) => {
    const own = fixture(count);

    expect(check(own)).not.toThrow();
  });

  it('snapshots caller tuple and array values privately', () => {
    const own = fixture();
    own.expected[0]![1] = '/different';
    own.expected.push(['styled-jsx', '/added']);

    expect(check(own)).not.toThrow();

    own.map.set('styled-jsx', '/different');

    expect(check(own)).toThrow('alias inventory');
  });

  it.each(['set', 'delete', 'clear', 'add', 'reorder'] as const)(
    'refuses a changed Map inventory after %s',
    (operation) => {
      const own = fixture();
      switch (operation) {
        case 'set': {
          own.map.set('styled-jsx', '/different');
          break;
        }
        case 'delete': {
          own.map.delete('styled-jsx');
          break;
        }
        case 'clear': {
          own.map.clear();
          break;
        }
        case 'add': {
          own.map.set('extra', '/other');
          break;
        }
        case 'reorder': {
          own.map.delete('styled-jsx');
          own.map.set('styled-jsx', ENTRIES[0]![1]);
        }
      }

      expect(check(own)).toThrow('alias inventory');
    },
  );

  it('does not mistake Object.freeze(Map) for immutable entries', () => {
    const own = fixture();
    Object.freeze(own.map);

    expect(check(own)).not.toThrow();

    own.map.set('styled-jsx', '/changed');

    expect(check(own)).toThrow('alias inventory');
  });

  it('rejects an equivalent different Map and copied or foreign guard', () => {
    const own = fixture();
    const other = fixture();

    expect(() => {
      assertNodeNextHookMap(own.guard, new Map(own.expected));
    }).toThrow('different');
    expect(() => {
      assertNodeNextHookMap(other.guard, own.map);
    }).toThrow('different');
    expect(() => {
      Reflect.apply(assertNodeNextHookMap, undefined, [{ ...own.guard }, own.map]);
    }).toThrow('private guard');
  });

  it.each([{}, [], null, undefined, 1, Object.create(Map.prototype) as unknown])(
    'rejects non-Map and forged Map shapes %#',
    (map) => {
      const own = fixture(0);

      expect(() => captureNodeNextHookMap({ ...own.input, map })).toThrow('Map');
    },
  );

  it('rejects non-default Map prototypes at capture and assertion', () => {
    class OtherMap extends Map<string, string> {}
    const own = fixture();

    expect(() => captureNodeNextHookMap({ ...own.input, map: new OtherMap(own.expected) })).toThrow(
      'non-default',
    );

    Object.setPrototypeOf(own.map, {});

    expect(check(own)).toThrow('non-default');
  });

  it.each(['get', 'entries', Symbol.iterator])('never invokes an own override %s', (key) => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.map, key, {
      get() {
        called = true;
        return ordinary;
      },
    });

    expect(() => captureNodeNextHookMap(own.input)).toThrow('overridden');
    expect(check(own)).toThrow('overridden');
    expect(called).toBe(false);
  });

  it('checks the injected native proxy predicate before proxy reflection', () => {
    const own = fixture();
    let called = false;
    const map = new Proxy(own.map, {
      getPrototypeOf() {
        called = true;
        throw new Error('unexpected proxy trap');
      },
      ownKeys() {
        called = true;
        throw new Error('unexpected proxy trap');
      },
    });
    own.proxies.add(map);

    expect(() => captureNodeNextHookMap({ ...own.input, map })).toThrow('proxy');
    expect(called).toBe(false);
  });

  it.each(['get', 'entries', 'size'] as const)('refuses changed intrinsic descriptor %s', (key) => {
    const own = fixture();
    const prototype: unknown = Object.getPrototypeOf(own.map);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
    Object.defineProperty(prototype, key, {
      ...descriptor,
      enumerable: descriptor.enumerable !== true,
    });
    try {
      expect(check(own)).toThrow('intrinsics');
      expect(() => captureNodeNextHookMap(own.input)).toThrow('intrinsics');
    } finally {
      Object.defineProperty(prototype, key, descriptor);
    }
  });

  it('refuses iterator-next descriptor changes without calling the replacement', () => {
    const own = fixture();
    const prototype: unknown = Object.getPrototypeOf(new Map().entries());
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'next')!;
    let called = false;
    Object.defineProperty(prototype, 'next', {
      ...descriptor,
      value() {
        called = true;
        throw new Error('unexpected iterator call');
      },
    });
    try {
      expect(check(own)).toThrow('intrinsics');
      expect(called).toBe(false);
    } finally {
      Object.defineProperty(prototype, 'next', descriptor);
    }
  });

  it.each([
    [['other', '/target']],
    [['styled-jsx', '']],
    [
      ['styled-jsx', '/target'],
      ['styled-jsx', '/target'],
    ],
    [...ENTRIES, ['other', '/target']],
  ])('rejects invalid fixed expected inventory %#', (expected) => {
    const own = fixture(0);

    expect(() => {
      Reflect.apply(captureNodeNextHookMap, undefined, [{ ...own.input, expected }]);
    }).toThrow('alias');
  });

  it('rejects expected tuple getters without invoking them', () => {
    const own = fixture(0);
    let called = false;
    const pair = ['styled-jsx', '/target'];
    Object.defineProperty(pair, '1', {
      get() {
        called = true;
        return '/target';
      },
    });

    expect(() => {
      Reflect.apply(captureNodeNextHookMap, undefined, [{ ...own.input, expected: [pair] }]);
    }).toThrow('DATA');
    expect(called).toBe(false);
  });
});
