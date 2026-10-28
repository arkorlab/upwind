import { describe, expect, it } from 'vitest';

import {
  assertNodeErrorHooks,
  captureNodeErrorHooks,
  withPristineNodeErrorHooks,
  type NodeErrorHooks,
} from '../src/node-error-hooks.ts';
import {
  assertNodeJwtRealm,
  assertNodeJwtRealmStructure,
  captureNodeJwtRealm,
  withNodeJwtRealmErrorHooks,
} from '../src/node-jwt-realm.ts';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const ROOTS =
  'Array ArrayBuffer Buffer DataView Date Error Float32Array Float64Array Function Int8Array Int16Array Int32Array Map Math Number Object Promise Reflect RegExp Set String Symbol TypeError Uint8Array Uint8ClampedArray Uint16Array Uint32Array WeakMap clearTimeout isFinite parseFloat parseInt setTimeout'.split(
    ' ',
  );
const SLOTS = [
  { name: 'prepareStackTrace', owner: 'constructor', key: 'prepareStackTrace', other: 1 },
  { name: 'custom inspect', owner: 'prototype', key: INSPECT, other: 0 },
] as const;

function callback(): number {
  return 0;
}

function fixture(dataBaseline = false) {
  const calls = { getter: 0, formatter: 0 };
  function AuthoredError() {
    return calls;
  }
  const formatter = () => {
    calls.formatter += 1;
    return 'authored formatter';
  };
  const prototype: unknown = Object.getOwnPropertyDescriptor(AuthoredError, 'prototype')?.value;
  if (!objectValue(prototype)) throw new TypeError('Missing authored Error prototype');
  const owners = { constructor: AuthoredError, prototype };
  if (dataBaseline) {
    for (const slot of SLOTS)
      Object.defineProperty(owners[slot.owner], slot.key, {
        value: formatter,
        configurable: true,
        enumerable: false,
        writable: true,
      });
  }
  const baseline = SLOTS.map((slot) =>
    Object.getOwnPropertyDescriptor(owners[slot.owner], slot.key),
  );
  const token = captureNodeErrorHooks(AuthoredError, AuthoredError.prototype);
  return { owners, calls, formatter, baseline, token };
}

function descriptors(own: ReturnType<typeof fixture>): readonly (PropertyDescriptor | undefined)[] {
  return SLOTS.map((slot) => Object.getOwnPropertyDescriptor(own.owners[slot.owner], slot.key));
}

function applicationHooks(own: ReturnType<typeof fixture>): void {
  Object.defineProperty(own.owners.constructor, 'prepareStackTrace', {
    configurable: true,
    enumerable: true,
    writable: false,
    value: own.formatter,
  });
  Object.defineProperty(own.owners.prototype, INSPECT, {
    configurable: true,
    enumerable: true,
    get() {
      own.calls.getter += 1;
      return own.formatter;
    },
    set() {
      own.calls.getter += 1;
    },
  });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an authored hook refusal');
}

function callableObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'function';
}

