import { describe, expect, it } from 'vitest';

import {
  assertNodeJwtRealm,
  assertNodeJwtRealmStructure,
  captureNodeJwtRealm,
  type NodeJwtRealm,
  type NodeJwtBuiltinBasis,
} from '../src/node-jwt-realm.ts';

const ROOTS =
  'Array ArrayBuffer Buffer DataView Date Error Float32Array Float64Array Function Int8Array Int16Array Int32Array Map Math Number Object Promise Reflect RegExp Set String Symbol TypeError Uint8Array Uint8ClampedArray Uint16Array Uint32Array WeakMap clearTimeout isFinite parseFloat parseInt setTimeout'.split(
    ' ',
  );
const PREDICATES = [
  'isArrayBuffer',
  'isDate',
  'isMap',
  'isRegExp',
  'isSet',
  'isTypedArray',
] as const;
const CONFIGURED_ENVIRONMENT = { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', TURBOPACK: '1' };
const ENVIRONMENT_CHECKS = [
  ['full', assertNodeJwtRealm],
  ['cached', assertNodeJwtRealmStructure],
] as const;
const ENVIRONMENT_CASES = ENVIRONMENT_CHECKS.flatMap(([mode, check]) =>
  (['NODE_ENV', 'NEXT_RUNTIME', 'TURBOPACK'] as const).map((key) => ({ mode, check, key })),
);
function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function object(value: unknown): Record<PropertyKey, unknown> {
  if (!isObject(value)) throw new TypeError('missing authored object');
  return value;
}
function callback(): number {
  return 0;
}

/** Authored objects only: no actual Node realm, builtin module, loader or application executes. */
function fixture(
  { builtins = true, accessors = false } = {},
  initialEnvironment: Readonly<Record<string, string>> = {},
) {
  const globals: Record<PropertyKey, unknown> = {};
  const globalPrototype: Record<PropertyKey, unknown> = {};
  Object.setPrototypeOf(globals, globalPrototype);
  const environment: Record<PropertyKey, unknown> = { ...initialEnvironment };
  const versions = { node: '24.22.1' };
  const process = {
    env: environment,
    versions,
    version: 'v24.22.1',
    binding: callback,
    emitWarning: callback,
    nextTick: callback,
  };
  const processParent = { emit: callback };
  Object.setPrototypeOf(process, processParent);
  for (const key of ROOTS)
    globals[key] = function AuthoredBuiltin() {
      return 0;
    };
  const buffer = object(globals['Buffer']);
  function authoredSlowBuffer() {
    return environment;
  }
  const slow = object(authoredSlowBuffer);
  const parent = object(Object.getPrototypeOf(buffer));
  const bufferParent = object(Object.create(parent));
  Object.setPrototypeOf(buffer, bufferParent);
  for (const key of ['from', 'alloc', 'allocUnsafe', 'allocUnsafeSlow']) {
    buffer[key] = callback;
  }
  const types: Record<PropertyKey, unknown> = {};
  for (const key of PREDICATES) types[key] = callback;
  types['additionalMetadata'] = callback;
  function stream() {
    return environment;
  }
  function loader() {
    return environment;
  }
  function authoredHash() {
    return environment;
  }
  const loaderModule = object(loader);
  let wrap: unknown = callback;
  let wrapper: unknown = ['authored prefix', 'authored suffix'];
  Object.defineProperties(loaderModule, {
    wrap: {
      configurable: true,
      get: () => wrap,
      set(value: unknown) {
        wrap = value;
      },
    },
    wrapper: {
      configurable: true,
      get: () => wrapper,
      set(value: unknown) {
        wrapper = value;
      },
    },
  });
  loaderModule['_extensions'] = { '.js': callback, '.json': callback, '.node': callback };
  loaderModule['_cache'] = Object.create(null);
  for (const key of ['_load', '_resolveFilename', 'createRequire', 'register', 'registerHooks'])
    loaderModule[key] = callback;
  object(loaderModule['prototype'])['_compile'] = callback;
  object(loaderModule['prototype'])['load'] = callback;
  const modules = {
    buffer: { Buffer: buffer, SlowBuffer: slow },
    crypto: {
      KeyObject: callback,
      createSecretKey: callback,
      createPrivateKey: callback,
      createPublicKey: callback,
      createHash: callback,
      Hash: authoredHash,
    },
    stream: { Stream: stream },
    util: { inherits: callback, types, inspect: { defaultOptions: { colors: false } } },
    loader: loaderModule,
  } satisfies NodeJwtBuiltinBasis;
  globals['global'] = globals;
  globals['process'] = process;
  const calls = { process: 0, Buffer: 0 };
  let processValue: unknown = process;
  let bufferValue: unknown = buffer;
  if (accessors) {
    Object.defineProperties(globals, {
      process: {
        configurable: true,
        get() {
          calls.process += 1;
          return processValue;
        },
      },
      Buffer: {
        configurable: true,
        get() {
          calls.Buffer += 1;
          return bufferValue;
        },
      },
    });
  }
  const basis = builtins ? modules : undefined;
  const realm = captureNodeJwtRealm(globals, process, basis);
  return {
    globals,
    process,
    processParent,
    environment,
    versions,
    realm,
    globalPrototype,
    bufferParent,
    types,
    modules,
    basis,
    calls,
    setProcess: (value: unknown) => {
      processValue = value;
    },
    setBuffer: (value: unknown) => {
      bufferValue = value;
    },
  };
}

function checking(realm: NodeJwtRealm): () => void {
  return () => {
    assertNodeJwtRealm(realm);
  };
}
function capturing(own: ReturnType<typeof fixture>): () => NodeJwtRealm {
  return () => captureNodeJwtRealm(own.globals, own.process, own.basis);
}

describe('private Node JWT initialization preconditions', () => {
  it('keeps unchanged authored descriptors valid across repeated checks', () => {
    const own = fixture();

    expect(() => {
      assertNodeJwtRealm(own.realm);
      assertNodeJwtRealm(own.realm);
    }).not.toThrow();
  });

  it('keeps the optional builtin basis backward compatible', () => {
    const own = fixture({ builtins: false });

    expect(checking(own.realm)).not.toThrow();
  });

  it.each(ENVIRONMENT_CHECKS)(
    'keeps initial flag values or absence and unrelated environment updates under %s checks',
    (_mode, check) => {
      const empty = fixture();
      const native = fixture({}, CONFIGURED_ENVIRONMENT);
      const other = fixture({}, { NODE_ENV: 'test', NEXT_RUNTIME: 'other', TURBOPACK: '0' });
      for (const own of [empty, native, other]) {
        own.environment['USER_SETTING'] = 'changed';
        own.environment['SERVICE_TOKEN'] = 'rotated authored value';
      }

      expect(() => {
        check(empty.realm);
        check(native.realm);
        check(other.realm);
      }).not.toThrow();
      expect(Object.isFrozen(native.environment)).toBe(false);
    },
  );

  it.each(ENVIRONMENT_CASES)(
    'refuses a changed $key value under $mode checks',
    ({ check, key }) => {
      const own = fixture({}, CONFIGURED_ENVIRONMENT);
      own.environment[key] = 'changed';

      expect(() => {
        check(own.realm);
      }).toThrow('descriptor changed');
    },
  );

  it.each(ENVIRONMENT_CASES)('refuses a deleted $key under $mode checks', ({ check, key }) => {
    const own = fixture({}, CONFIGURED_ENVIRONMENT);
    Reflect.deleteProperty(own.environment, key);

    expect(() => {
      check(own.realm);
    }).toThrow('descriptor changed');
  });

  it.each(ENVIRONMENT_CASES)('refuses a redefined $key under $mode checks', ({ check, key }) => {
    const own = fixture({}, CONFIGURED_ENVIRONMENT);
    Object.defineProperty(own.environment, key, {
      value: CONFIGURED_ENVIRONMENT[key],
      configurable: true,
      enumerable: true,
      writable: false,
    });

    expect(() => {
      check(own.realm);
    }).toThrow('descriptor changed');
  });

  it.each(ENVIRONMENT_CASES)(
    'refuses a new initially absent $key under $mode checks',
    ({ check, key }) => {
      const own = fixture();
      own.environment[key] = CONFIGURED_ENVIRONMENT[key];

      expect(() => {
        check(own.realm);
      }).toThrow('descriptor changed');
    },
  );

  it.each(ENVIRONMENT_CASES)(
    'never invokes a substituted $key getter under $mode checks',
    ({ check, key }) => {
      const own = fixture({}, CONFIGURED_ENVIRONMENT);
      let calls = 0;
      Object.defineProperty(own.environment, key, {
        configurable: true,
        get() {
          calls += 1;
          return CONFIGURED_ENVIRONMENT[key];
        },
      });

      expect(() => {
        check(own.realm);
      }).toThrow('descriptor changed');
      expect(capturing(own)).toThrow('accessor');
      expect(calls).toBe(0);
    },
  );

  it('allows unrelated application globals without freezing its objects', () => {
    const own = fixture();
    own.globals['applicationData'] = { count: 1 };
    own.globals['_'] = { opaquePreviousValue: true };
    assertNodeJwtRealm(own.realm);

    expect(Object.isFrozen(own.globals)).toBe(false);
  });

  it.each(['define', '__core-js_shared__'])('refuses new ambient %s', (key) => {
    const own = fixture();
    own.globals[key] = {};

    expect(checking(own.realm)).toThrow('Unsupported Node JWT initialization');
  });

  it.each(['define', 'self', '_', '__core-js_shared__'])(
    'refuses a new %s getter without invoking it',
    (key) => {
      const own = fixture();
      let calls = 0;
      Object.defineProperty(own.globals, key, {
        get() {
          calls += 1;
          return 0;
        },
      });

      expect(checking(own.realm)).toThrow('accessor');
      expect(calls).toBe(0);
    },
  );

  it('refuses a foreign self and accepts the real authored global alias', () => {
    const own = fixture();
    own.globals['self'] = {};

    expect(checking(own.realm)).toThrow('nonstandard self');

    own.globals['self'] = own.globals;

    expect(checking(own.realm)).not.toThrow();
  });

  it.each(['Function', 'Object', 'ArrayBuffer', 'Buffer', 'process'])(
    'refuses a replacement %s root',
    (key) => {
      const own = fixture();
      own.globals[key] = {};

      expect(checking(own.realm)).toThrow('descriptor changed');
    },
  );

  it('refuses modified builtin fields and prototype chains', () => {
    const own = fixture();
    const target = object(own.globals['Function']);
    Object.defineProperty(target, 'extra', { value: true });

    expect(checking(own.realm)).toThrow('shape changed');
  });

  it('refuses modified builtin prototype fields without touching real intrinsics', () => {
    const own = fixture();
    const target = object(object(own.globals['Object'])['prototype']);
    Object.defineProperty(target, 'template', { value: callback });

    expect(checking(own.realm)).toThrow('shape changed');
  });

  it('refuses a changed builtin prototype chain', () => {
    const own = fixture();
    Object.setPrototypeOf(object(own.globals['Function']), {});

    expect(checking(own.realm)).toThrow('shape changed');
  });

  it.each(['binding', 'emitWarning', 'nextTick'] as const)('refuses changed process.%s', (key) => {
    const own = fixture();
    own.process[key] = () => 1;

    expect(checking(own.realm)).toThrow('descriptor changed');
  });

  it.each(['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'])(
    'refuses %s changes',
    (key) => {
      const own = fixture();
      own.environment[key] = 'authored override';

      expect(checking(own.realm)).toThrow('loader environment override');
    },
  );

  it('refuses a changed Node version and copied private token', () => {
    const own = fixture();

    expect(() => {
      assertNodeJwtRealm({ ...own.realm });
    }).toThrow('foreign realm');

    own.versions.node = '24.22.2';

    expect(checking(own.realm)).toThrow('requires Node 24.22.1');
  });

  it('checks trusted Node-style getter closed values without calling replacement getters', () => {
    const own = fixture({ accessors: true });
    assertNodeJwtRealm(own.realm);

    expect(own.calls).toStrictEqual({ process: 2, Buffer: 2 });

    let calls = 0;
    Object.defineProperty(own.globals, 'Buffer', {
      get() {
        calls += 1;
        return own.modules.buffer.Buffer;
      },
    });

    expect(checking(own.realm)).toThrow('descriptor changed');
    expect(calls).toBe(0);
  });

  it.each(['process', 'Buffer'] as const)(
    'refuses changed closed %s behind a stable trusted getter',
    (key) => {
      const own = fixture({ accessors: true });
      const changes = { process: own.setProcess, Buffer: own.setBuffer };
      changes[key]({});

      expect(checking(own.realm)).toThrow('root value changed');
    },
  );

  it.each(['define', 'self', '_', '__core-js_shared__'])(
    'refuses initial inherited %s accessors without invoking them',
    (key) => {
      const own = fixture();
      let calls = 0;
      Object.defineProperty(own.globalPrototype, key, {
        get() {
          calls += 1;
          return 0;
        },
      });

      expect(capturing(own)).toThrow('accessor');
      expect(calls).toBe(0);
    },
  );

  it('refuses an inherited AMD data namespace and later prototype mutation', () => {
    const own = fixture();
    own.globalPrototype['define'] = callback;

    expect(capturing(own)).toThrow('ambient AMD');
    expect(checking(own.realm)).toThrow('shape changed');
  });

  it('refuses a replaced global prototype before reading its fields', () => {
    const own = fixture();
    let calls = 0;
    const replacement = {
      get define() {
        calls += 1;
        return callback;
      },
    };
    Object.setPrototypeOf(own.globals, replacement);

    expect(checking(own.realm)).toThrow('prototype chain changed');
    expect(calls).toBe(0);
  });

  it.each(['buffer', 'crypto', 'stream', 'util', 'loader'] as const)(
    'refuses modified selected %s exports',
    (module) => {
      const own = fixture();
      const target = object(own.modules[module]);
      const key = {
        buffer: 'SlowBuffer',
        crypto: 'createPrivateKey',
        stream: 'Stream',
        util: 'inherits',
        loader: 'wrap',
      }[module];
      target[key] = () => 1;

      expect(checking(own.realm)).toThrow('Unsupported Node JWT initialization');
    },
  );

  it.each(['Buffer', 'SlowBuffer'] as const)(
    'seals %s.prototype.equal reads without invoking getters',
    (key) => {
      const own = fixture();
      const target = object(own.modules.buffer[key]['prototype']);
      let calls = 0;
      Object.defineProperty(target, 'equal', {
        get() {
          calls += 1;
          return callback;
        },
      });

      expect(checking(own.realm)).toThrow('shape changed');
      expect(calls).toBe(0);
    },
  );

  it('seals inherited enumerable Buffer copy fields', () => {
    const own = fixture();
    let calls = 0;
    Object.defineProperty(own.bufferParent, 'copied', {
      enumerable: true,
      get() {
        calls += 1;
        return 1;
      },
    });

    expect(capturing(own)).toThrow('accessor');
    expect(checking(own.realm)).toThrow('shape changed');
    expect(calls).toBe(0);
  });

  it('seals the loader compile wrapper', () => {
    const own = fixture();
    object(own.modules.loader['prototype'])['_compile'] = () => 1;

    expect(checking(own.realm)).toThrow('descriptor changed');
  });

  it.each(PREDICATES)('seals util.types.%s identity', (key) => {
    const own = fixture();
    own.types[key] = () => true;

    expect(checking(own.realm)).toThrow('descriptor changed');
  });

  it('seals every util.types own data field and its enumeration order', () => {
    const own = fixture();
    const value = own.types['additionalMetadata'];
    Reflect.deleteProperty(own.types, 'additionalMetadata');
    Reflect.deleteProperty(own.types, 'isDate');
    own.types['additionalMetadata'] = value;
    own.types['isDate'] = callback;

    expect(checking(own.realm)).toThrow('key order changed');
  });

  it('never reads a util.types accessor and ignores unrelated deep util.inspect settings', () => {
    const own = fixture();
    own.modules.util.inspect.defaultOptions.colors = true;

    expect(checking(own.realm)).not.toThrow();

    let calls = 0;
    Object.defineProperty(own.types, 'extra', {
      enumerable: true,
      get() {
        calls += 1;
        return callback;
      },
    });

    expect(capturing(own)).toThrow('accessor');
    expect(calls).toBe(0);
  });

  it('seals an inherited process emit callback', () => {
    const own = fixture();
    own.processParent.emit = () => 1;

    expect(checking(own.realm)).toThrow('descriptor changed');
  });

  it('rejects process.version accessors without invoking their eager read', () => {
    const own = fixture();
    let calls = 0;
    Object.defineProperty(own.process, 'version', {
      get() {
        calls += 1;
        return 'v24.22.1';
      },
    });

    expect(capturing(own)).toThrow('accessor');
    expect(checking(own.realm)).toThrow('descriptor changed');
    expect(calls).toBe(0);
  });

  it.each(['stream', 'crypto'] as const)('seals %s prototype fields', (module) => {
    const own = fixture();
    const constructor = module === 'stream' ? own.modules.stream.Stream : own.modules.crypto.Hash;
    object(object(constructor)['prototype'])['changed'] = true;

    expect(checking(own.realm)).toThrow('shape changed');
  });

  it.each([
    ['wrapper', '0'],
    ['_extensions', '.js'],
    ['_extensions', '.cjs'],
    ['_extensions', '.node'],
  ])('seals loader %s %s data', (field, key) => {
    const own = fixture();
    object(own.modules.loader[field])[key] = () => 1;

    expect(checking(own.realm)).toThrow('Unsupported Node JWT initialization');
  });
});
