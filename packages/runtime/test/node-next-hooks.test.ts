import { describe, expect, it } from 'vitest';

import {
  assertNodeErrorHooks,
  captureNodeNextHooks,
  withPristineNodeErrorHooks,
} from '../src/node-error-hooks.ts';
import {
  assertNodeJwtRealm,
  assertNodeJwtRealmStructure,
  captureNodeJwtRealm,
  captureNodeNextJwtRealm,
  withNodeJwtRealmErrorHooks,
  type NodeJwtBuiltinBasis,
} from '../src/node-jwt-realm.ts';

type ObjectValue = Record<PropertyKey, unknown>;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const ROOTS =
  'Array ArrayBuffer Buffer DataView Date Error Float32Array Float64Array Function Int8Array Int16Array Int32Array Map Math Number Object Promise Reflect RegExp Set String Symbol TypeError Uint8Array Uint8ClampedArray Uint16Array Uint32Array WeakMap clearTimeout isFinite parseFloat parseInt setTimeout'.split(
    ' ',
  );
const PREDICATES = ['isArrayBuffer', 'isDate', 'isMap', 'isRegExp', 'isSet', 'isTypedArray'];
const SLOTS = [
  { name: 'Error.prepareStackTrace', owner: 'error', key: 'prepareStackTrace' },
  { name: 'Error custom inspect', owner: 'errorPrototype', key: INSPECT },
  { name: 'Math.random', owner: 'math', key: 'random' },
  { name: 'global Date', owner: 'globals', key: 'Date' },
  { name: 'original Date.prototype.constructor', owner: 'datePrototype', key: 'constructor' },
  { name: 'crypto.randomBytes', owner: 'crypto', key: 'randomBytes' },
  { name: 'crypto.randomFillSync', owner: 'crypto', key: 'randomFillSync' },
  { name: 'process.nextTick', owner: 'process', key: 'nextTick' },
] as const;