function objectValue(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function constructorOf(
  own: ReturnType<typeof realmFixture>,
  key: string,
): Record<PropertyKey, unknown> {
  const target = own.globals[key];
  if (!callableObject(target)) throw new Error('Missing authored constructor');
  return target;
}

function realmFixture() {
  const globals: Record<PropertyKey, unknown> = {};
  Object.setPrototypeOf(globals, {});
  for (const key of ROOTS)
    globals[key] = function AuthoredBuiltin() {
      return 0;
    };
  const process = {
    env: {},
    versions: { node: '24.22.1' },
    version: 'v24.22.1',
    binding: callback,
    emit: callback,
    emitWarning: callback,
    nextTick: callback,
  };
  globals['global'] = globals;
  globals['process'] = process;
  const error = globals['Error'];
  if (typeof error !== 'function') throw new TypeError('Missing authored Error root');
  const prototype: unknown = Object.getOwnPropertyDescriptor(error, 'prototype')?.value;
  if (typeof prototype !== 'object' || prototype === null)
    throw new Error('Missing authored Error prototype');
  const realm = captureNodeJwtRealm(globals, process);
  return { globals, process, error, prototype, realm };
}

describe('scoped Error hooks from authored constructors and DATA only', () => {
  it.each(SLOTS)('rejects a baseline $name accessor without invoking it', (slot) => {
    const own = fixture();
    Object.defineProperty(own.owners[slot.owner], slot.key, {
      configurable: true,
      get() {
        own.calls.getter += 1;
        return own.formatter;
      },
    });

    expect(() => captureNodeErrorHooks(own.owners.constructor, own.owners.prototype)).toThrow(
      'Unsupported Node error hooks',
    );
    expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
  });

  it.each([false, true])('installs baseline and restores application descriptors: %s', (data) => {
    const own = fixture(data);
    applicationHooks(own);
    const application = descriptors(own);

    expect(() => {
      assertNodeErrorHooks(own.token);
    }).not.toThrow();
    expect(descriptors(own)).toStrictEqual(application);
    expect(
      withPristineNodeErrorHooks(own.token, () => {
        expect(descriptors(own)).toStrictEqual(own.baseline);

        return 'authored result';
      }),
    ).toBe('authored result');
    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
    expect(() => {
      assertNodeErrorHooks(own.token);
    }).not.toThrow();
  });

  it('restores exact application descriptors when the protected callback throws', () => {
    const own = fixture(true);
    applicationHooks(own);
    const application = descriptors(own);
    const failure = new Error('authored callback failure');

    expect(
      thrown(() => {
        return withPristineNodeErrorHooks(own.token, () => {
          expect(descriptors(own)).toStrictEqual(own.baseline);

          throw failure;
        });
      }),
    ).toBe(failure);
    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
    expect(() => {
      assertNodeErrorHooks(own.token);
    }).not.toThrow();
  });

  it('nests baseline scopes without losing the outer application descriptors', () => {
    const own = fixture(true);
    applicationHooks(own);
    const application = descriptors(own);

    withPristineNodeErrorHooks(own.token, () => {
      expect(descriptors(own)).toStrictEqual(own.baseline);
      expect(
        withPristineNodeErrorHooks(own.token, () => {
          expect(descriptors(own)).toStrictEqual(own.baseline);

          return 42;
        }),
      ).toBe(42);
      expect(descriptors(own)).toStrictEqual(own.baseline);

      const failure = new Error('authored nested callback failure');

      expect(
        thrown(() => {
          return withPristineNodeErrorHooks(own.token, () => {
            throw failure;
          });
        }),
      ).toBe(failure);
      expect(descriptors(own)).toStrictEqual(own.baseline);
    });

    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
  });

  it.each(SLOTS)('never invokes an application $name accessor during health or scope', (slot) => {
    const own = fixture();
    Object.defineProperty(own.owners[slot.owner], slot.key, {
      configurable: true,
      enumerable: true,
      get() {
        own.calls.getter += 1;
        return own.formatter;
      },
    });
    const application = descriptors(own);

    assertNodeErrorHooks(own.token);
    withPristineNodeErrorHooks(own.token, () => {
      expect(descriptors(own)).toStrictEqual(own.baseline);
    });

    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
  });

  it.each(SLOTS)(
    'refuses scoped $name mutation and restores the outer application state',
    (slot) => {
      const own = fixture();
      applicationHooks(own);
      const application = descriptors(own);
      let resumed = 0;

      expect(() => {
        withPristineNodeErrorHooks(own.token, () => {
          Object.defineProperty(own.owners[slot.owner], slot.key, {
            configurable: true,
            value: own.formatter,
          });
          assertNodeErrorHooks(own.token);
          resumed += 1;
        });
      }).toThrow('Unsupported Node error hooks');
      expect(resumed).toBe(0);
      expect(descriptors(own)).toStrictEqual(application);
      expect(() => {
        assertNodeErrorHooks(own.token);
      }).toThrow('Unsupported Node error hooks');
      expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
    },
  );

  it('preflights both slots before modifying a restorable first application hook', () => {
    const own = fixture();
    applicationHooks(own);
    Object.defineProperty(own.owners.prototype, INSPECT, {
      configurable: false,
      get() {
        own.calls.getter += 1;
        return own.formatter;
      },
    });
    const application = descriptors(own);
    let callbacks = 0;

    expect(() => {
      withPristineNodeErrorHooks(own.token, () => {
        callbacks += 1;
      });
    }).toThrow('Unsupported Node error hooks');
    expect(callbacks).toBe(0);
    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });
  });

  it.each(SLOTS)(
    'restores the other slot and poisons after nonrestorable $name mutation',
    (slot) => {
      const own = fixture();
      applicationHooks(own);
      const application = descriptors(own);
      let callbacks = 0;

      expect(() => {
        withPristineNodeErrorHooks(own.token, () => {
          Object.defineProperty(own.owners[slot.owner], slot.key, {
            configurable: false,
            value: own.formatter,
          });
        });
      }).toThrow('Unsupported Node error hooks');
      expect(() => {
        withPristineNodeErrorHooks(own.token, () => {
          callbacks += 1;
        });
      }).toThrow('Unsupported Node error hooks');
      expect(callbacks).toBe(0);
      expect(own.calls).toStrictEqual({ getter: 0, formatter: 0 });

      expect(descriptors(own)[slot.other]).toStrictEqual(application[slot.other]);
    },
  );

  it('rejects copied and unrecognized private hook tokens', () => {
    const own = fixture();
    const copied = { ...own.token };
    const forged = {} as NodeErrorHooks;

    expect(() => {
      assertNodeErrorHooks(copied);
    }).toThrow('Unsupported Node error hooks');
    expect(() => withPristineNodeErrorHooks(forged, () => 42)).toThrow(
      'Unsupported Node error hooks',
    );
  });

  it('integrates configurable hooks into full and cached realm checks without invoking them', () => {
    const own = realmFixture();
    let calls = 0;
    Object.defineProperty(own.error, 'prepareStackTrace', {
      configurable: true,
      get() {
        calls += 1;
        return callback;
      },
    });
    Object.defineProperty(own.prototype, INSPECT, {
      configurable: true,
      value: () => {
        calls += 1;
      },
    });
    const application = Object.getOwnPropertyDescriptors(own.error);

    expect(() => {
      assertNodeJwtRealm(own.realm);
    }).not.toThrow();
    expect(() => {
      assertNodeJwtRealmStructure(own.realm);
    }).not.toThrow();

    withNodeJwtRealmErrorHooks(own.realm, () => {
      expect(Object.getOwnPropertyDescriptor(own.error, 'prepareStackTrace')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(own.prototype, INSPECT)).toBeUndefined();

      assertNodeJwtRealm(own.realm);
    });

    expect(Object.getOwnPropertyDescriptors(own.error)).toStrictEqual(application);
    expect(calls).toBe(0);
  });

  it.each([
    { root: 'Error', key: 'unrelated' },
    { root: 'TypeError', key: 'prepareStackTrace' },
    { root: 'Buffer', key: 'prepareStackTrace' },
  ])('keeps $root.$key strict outside the two exact owner slots', ({ root, key }) => {
    const own = realmFixture();
    const target = constructorOf(own, root);
    Object.defineProperty(target, key, { configurable: true, value: () => 42 });

    expect(() => {
      assertNodeJwtRealm(own.realm);
    }).toThrow('Unsupported Node JWT initialization');
    expect(() => {
      assertNodeJwtRealmStructure(own.realm);
    }).toThrow('Unsupported Node JWT initialization');
  });
});
