import { describe, expect, it } from 'vitest';

import {
  assertNodeManifestIdentity,
  assertNodeManifestOwnIdentity,
  captureNodeManifestIdentity,
  captureNodeManifestOwnIdentity,
} from '../src/node-manifest-identity-snapshot.ts';

function fixture() {
  const source = { code: 'original source', sha256: 'original digest' };
  return {
    source,
    same: source,
    array: [source],
    map: new Map([
      ['first', source],
      ['second', source],
    ]),
    set: new Set(['first', 'second']),
  };
}

describe('private original data identity snapshots', () => {
  it('retains original objects and shared DAG aliases without serializing source strings', () => {
    const value = fixture();
    const snapshot = captureNodeManifestIdentity([value]);
    value.source.code = ['original', 'source'].join(' ');

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value]);
    }).not.toThrow();
    expect(() => {
      assertNodeManifestIdentity(snapshot, [{ ...value }]);
    }).toThrow('root identity');
    expect(() => {
      assertNodeManifestIdentity({ ...snapshot }, [value]);
    }).toThrow('uncertified snapshot');
  });

  it.each([
    {
      name: 'source string',
      change: (value: ReturnType<typeof fixture>) => {
        value.source.code = 'different source';
      },
    },
    {
      name: 'nested equal object',
      change: (value: ReturnType<typeof fixture>) => {
        value.source = { ...value.source };
      },
    },
    {
      name: 'array entry',
      change: (value: ReturnType<typeof fixture>) => {
        value.array[0] = { ...value.source };
      },
    },
    {
      name: 'array length',
      change: (value: ReturnType<typeof fixture>) => {
        value.array.length = 0;
      },
    },
    {
      name: 'map entry',
      change: (value: ReturnType<typeof fixture>) => {
        value.map.set('first', { ...value.source });
      },
    },
    {
      name: 'map order',
      change: (value: ReturnType<typeof fixture>) => {
        value.map.delete('first');
        value.map.set('first', value.source);
      },
    },
    {
      name: 'set order',
      change: (value: ReturnType<typeof fixture>) => {
        value.set.delete('first');
        value.set.add('first');
      },
    },
    {
      name: 'new field',
      change: (value: ReturnType<typeof fixture>) => {
        Reflect.set(value, 'newField', undefined);
      },
    },
    {
      name: 'descriptor flags',
      change: (value: ReturnType<typeof fixture>) => {
        Object.defineProperty(value.source, 'code', { writable: false });
      },
    },
  ])('rejects changed $name on every assertion', ({ change }) => {
    const value = fixture();
    const snapshot = captureNodeManifestIdentity([value]);
    assertNodeManifestIdentity(snapshot, [value]);
    change(value);

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value]);
    }).toThrow('Unproved original source identity');
  });

  it('tracks symbols, exact primitive values and own key order', () => {
    const key = Symbol('opaque');
    const value: { first?: number; second?: number; [key]: unknown } = {
      first: 1,
      second: 2,
      [key]: -0,
    };
    const snapshot = captureNodeManifestIdentity([value, undefined, null, NaN, 10n]);
    assertNodeManifestIdentity(snapshot, [value, undefined, null, NaN, 10n]);
    value[key] = 0;

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value, undefined, null, NaN, 10n]);
    }).toThrow('property or identity');

    value[key] = -0;
    delete value.first;
    value.first = 1;

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value, undefined, null, NaN, 10n]);
    }).toThrow('key order');
  });

  it('distinguishes array holes from present undefined values', () => {
    const value: (string | undefined)[] = [];
    value.length = 3;
    value[1] = 'middle';
    const snapshot = captureNodeManifestIdentity([value]);
    value[0] = undefined;

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value]);
    }).toThrow('object keys');
  });

  it('does not skip mutable descendants of a frozen root', () => {
    const child = { code: 'original' };
    const value = Object.freeze({ child, entries: new Map([['key', child]]) });
    const snapshot = captureNodeManifestIdentity([value]);
    child.code = 'changed';

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value]);
    }).toThrow('property or identity');
  });

  it('never invokes initial or newly installed accessors', () => {
    let calls = 0;
    const value = { code: 'original' };
    const snapshot = captureNodeManifestIdentity([value]);
    Object.defineProperty(value, 'code', {
      configurable: true,
      get() {
        calls += 1;
        return 'original';
      },
    });

    expect(() => {
      assertNodeManifestIdentity(snapshot, [value]);
    }).toThrow('accessor');
    expect(() => captureNodeManifestIdentity([value])).toThrow('accessor');
    expect(calls).toBe(0);
  });

  it('validates synthetic root descriptors before an index read or iterator call', () => {
    let calls = 0;
    const values: unknown[] = [{}];
    Object.defineProperty(values, '0', {
      get() {
        calls += 1;
        return {};
      },
    });

    expect(() => captureNodeManifestIdentity(values)).toThrow('accessor');

    const hooked: unknown[] = [{}];
    Object.defineProperty(hooked, Symbol.iterator, {
      value() {
        calls += 1;
        throw new Error('not called');
      },
    });

    expect(() => captureNodeManifestIdentity(hooked)).toThrow('roots keys or hook');
    expect(calls).toBe(0);
  });

  it('rejects root and nested proxies without invoking traps', () => {
    let calls = 0;
    const traps = {
      ownKeys() {
        calls += 1;
        return [];
      },
      get() {
        calls += 1;
      },
    };
    const root = new Proxy<unknown[]>([], traps);
    const nested = new Proxy({}, traps);

    expect(() => captureNodeManifestIdentity(root)).toThrow('roots array shape');
    expect(() => captureNodeManifestIdentity([nested])).toThrow('proxy');
    expect(calls).toBe(0);
  });

  it.each([Object.create(Map.prototype), Object.create(Set.prototype)])(
    'rejects a forged collection prototype with no internal slots',
    (value: unknown) => {
      expect(() => captureNodeManifestIdentity([value])).toThrow('collection brand');
    },
  );

  it('rejects unsupported prototypes, functions and cyclic data', () => {
    expect(() => captureNodeManifestIdentity([new Date(0)])).toThrow('prototype');
    expect(() => captureNodeManifestIdentity([() => 1])).toThrow('function');

    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;

    expect(() => captureNodeManifestIdentity([cycle])).toThrow('cycle');

    const map = new Map<unknown, unknown>();
    map.set('self', map);

    expect(() => captureNodeManifestIdentity([map])).toThrow('cycle');
  });

  it('enforces finite root, depth and sparse-array bounds', () => {
    expect(() => captureNodeManifestIdentity(Array.from({ length: 33 }, () => null))).toThrow(
      'roots bound',
    );

    const root: Record<string, unknown> = {};
    let current = root;
    for (let depth = 0; depth < 257; depth += 1) {
      const child = {};
      current['child'] = child;
      current = child;
    }

    expect(() => captureNodeManifestIdentity([root])).toThrow('depth bound');

    const sparse: unknown[] = [];
    sparse.length = 1_000_001;

    expect(() => captureNodeManifestIdentity([sparse])).toThrow('array bound');
  });

  it('keeps own-only control guards separate from deep source guards', () => {
    const source = { code: 'original' };
    const live = new Map<string, unknown>();
    const control = { source, live };
    const own = captureNodeManifestOwnIdentity([control]);
    const deep = captureNodeManifestIdentity([source]);
    live.set('legitimate-private-entry', {});
    assertNodeManifestOwnIdentity(own, [control]);
    assertNodeManifestIdentity(deep, [source]);
    source.code = 'changed';
    assertNodeManifestOwnIdentity(own, [control]);

    expect(() => {
      assertNodeManifestIdentity(deep, [source]);
    }).toThrow('property or identity');
    expect(() => {
      Reflect.apply(assertNodeManifestIdentity, undefined, [own, [source]]);
    }).toThrow('uncertified snapshot');
    expect(() => {
      Reflect.apply(assertNodeManifestOwnIdentity, undefined, [deep, [control]]);
    }).toThrow('uncertified own snapshot');

    control.source = { ...source };

    expect(() => {
      assertNodeManifestOwnIdentity(own, [control]);
    }).toThrow('property or identity');
  });
});
