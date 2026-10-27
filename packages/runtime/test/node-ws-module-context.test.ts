import { describe, expect, it } from 'vitest';

import {
  assertNodeWsModuleContext,
  captureNodeWsModuleContext,
  type NodeWsModuleContext,
} from '../src/node-ws-module-context.ts';

type ObjectValue = Record<PropertyKey, unknown>;
const PARENT = Symbol('authored first Module parent');
const FILENAME = '/bundle/node_modules/next/dist/compiled/ws/index.js';
const DIRECTORY = '/bundle/node_modules/next/dist/compiled/ws';
const PATHS = ['/bundle/node_modules/next/dist/compiled/ws/node_modules', '/bundle/node_modules'];
function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null;
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) throw new Error('missing authored object');
  return value;
}
function ordinary() {
  return 1;
}
function fixture() {
  const proxies = new WeakSet<ObjectValue>();
  const prototype: ObjectValue = { require: () => 'authored operation never invoked' };
  const counter = { parentCalls: 0 };
  Object.defineProperty(prototype, 'parent', {
    configurable: true,
    get(this: unknown) {
      counter.parentCalls += 1;
      return object(this)[PARENT];
    },
  });
  const input = {
    prototype,
    isProxy: (value: unknown) => isObject(value) && proxies.has(value),
    parentDescriptor: Object.getOwnPropertyDescriptor(prototype, 'parent'),
    filename: FILENAME,
    directory: DIRECTORY,
    paths: [...PATHS],
  };
  const context = captureNodeWsModuleContext(input);
  function module(filename = FILENAME, parent?: unknown): ObjectValue {
    const receiver = object(Object.create(prototype));
    Object.assign(receiver, { filename, id: filename, path: DIRECTORY, paths: [...PATHS] });
    receiver[PARENT] = parent;
    return receiver;
  }
  const receiver = module();
  function proxy(target: unknown) {
    const calls = { traps: 0 };
    const value = new Proxy(object(target), {
      getPrototypeOf(owner) {
        calls.traps += 1;
        return Reflect.getPrototypeOf(owner);
      },
      ownKeys(owner) {
        calls.traps += 1;
        return Reflect.ownKeys(owner);
      },
      getOwnPropertyDescriptor(owner, key) {
        calls.traps += 1;
        return Reflect.getOwnPropertyDescriptor(owner, key);
      },
    });
    proxies.add(value);
    return { value, calls };
  }
  return { input, context, receiver, prototype, counter, module, proxy };
}
function check(own: ReturnType<typeof fixture>) {
  return () => {
    assertNodeWsModuleContext(own.context, own.receiver);
  };
}
function proxyReceiver(own: ReturnType<typeof fixture>) {
  const proxy = own.proxy(own.receiver);
  own.receiver = object(proxy.value);
  return proxy;
}
function proxyParent(own: ReturnType<typeof fixture>) {
  const proxy = own.proxy(own.module('/bundle/parent.cjs'));
  own.receiver[PARENT] = proxy.value;
  return proxy;
}
function proxyPaths(own: ReturnType<typeof fixture>) {
  const proxy = own.proxy([...PATHS]);
  own.receiver['paths'] = proxy.value;
  return proxy;
}

