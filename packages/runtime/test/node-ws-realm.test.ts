import { describe, expect, it } from 'vitest';

import {
  assertNodeJwtRealm,
  captureNodeJwtRealm,
  type NodeJwtBuiltinBasis,
} from '../src/node-jwt-realm.ts';

const ROOTS =
  'Array ArrayBuffer Buffer DataView Date Error Float32Array Float64Array Function Int8Array Int16Array Int32Array Map Math Number Object Promise Reflect RegExp Set String Symbol TypeError Uint8Array Uint8ClampedArray Uint16Array Uint32Array WeakMap clearTimeout isFinite parseFloat parseInt setTimeout'.split(
    ' ',
  );
const PREDICATES = ['isArrayBuffer', 'isDate', 'isMap', 'isRegExp', 'isSet', 'isTypedArray'];
type ObjectValue = Record<PropertyKey, unknown>;
function isObject(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) throw new TypeError('missing authored object');
  return value;
}
function callback() {
  return function authored() {
    return 0;
  };
}
function moduleLoader(): ObjectValue {
  const loader = object(callback());
  let wrap: unknown = callback();
  let wrapper: unknown = ['authored prefix', 'authored suffix'];
  let stat: unknown = callback();
  let readPackage: unknown = callback();
  Object.defineProperties(loader, {
    wrap: {
      configurable: true,
      get: () => wrap,
      set: (value: unknown) => {
        wrap = value;
      },
    },
    wrapper: {
      configurable: true,
      get: () => wrapper,
      set: (value: unknown) => {
        wrapper = value;
      },
    },
    _stat: {
      configurable: true,
      get: () => stat,
      set: (value: unknown) => {
        stat = value;
      },
    },
    _readPackage: {
      configurable: true,
      get: () => readPackage,
      set: (value: unknown) => {
        readPackage = value;
      },
    },
  });
  for (const key of [
    '_load',
    '_resolveFilename',
    'createRequire',
    'register',
    'registerHooks',
    '_findPath',
    '_resolveLookupPaths',
    '_nodeModulePaths',
  ])
    loader[key] = callback();
  const prototype = object(loader['prototype']);
  prototype['_compile'] = callback();
  prototype['load'] = callback();
  prototype['require'] = callback();
  loader['_extensions'] = { '.js': callback(), '.json': callback(), '.node': callback() };
  loader['_pathCache'] = Object.create(null);
  loader['_cache'] = Object.create(null);
  return loader;
}

/** All globals, CJS exports and constructors are authored objects; no actual Node realm runs. */
function fixture(websocket = true) {
  const globals: ObjectValue = {};
  for (const key of ROOTS) globals[key] = callback();
  const Buffer = object(globals['Buffer']);
  for (const key of ['from', 'alloc', 'allocUnsafe', 'allocUnsafeSlow']) Buffer[key] = callback();
  const process = {
    env: {},
    versions: { node: '24.22.1' },
    version: 'v24.22.1',
    binding: callback(),
    emit: callback(),
    emitWarning: callback(),
    nextTick: callback(),
  };
  globals['global'] = globals;
  globals['process'] = process;
  const crypto = {
    Hash: callback(),
    createHash: callback(),
    KeyObject: callback(),
    createSecretKey: callback(),
    createPrivateKey: callback(),
    createPublicKey: callback(),
    randomBytes: callback(),
    randomFillSync: callback(),
  };
  const stream = {
    Stream: callback(),
    Readable: callback(),
    Writable: callback(),
    Duplex: callback(),
  };
  const types: ObjectValue = {};
  for (const key of PREDICATES) types[key] = callback();
  const ws = {
    crypto,
    stream,
    url: { URL: callback() },
    events: callback(),
    http: {},
    https: {},
    net: {},
    tls: {},
    zlib: {},
    path: {
      resolve: callback(),
      dirname: callback(),
      isAbsolute: callback(),
      normalize: callback(),
      toNamespacedPath: callback(),
      join: callback(),
      basename: callback(),
      sep: '/',
      delimiter: ':',
    },
    fs: { realpathSync: callback() },
  };
  const loader = moduleLoader();
  const basis: NodeJwtBuiltinBasis = {
    buffer: { Buffer, SlowBuffer: callback() },
    crypto,
    stream,
    util: { inherits: callback(), types },
    loader,
    ...(websocket && { websocket: ws }),
  };
  if (websocket) globals['eval'] = callback();
  const realm = captureNodeJwtRealm(globals, process, basis);
  return { globals, process, basis, ws, loader, realm };
}
function capturing(own: ReturnType<typeof fixture>) {
  return () => captureNodeJwtRealm(own.globals, own.process, own.basis);
}
function checking(own: ReturnType<typeof fixture>) {
  return () => {
    assertNodeJwtRealm(own.realm);
  };
}
function selectedOwner(own: ReturnType<typeof fixture>, key: string): ObjectValue {
  if (key === 'eval') return own.globals;
  return key === 'URL' ? own.ws.url : own.ws;
}
function selectedConstructor(own: ReturnType<typeof fixture>, key: string): unknown {
  if (key === 'URL') return own.ws.url.URL;
  return key === 'events' ? own.ws.events : object(own.ws.stream)[key];
}

