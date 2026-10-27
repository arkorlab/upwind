import { describe, expect, it } from 'vitest';

import {
  assertNodeJwtSemverCache,
  assertNodeJwtSemverStart,
  createNodeJwtSemverGuard,
  rememberNodeJwtSemver,
  type NodeJwtSemverGuard,
} from '../src/node-jwt-semver-guard.ts';

type ObjectValue = Record<PropertyKey, unknown>;
const FILENAME = '/bundle/node_modules/next/dist/lib/semver-noop.js';
function isObject(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) throw new Error('missing authored object');
  return value;
}
function ordinary() {
  return true;
}
/** Authored Module/cache objects only; no actual Node Module or semver source executes. */
function fixture() {
  const cache = object(Object.create(null));
  const proxies = new WeakSet<ObjectValue>();
  const isProxy = (value: unknown) => isObject(value) && proxies.has(value);
  const input = { filename: FILENAME, cache, isProxy };
  const guard = createNodeJwtSemverGuard(input);
  const module: ObjectValue = { filename: FILENAME, loaded: false, exports: {} };
  const calls = { getters: 0 };
  function populate(receiver = module) {
    Object.defineProperties(object(receiver['exports']), {
      __esModule: { value: true },
      satisfies: {
        enumerable: true,
        get() {
          calls.getters += 1;
          return ordinary;
        },
      },
    });
  }
  function observe(receiver = module) {
    cache[FILENAME] = receiver;
    assertNodeJwtSemverStart(guard, receiver);
    populate(receiver);
    rememberNodeJwtSemver(guard, receiver);
    receiver['loaded'] = true; // Default Module.load does this after _compile returns.
  }
  function proxy(value: unknown) {
    const counter = { traps: 0 };
    const wrapped = new Proxy(object(value), {
      getPrototypeOf(owner) {
        counter.traps += 1;
        return Reflect.getPrototypeOf(owner);
      },
      getOwnPropertyDescriptor(owner, key) {
        counter.traps += 1;
        return Reflect.getOwnPropertyDescriptor(owner, key);
      },
      ownKeys(owner) {
        counter.traps += 1;
        return Reflect.ownKeys(owner);
      },
    });
    proxies.add(wrapped);
    return { wrapped, counter };
  }
  return { input, cache, guard, module, calls, populate, observe, proxy };
}
function cacheCheck(own: ReturnType<typeof fixture>) {
  return () => {
    assertNodeJwtSemverCache(own.guard);
  };
}
function start(own: ReturnType<typeof fixture>) {
  return () => {
    assertNodeJwtSemverStart(own.guard, own.module);
  };
}
function remember(own: ReturnType<typeof fixture>) {
  return () => {
    rememberNodeJwtSemver(own.guard, own.module);
  };
}