describe('fixed WS CommonJS receiver context using authored objects only', () => {
  it('accepts the captured default coordinate without executing a require or module', () => {
    const own = fixture();
    assertNodeWsModuleContext(own.context, own.receiver);

    expect(own.counter.parentCalls).toBe(1);
  });

  it('walks genuine parent DATA through the original getter and permits a main id', () => {
    const own = fixture();
    const parent = own.module('/bundle/main.cjs', null);
    parent['id'] = '.';
    own.receiver[PARENT] = parent;
    assertNodeWsModuleContext(own.context, own.receiver);

    expect(own.counter.parentCalls).toBe(2);
  });

  it('does not read an application own parent getter instead of the trusted getter', () => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.receiver, 'parent', {
      get: () => {
        called = true;
        return {};
      },
    });
    assertNodeWsModuleContext(own.context, own.receiver);

    expect(called).toBe(false);
  });

  it('has cycle detection without an arbitrary parent-depth limit', () => {
    const own = fixture();
    let parent: unknown;
    for (let index = 0; index < 2048; index += 1)
      parent = own.module(`/bundle/parent-${index}.cjs`, parent);
    own.receiver[PARENT] = parent;
    assertNodeWsModuleContext(own.context, own.receiver);

    expect(own.counter.parentCalls).toBe(2049);

    own.receiver[PARENT] = own.receiver;

    expect(check(own)).toThrow('cyclic');
  });

  it('captures lookup strings without retaining the mutable bootstrap array', () => {
    const own = fixture();
    own.input.paths[0] = '/changed';

    expect(check(own)).not.toThrow();
  });

  it.each(['filename', 'id', 'path'])('rejects a changed own coordinate %s', (key) => {
    const own = fixture();
    own.receiver[key] = '/different';

    expect(check(own)).toThrow('coordinate');
  });

  it.each(['filename', 'id', 'path', 'paths'])('never invokes an own %s getter', (key) => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.receiver, key, {
      get: () => {
        called = true;
        return FILENAME;
      },
    });

    expect(check(own)).toThrow('DATA');
    expect(called).toBe(false);
  });

  it('rejects an own require accessor without invoking it', () => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.receiver, 'require', {
      get: () => {
        called = true;
        return ordinary;
      },
    });

    expect(check(own)).toThrow('coordinate');
    expect(called).toBe(false);
  });

  it('rejects an own require DATA replacement', () => {
    const own = fixture();
    own.receiver['require'] = ordinary;

    expect(check(own)).toThrow('coordinate');
  });

  it.each([
    { kind: 'receiver', install: proxyReceiver },
    { kind: 'parent', install: proxyParent },
    { kind: 'paths', install: proxyPaths },
  ])('checks $kind proxies before any traps', ({ install }) => {
    const own = fixture();
    const proxy = install(own);

    expect(check(own)).toThrow('proxy');
    expect(proxy.calls.traps).toBe(0);
  });

  it.each([undefined, null, {}, [], () => 0])('rejects a non-default receiver %s', (value) => {
    const own = fixture();

    expect(() => {
      assertNodeWsModuleContext(own.context, value);
    }).toThrow('Module');
  });

  it.each(['filename', 'id'])('never reads a parent %s accessor', (key) => {
    const own = fixture();
    const parent = own.module('/bundle/parent.cjs');
    let called = false;
    Object.defineProperty(parent, key, {
      get: () => {
        called = true;
        return FILENAME;
      },
    });
    own.receiver[PARENT] = parent;

    expect(check(own)).toThrow('DATA');
    expect(called).toBe(false);
  });

  it('rejects a non-string parent filename instead of allowing coercion', () => {
    const own = fixture();
    const parent = own.module('/bundle/parent.cjs');
    parent['filename'] = null;
    own.receiver[PARENT] = parent;

    expect(check(own)).toThrow('non-string');
  });

  it.each(['parent', 'prototype'] as const)(
    'rejects %s Symbol accessors before the parent getter',
    (where) => {
      const own = fixture();
      const parent = own.module('/bundle/parent.cjs');
      let called = false;
      const owner = where === 'parent' ? parent : own.prototype;
      Object.defineProperty(owner, PARENT, {
        get: () => {
          called = true;
        },
      });
      own.receiver[PARENT] = parent;

      expect(check(own)).toThrow('accessor');
      expect(called).toBe(false);
    },
  );

  it('rejects a receiver private Symbol accessor before invoking the trusted getter', () => {
    const own = fixture();
    let called = false;
    Object.defineProperty(own.receiver, PARENT, {
      get: () => {
        called = true;
      },
    });

    expect(check(own)).toThrow('accessor');
    expect(called).toBe(false);
    expect(own.counter.parentCalls).toBe(0);
  });

  it.each([
    [],
    [...PATHS, '/extra'],
    ['/different', PATHS[1]],
    [PATHS[1], PATHS[0]],
    { 0: PATHS[0], length: 1 },
  ])('rejects a different default lookup vector %#', (value) => {
    const own = fixture();
    own.receiver['paths'] = value;

    expect(check(own)).toThrow('Module');
  });

  it('rejects sparse or accessor lookup entries without invoking a getter', () => {
    const own = fixture();
    const sparse = [...PATHS];
    Reflect.deleteProperty(sparse, '0');
    own.receiver['paths'] = sparse;

    expect(check(own)).toThrow('dense');

    let called = false;
    const entries = [...PATHS];
    Object.defineProperty(entries, '0', {
      get: () => {
        called = true;
        return '/different';
      },
    });
    own.receiver['paths'] = entries;

    expect(check(own)).toThrow('DATA');
    expect(called).toBe(false);
  });

  it.each(['require', 'parent'])('rejects a changed Module prototype %s descriptor', (key) => {
    const own = fixture();
    Object.defineProperty(own.prototype, key, { value: ordinary, configurable: true });

    expect(check(own)).toThrow('descriptors changed');
  });

  it('rejects a changed inherited prototype before walking a parent', () => {
    const own = fixture();
    Object.setPrototypeOf(own.prototype, {});

    expect(check(own)).toThrow('prototype chain');
  });

  it('rejects a copied token independently of module shape', () => {
    const own = fixture();
    const forged = {} as NodeWsModuleContext;

    expect(() => {
      assertNodeWsModuleContext(forged, own.receiver);
    }).toThrow('copied');
  });

  it('requires the captured original getter descriptor at bootstrap', () => {
    const own = fixture();

    expect(() => captureNodeWsModuleContext({ ...own.input, parentDescriptor: undefined })).toThrow(
      'basis',
    );
    expect(() =>
      captureNodeWsModuleContext({ ...own.input, parentDescriptor: { get: () => null } }),
    ).toThrow('basis');
  });
});