describe('fixed WebSocket eager initialization realm', () => {
  it.each([false, true])('seals the default Module.load callback with WS=%s', (websocket) => {
    const own = fixture(websocket);
    const prototype = object(own.loader['prototype']);
    const original = prototype['load'];
    prototype['load'] = callback();

    expect(checking(own)).toThrow('builtin');

    prototype['load'] = original;

    expect(checking(own)).not.toThrow();
  });

  it.each([false, true])(
    'rejects a Module.load getter without calling it with WS=%s',
    (websocket) => {
      const own = fixture(websocket);
      let calls = 0;
      Object.defineProperty(object(own.loader['prototype']), 'load', {
        get() {
          calls += 1;
          return callback();
        },
      });

      expect(checking(own)).toThrow('builtin');
      expect(calls).toBe(0);
    },
  );

  it('accepts unchanged authored globals and all nine CJS module identities', () => {
    const own = fixture();

    expect(checking(own)).not.toThrow();
    expect(checking(own)).not.toThrow();
    expect(Object.isFrozen(own.ws)).toBe(false);
  });

  it('preserves JWT-only capture without requiring an eval binding or WS exports', () => {
    const own = fixture(false);

    expect(checking(own)).not.toThrow();
    expect(own.globals).not.toHaveProperty('eval');
  });

  it.each(['Readable', 'Writable', 'Duplex'] as const)(
    'does not invoke an eager stream.%s customer getter',
    (key) => {
      const own = fixture();
      let calls = 0;
      Object.defineProperty(own.ws.stream, key, {
        configurable: true,
        get() {
          calls += 1;
          return callback();
        },
      });

      expect(capturing(own)).toThrow('Unsupported Node JWT initialization');
      expect(checking(own)).toThrow('Unsupported Node JWT initialization');
      expect(calls).toBe(0);
    },
  );

  it.each(['randomBytes', 'createHash', 'randomFillSync'] as const)(
    'does not invoke an eager crypto.%s customer getter',
    (key) => {
      const own = fixture();
      let calls = 0;
      Object.defineProperty(own.ws.crypto, key, {
        configurable: true,
        get() {
          calls += 1;
          return callback();
        },
      });

      expect(capturing(own)).toThrow('Unsupported Node JWT initialization');
      expect(checking(own)).toThrow('Unsupported Node JWT initialization');
      expect(calls).toBe(0);
    },
  );

  it.each(['eval', 'URL', 'events'])('rejects a selected %s getter without calling it', (key) => {
    const own = fixture();
    const owner = selectedOwner(own, key);
    let calls = 0;
    Object.defineProperty(owner, key, {
      configurable: true,
      get() {
        calls += 1;
        return callback();
      },
    });

    expect(capturing(own)).toThrow('Unsupported Node JWT initialization');
    expect(checking(own)).toThrow('Unsupported Node JWT initialization');
    expect(calls).toBe(0);
  });

  it('rejects an eval identity change after the trusted capture', () => {
    const own = fixture();
    own.globals['eval'] = callback();

    expect(checking(own)).toThrow('descriptor changed');
  });

  it.each(['Readable', 'Writable', 'Duplex', 'URL', 'events'])(
    'seals the selected %s constructor prototype chain',
    (key) => {
      const own = fixture();
      const value = selectedConstructor(own, key);
      object(object(value)['prototype'])['changed'] = true;

      expect(checking(own)).toThrow('shape changed');
    },
  );

  it('keeps unused HTTP module fields outside the eager footprint', () => {
    const own = fixture();
    let calls = 0;
    Object.defineProperty(own.ws.http, 'unrelated', {
      get() {
        calls += 1;
        return callback();
      },
    });

    expect(checking(own)).not.toThrow();
    expect(calls).toBe(0);
  });

  it('allows normal new string resolution-cache entries', () => {
    const own = fixture();
    object(own.loader['_pathCache'])['authored\0lookup'] = '/bundle/authored.js';

    expect(checking(own)).not.toThrow();
  });

  it('rejects cache entry accessors without invoking them', () => {
    const own = fixture();
    let calls = 0;
    Object.defineProperty(object(own.loader['_pathCache']), 'authored\0lookup', {
      get() {
        calls += 1;
        return '/bundle/authored.js';
      },
    });

    expect(checking(own)).toThrow('DATA string');
    expect(calls).toBe(0);
  });

  it.each([0, {}, callback()])('rejects non-string cache entry %#', (value) => {
    const own = fixture();
    object(own.loader['_pathCache'])['authored'] = value;

    expect(checking(own)).toThrow('DATA string');
  });

  it('rejects cache pointer replacement and prototype changes', () => {
    const own = fixture();
    const cache = object(own.loader['_pathCache']);
    own.loader['_pathCache'] = Object.create(null);

    expect(checking(own)).toThrow('descriptor changed');

    own.loader['_pathCache'] = cache;
    Object.setPrototypeOf(cache, {});

    expect(checking(own)).toThrow('prototype changed');
  });

  it.each(['_stat', '_readPackage'])('checks the trusted %s getter value after a setter', (key) => {
    const own = fixture();
    let calls = 0;
    own.loader[key] = () => {
      calls += 1;
      return 0;
    };

    expect(checking(own)).toThrow('root value changed');
    expect(calls).toBe(0);
  });

  it.each(['_stat', '_readPackage'])('rejects changed %s getters before invoking them', (key) => {
    const own = fixture();
    let calls = 0;
    Object.defineProperty(own.loader, key, {
      get() {
        calls += 1;
        return callback();
      },
    });

    expect(checking(own)).toThrow('descriptor changed');
    expect(calls).toBe(0);
  });

  it.each(['_findPath', '_resolveLookupPaths', '_nodeModulePaths'])(
    'seals the resolver %s function',
    (key) => {
      const own = fixture();
      own.loader[key] = callback();

      expect(checking(own)).toThrow('descriptor changed');
    },
  );

  it.each(['path', 'fs'] as const)(
    'rejects live %s callback getters without invocation',
    (module) => {
      const own = fixture();
      let calls = 0;
      Object.defineProperty(own.ws[module], module === 'path' ? 'resolve' : 'realpathSync', {
        get() {
          calls += 1;
          return callback();
        },
      });

      expect(checking(own)).toThrow('descriptor changed');
      expect(capturing(own)).toThrow('Unsupported Node JWT initialization');
      expect(calls).toBe(0);
    },
  );

  it.each([true, false])('allows normal filename cache growth with websocket=%s', (enabled) => {
    const own = fixture(enabled);
    object(own.loader['_cache'])['/bundle/ordinary.cjs'] = { exports: {} };

    expect(checking(own)).not.toThrow();
  });

  it.each(['buffer', 'crypto', 'stream', 'util'])('rejects a cached JWT bare builtin %s', (key) => {
    const own = fixture(false);
    object(own.loader['_cache'])[key] = { exports: {} };

    expect(checking(own)).toThrow('bare builtin shadowed');
  });

  it.each(['events', 'http', 'https', 'net', 'tls', 'url', 'zlib'])(
    'rejects a cached WS bare builtin %s',
    (key) => {
      const own = fixture();
      object(own.loader['_cache'])[key] = { exports: {} };

      expect(checking(own)).toThrow('bare builtin shadowed');
    },
  );

  it.each([true, false])('never invokes a cached builtin getter with websocket=%s', (enabled) => {
    const own = fixture(enabled);
    let calls = 0;
    Object.defineProperty(object(own.loader['_cache']), 'crypto', {
      get() {
        calls += 1;
        return { exports: {} };
      },
    });

    expect(checking(own)).toThrow('bare builtin shadowed');
    expect(capturing(own)).toThrow('bare builtin shadowed');
    expect(calls).toBe(0);
  });

  it('rejects module-cache pointer or prototype changes', () => {
    const own = fixture(false);
    const cache = object(own.loader['_cache']);
    own.loader['_cache'] = Object.create(null);

    expect(checking(own)).toThrow('descriptor changed');

    own.loader['_cache'] = cache;
    Object.setPrototypeOf(cache, {});

    expect(checking(own)).toThrow('prototype changed');
  });
});