describe('observed original semver cache state with pure mocks', () => {
  it('allows an absent exact key and leaves unrelated cache getters untouched', () => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.cache, '/ordinary', {
      get: () => {
        called = true;
        return {};
      },
    });

    expect(cacheCheck(own)).not.toThrow();
    expect(called).toBe(false);
  });

  it('records after compile while loaded=false, then validates only loaded=true at JWT use', () => {
    const own = fixture();
    own.cache[FILENAME] = own.module;
    assertNodeJwtSemverStart(own.guard, own.module);
    own.populate();
    rememberNodeJwtSemver(own.guard, own.module);

    expect(cacheCheck(own)).toThrow('loaded state');

    own.module['loaded'] = true;

    expect(cacheCheck(own)).not.toThrow();
    expect(own.calls.getters).toBe(0);
  });

  it('does not recognize a populated but unobserved lookalike namespace', () => {
    const own = fixture();
    own.populate();
    own.module['loaded'] = true;
    own.cache[FILENAME] = own.module;

    expect(cacheCheck(own)).toThrow('unobserved');
  });

  it.each([undefined, {}, 0])('rejects a preexisting own cache entry %#', (value) => {
    const own = fixture();
    own.cache[FILENAME] = value;

    expect(() => createNodeJwtSemverGuard(own.input)).toThrow('before observation');
    expect(cacheCheck(own)).toThrow('unobserved');
  });

  it('rejects a cache accessor without invoking it', () => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.cache, FILENAME, {
      get: () => {
        called = true;
        return own.module;
      },
    });

    expect(cacheCheck(own)).toThrow('accessor');
    expect(start(own)).toThrow('accessor');
    expect(called).toBe(false);
  });

  it('requires the actual initializing cached module and refuses overlapping observation', () => {
    const own = fixture();

    expect(start(own)).toThrow('initialization');

    own.cache[FILENAME] = own.module;
    assertNodeJwtSemverStart(own.guard, own.module);

    expect(start(own)).toThrow('overlapping');
    expect(cacheCheck(own)).toThrow('incomplete');
  });

  it.each([
    { filename: '/different' },
    { loaded: true },
    { exports: { already: true } },
    { exports: Object.create(null) as unknown },
  ])('requires default precompile coordinates and original empty plain exports %#', (delta) => {
    const own = fixture();
    Object.assign(own.module, delta);
    own.cache[FILENAME] = own.module;

    expect(start(own)).toThrow('semver');
  });

  it.each(['filename', 'loaded', 'exports'])(
    'does not invoke a precompile Module %s getter',
    (key) => {
      const own = fixture();
      let called = false;
      Object.defineProperty(own.module, key, {
        get: () => {
          called = true;
          return {};
        },
      });
      own.cache[FILENAME] = own.module;

      expect(start(own)).toThrow('DATA');
      expect(called).toBe(false);
    },
  );

  it('checks receiver and exports proxies before any traps', () => {
    const own = fixture();
    const moduleProxy = own.proxy(own.module);
    own.cache[FILENAME] = moduleProxy.wrapped;

    expect(() => {
      assertNodeJwtSemverStart(own.guard, moduleProxy.wrapped);
    }).toThrow('proxy');

    const exportsProxy = own.proxy({});
    own.module['exports'] = exportsProxy.wrapped;
    own.cache[FILENAME] = own.module;

    expect(start(own)).toThrow('proxy');
    expect(moduleProxy.counter.traps + exportsProxy.counter.traps).toBe(0);
  });

  it('requires the paired original start before remembering a result', () => {
    const own = fixture();
    own.cache[FILENAME] = own.module;
    own.populate();

    expect(remember(own)).toThrow('unobserved');
  });

  it('requires the same original exports object after original compile', () => {
    const own = fixture();
    own.cache[FILENAME] = own.module;
    assertNodeJwtSemverStart(own.guard, own.module);
    own.module['exports'] = {};
    own.populate();

    expect(remember(own)).toThrow('replaced original');
  });

  it('requires the initializing cache pointer to remain unchanged at remember', () => {
    const own = fixture();
    own.cache[FILENAME] = own.module;
    assertNodeJwtSemverStart(own.guard, own.module);
    own.populate();
    own.cache[FILENAME] = {};

    expect(remember(own)).toThrow('unobserved');
  });

  it.each([
    { __esModule: { value: false } },
    { __esModule: { value: true, writable: true } },
    { satisfies: { value: ordinary } },
    { satisfies: { get: ordinary, enumerable: false } },
    { satisfies: { get: ordinary, enumerable: true, configurable: true } },
  ])('requires the exact original two-property namespace shape %#', (delta) => {
    const own = fixture();
    own.cache[FILENAME] = own.module;
    assertNodeJwtSemverStart(own.guard, own.module);
    Object.defineProperties(object(own.module['exports']), {
      __esModule: { value: true },
      satisfies: { get: ordinary, enumerable: true },
      ...delta,
    });

    expect(remember(own)).toThrow('namespace');
  });

  it('checks cache module and exports identities after observation', () => {
    const own = fixture();
    own.observe();
    own.cache[FILENAME] = { ...own.module };

    expect(cacheCheck(own)).toThrow('unobserved');

    own.cache[FILENAME] = own.module;
    own.module['exports'] = {};

    expect(cacheCheck(own)).toThrow('exports');
  });

  it.each(['loaded', 'exports'])('does not invoke an observed Module %s accessor', (key) => {
    const own = fixture();
    own.observe();
    let called = false;
    Object.defineProperty(own.module, key, {
      get: () => {
        called = true;
        return {};
      },
    });

    expect(cacheCheck(own)).toThrow('DATA');
    expect(called).toBe(false);
  });

  it('checks namespace prototype and extra properties without invoking getters', () => {
    const own = fixture();
    own.observe();
    const exports = object(own.module['exports']);
    Object.setPrototypeOf(exports, null);

    expect(cacheCheck(own)).toThrow('plain');

    Object.setPrototypeOf(exports, Object.prototype);
    let called = false;
    Object.defineProperty(exports, 'extra', {
      get: () => {
        called = true;
        return {};
      },
    });

    expect(cacheCheck(own)).toThrow('namespace');
    expect(called).toBe(false);
    expect(own.calls.getters).toBe(0);
  });

  it('allows eviction and a fresh observed initialization without any private replay', () => {
    const own = fixture();
    own.observe();
    Reflect.deleteProperty(own.cache, FILENAME);

    expect(cacheCheck(own)).not.toThrow();

    const module = { filename: FILENAME, exports: {}, loaded: false };
    own.observe(module);

    expect(cacheCheck(own)).not.toThrow();
    expect(own.calls.getters).toBe(0);
  });

  it('checks the cache prototype and rejects cache proxies before traps', () => {
    const own = fixture();
    Object.setPrototypeOf(own.cache, {});

    expect(cacheCheck(own)).toThrow('cache prototype');

    const proxy = own.proxy(Object.create(null));

    expect(() => createNodeJwtSemverGuard({ ...own.input, cache: proxy.wrapped })).toThrow('proxy');
    expect(proxy.counter.traps).toBe(0);
  });

  it('refuses copied guards at every entry point', () => {
    const own = fixture();
    const forged = {} as NodeJwtSemverGuard;

    expect(() => {
      assertNodeJwtSemverCache(forged);
    }).toThrow('copied');
    expect(() => {
      assertNodeJwtSemverStart(forged, own.module);
    }).toThrow('copied');
    expect(() => {
      rememberNodeJwtSemver(forged, own.module);
    }).toThrow('copied');
  });
});