function objectValue(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function object(value: unknown): ObjectValue {
  if (!objectValue(value)) throw new TypeError('Missing authored object');
  return value;
}
function callback(): number {
  return 0;
}
function authoredHash(): number {
  return 0;
}
function authoredSlowBuffer(): number {
  return 0;
}
function authoredStream(): number {
  return 0;
}

/** Every mutable owner below is authored DATA; no actual builtin/global is changed. */
function fixture() {
  const globals: ObjectValue = {};
  Object.setPrototypeOf(globals, {});
  for (const key of ROOTS)
    globals[key] = function AuthoredBuiltin() {
      return 0;
    };
  const math = { random: callback };
  globals['Math'] = math;
  const date = object(globals['Date']);
  const error = object(globals['Error']);
  const buffer = object(globals['Buffer']);
  for (const key of ['from', 'alloc', 'allocUnsafe', 'allocUnsafeSlow']) buffer[key] = callback;
  const types: ObjectValue = {};
  for (const key of PREDICATES) types[key] = callback;
  const crypto = {
    KeyObject: callback,
    createSecretKey: callback,
    createPrivateKey: callback,
    createPublicKey: callback,
    createHash: callback,
    Hash: authoredHash,
    randomBytes: callback,
    randomFillSync: callback,
  };
  const basis = {
    buffer: {
      Buffer: buffer,
      SlowBuffer: authoredSlowBuffer,
    },
    crypto,
    stream: {
      Stream: authoredStream,
    },
    util: { inherits: callback, types },
  } satisfies NodeJwtBuiltinBasis;
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
  const owners = {
    globals,
    math,
    crypto,
    process,
    error,
    errorPrototype: object(error['prototype']),
    datePrototype: object(date['prototype']),
  };
  const baseline = SLOTS.map((slot) =>
    Object.getOwnPropertyDescriptor(owners[slot.owner], slot.key),
  );
  const calls = { getter: 0, application: 0 };
  const replacement = () => {
    calls.application += 1;
    return 42;
  };
  return { globals, process, basis, owners, baseline, calls, replacement, date, error };
}

function descriptors(own: ReturnType<typeof fixture>) {
  return SLOTS.map((slot) => Object.getOwnPropertyDescriptor(own.owners[slot.owner], slot.key));
}
function applicationHooks(
  own: ReturnType<typeof fixture>,
  kind: 'accessor' | 'data' = 'accessor',
): void {
  for (const slot of SLOTS) {
    const hook =
      kind === 'data'
        ? { value: own.replacement, writable: false }
        : {
            get() {
              own.calls.getter += 1;
              return own.replacement;
            },
            set() {
              own.calls.getter += 1;
            },
          };
    Object.defineProperty(own.owners[slot.owner], slot.key, {
      configurable: true,
      enumerable: true,
      ...hook,
    });
  }
}
function capture(own: ReturnType<typeof fixture>) {
  return captureNodeNextHooks({
    globals: own.globals,
    errorCtor: own.error,
    math: own.owners.math,
    dateCtor: own.date,
    crypto: own.owners.crypto,
    process: own.process,
  });
}

describe('fixed Next initialization hooks from authored owners only', () => {
  it.each(SLOTS)('rejects an initial $name accessor without invoking it', (slot) => {
    const own = fixture();
    Object.defineProperty(own.owners[slot.owner], slot.key, {
      configurable: true,
      get() {
        own.calls.getter += 1;
        return own.replacement;
      },
    });

    expect(() => capture(own)).toThrow('Unsupported Node');
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });

  it.each(['accessor', 'data'] as const)(
    'checks all application %s hooks read-only, installs baselines, and restores exact descriptors',
    (kind) => {
      const own = fixture();
      const token = capture(own);
      applicationHooks(own, kind);
      const application = descriptors(own);

      assertNodeErrorHooks(token);
      assertNodeErrorHooks(token);

      expect(descriptors(own)).toStrictEqual(application);

      const result = withPristineNodeErrorHooks(token, () => {
        expect(descriptors(own)).toStrictEqual(own.baseline);

        assertNodeErrorHooks(token);
        return 'protected result';
      });

      expect(result).toBe('protected result');
      expect(descriptors(own)).toStrictEqual(application);
      expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
    },
  );

  it('restores all application hooks after a callback throws without poisoning the next scope', () => {
    const own = fixture();
    const token = capture(own);
    applicationHooks(own);
    const application = descriptors(own);
    const failure = new Error('authored callback failure');
    let caught: unknown;
    try {
      withPristineNodeErrorHooks(token, () => {
        expect(descriptors(own)).toStrictEqual(own.baseline);

        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(descriptors(own)).toStrictEqual(application);
    expect(() => {
      assertNodeErrorHooks(token);
      withPristineNodeErrorHooks(token, () => {
        expect(descriptors(own)).toStrictEqual(own.baseline);
      });
    }).not.toThrow();
    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });

  it('keeps the baseline throughout nested scopes and restores only the outer application hooks', () => {
    const own = fixture();
    const token = capture(own);
    applicationHooks(own);
    const application = descriptors(own);

    withPristineNodeErrorHooks(token, () => {
      expect(descriptors(own)).toStrictEqual(own.baseline);

      withPristineNodeErrorHooks(token, () => {
        expect(descriptors(own)).toStrictEqual(own.baseline);

        assertNodeErrorHooks(token);
      });

      expect(descriptors(own)).toStrictEqual(own.baseline);

      assertNodeErrorHooks(token);
    });

    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });

  it.each(SLOTS)('preflights every slot before writes when $name is nonrestorable', (slot) => {
    const own = fixture();
    const token = capture(own);
    applicationHooks(own);
    Object.defineProperty(own.owners[slot.owner], slot.key, {
      configurable: false,
      value: own.replacement,
    });
    const application = descriptors(own);
    let callbacks = 0;

    expect(() => {
      withPristineNodeErrorHooks(token, () => {
        callbacks += 1;
      });
    }).toThrow('Unsupported Node');
    expect(callbacks).toBe(0);
    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });

  it.each(SLOTS)(
    'refuses active $name mutation before a nested continuation and stays poisoned',
    (slot) => {
      const own = fixture();
      const token = capture(own);
      applicationHooks(own);
      const application = descriptors(own);
      let resumed = 0;

      expect(() => {
        withPristineNodeErrorHooks(token, () => {
          Object.defineProperty(own.owners[slot.owner], slot.key, {
            configurable: true,
            value: own.replacement,
          });
          assertNodeErrorHooks(token);
          resumed += 1;
        });
      }).toThrow('Unsupported Node');
      expect(resumed).toBe(0);
      expect(descriptors(own)).toStrictEqual(application);
      expect(() => {
        assertNodeErrorHooks(token);
      }).toThrow('Unsupported Node');
      expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
    },
  );

  it.each(SLOTS.slice(2))(
    'restores every other hook after nonrestorable active $name mutation',
    (slot) => {
      const own = fixture();
      const token = capture(own);
      applicationHooks(own);
      const application = descriptors(own);

      expect(() => {
        withPristineNodeErrorHooks(token, () => {
          Object.defineProperty(own.owners[slot.owner], slot.key, {
            configurable: false,
            value: own.replacement,
          });
        });
      }).toThrow('Unsupported Node');

      const current = descriptors(own);
      const otherIndexes = SLOTS.map((_other, index) => index).filter(
        (index) => SLOTS[index] !== slot,
      );

      expect(otherIndexes.map((index) => current[index])).toStrictEqual(
        otherIndexes.map((index) => application[index]),
      );
      expect(() => {
        assertNodeErrorHooks(token);
      }).toThrow('Unsupported Node');
      expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
    },
  );

  it.each(SLOTS.slice(2))('keeps $name strict without Next initialization enabled', (slot) => {
    const own = fixture();
    const realm = captureNodeJwtRealm(own.globals, own.process, own.basis);
    Object.defineProperty(own.owners[slot.owner], slot.key, {
      configurable: true,
      get() {
        own.calls.getter += 1;
        return own.replacement;
      },
    });

    expect(() => {
      assertNodeJwtRealm(realm);
    }).toThrow('Unsupported Node');
    expect(() => {
      assertNodeJwtRealmStructure(realm);
    }).toThrow('Unsupported Node');
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });

  it('integrates the eight exact slots into full and cached Next realm health and one scope', () => {
    const own = fixture();
    const realm = captureNodeNextJwtRealm(own.globals, own.process, own.basis);
    applicationHooks(own);
    const application = descriptors(own);

    assertNodeJwtRealm(realm);
    assertNodeJwtRealmStructure(realm);

    expect(descriptors(own)).toStrictEqual(application);

    withNodeJwtRealmErrorHooks(realm, () => {
      expect(descriptors(own)).toStrictEqual(own.baseline);

      assertNodeJwtRealm(realm);
      assertNodeJwtRealmStructure(realm);
    });

    expect(descriptors(own)).toStrictEqual(application);
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });

  it.each(['Error', 'Buffer', 'Math'])(
    'retains the strict global %s identity in a Next realm without calling replacements',
    (key) => {
      const own = fixture();
      const realm = captureNodeNextJwtRealm(own.globals, own.process, own.basis);
      Object.defineProperty(own.globals, key, {
        configurable: true,
        get() {
          own.calls.getter += 1;
          return own.replacement;
        },
      });

      expect(() => {
        assertNodeJwtRealm(realm);
      }).toThrow('Unsupported Node');
      expect(() => {
        assertNodeJwtRealmStructure(realm);
      }).toThrow('Unsupported Node');
      expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
    },
  );

  it.each([
    { owner: 'date', key: 'now' },
    { owner: 'datePrototype', key: 'otherMethod' },
    { owner: 'math', key: 'floor' },
    { owner: 'crypto', key: 'createHash' },
    { owner: 'buffer', key: 'from' },
    { owner: 'otherPrototype', key: 'constructor' },
    { owner: 'process', key: 'emit' },
    { owner: 'process', key: 'binding' },
    { owner: 'math', key: 'nextTick' },
  ] as const)('keeps $owner.$key strict even when Next hooks are enabled', ({ owner, key }) => {
    const own = fixture();
    const targets = {
      ...own.owners,
      date: own.date,
      buffer: object(own.globals['Buffer']),
      otherPrototype: object(object(own.globals['TypeError'])['prototype']),
    };
    const realm = captureNodeNextJwtRealm(own.globals, own.process, own.basis);
    applicationHooks(own);
    Object.defineProperty(targets[owner], key, {
      configurable: true,
      get() {
        own.calls.getter += 1;
        return own.replacement;
      },
    });

    expect(() => {
      assertNodeJwtRealm(realm);
    }).toThrow('Unsupported Node');
    expect(() => {
      assertNodeJwtRealmStructure(realm);
    }).toThrow('Unsupported Node');
    expect(own.calls).toStrictEqual({ getter: 0, application: 0 });
  });
});
