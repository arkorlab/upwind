import { describe, expect, it } from 'vitest';

import {
  assertNodeFixedLoadScope,
  assertNodeFixedLoadScopeHealthy,
  createNodeFixedLoadScope,
  enterNodeFixedLoadScope,
  leaveNodeFixedLoadScope,
  poisonNodeFixedLoadScope,
  type NodeFixedLoadLease,
  type NodeFixedLoadScope,
} from '../src/node-fixed-load-scope.ts';

type ObjectValue = Record<PropertyKey, unknown>;
const JWT = '/bundle/node_modules/next/dist/compiled/jsonwebtoken/index.js';
const JWT_DIR = '/bundle/node_modules/next/dist/compiled/jsonwebtoken';
const WS = '/bundle/node_modules/next/dist/compiled/ws/index.js';
const WS_DIR = '/bundle/node_modules/next/dist/compiled/ws';
function isObject(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) throw new Error('missing authored object');
  return value;
}
/** All requests/parents and evaluation events are authored DATA; no actual Node load occurs. */
function fixture() {
  const proxies = new WeakSet<ObjectValue>();
  const first = {
    filename: JWT,
    directory: JWT_DIR,
    requests: ['crypto', 'buffer', 'next/dist/lib/semver-noop'],
  };
  const sources = [
    first,
    {
      filename: WS,
      directory: WS_DIR,
      requests: ['crypto', 'stream', 'bufferutil', 'utf-8-validate'],
    },
  ];
  const input = { sources, isProxy: (value: unknown) => isObject(value) && proxies.has(value) };
  const scope = createNodeFixedLoadScope(input);
  const jwt = { path: JWT_DIR, filename: JWT };
  const ws = { path: WS_DIR, filename: WS };
  function proxy(value: unknown) {
    const calls = { traps: 0 };
    const wrapped = new Proxy(object(value), {
      getOwnPropertyDescriptor(owner, key) {
        calls.traps += 1;
        return Reflect.getOwnPropertyDescriptor(owner, key);
      },
      getPrototypeOf(owner) {
        calls.traps += 1;
        return Reflect.getPrototypeOf(owner);
      },
      get(owner, key) {
        calls.traps += 1;
        return Reflect.get(owner, key);
      },
    });
    proxies.add(wrapped);
    return { wrapped, calls };
  }
  return { sources, first, input, scope, jwt, ws, proxy };
}
function lease(own: ReturnType<typeof fixture>, filename = JWT, receiver: unknown = own.jwt) {
  const active = enterNodeFixedLoadScope(own.scope, filename, receiver);
  if (active === undefined) throw new Error('missing authored lease');
  return active;
}
function healthy(own: ReturnType<typeof fixture>, active: NodeFixedLoadLease) {
  return () => {
    assertNodeFixedLoadScopeHealthy(own.scope, active);
  };
}

describe('transparent fixed load history DATA fence using pure mocks', () => {
  it('accepts only an exact active receiver for its own fixed request set', () => {
    const own = fixture();
    const active = lease(own);

    expect(assertNodeFixedLoadScope(own.scope, 'crypto', own.jwt)).toStrictEqual({ filename: JWT });
    expect(assertNodeFixedLoadScope(own.scope, 'next/dist/lib/semver-noop', own.jwt)).toStrictEqual(
      { filename: JWT },
    );
    expect(healthy(own, active)).not.toThrow();

    leaveNodeFixedLoadScope(own.scope, active);

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', own.jwt)).toThrow('outside actual');
  });

  it('rejects prior same-directory loads regardless of a claimed filename', () => {
    const own = fixture();
    const parent = { path: JWT_DIR, filename: '/bundle/foreign.cjs' };

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', parent)).toThrow('outside actual');
    expect(() => assertNodeFixedLoadScope(own.scope, 'bufferutil', own.ws)).toThrow(
      'outside actual',
    );
  });

  it('never reads a filename to infer authority', () => {
    const own = fixture();
    let called = false;
    const parent = { path: JWT_DIR };
    Object.defineProperty(parent, 'filename', {
      get: () => {
        called = true;
        return JWT;
      },
    });

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', parent)).toThrow('outside actual');
    expect(called).toBe(false);
  });

  it.each(['unrelated', 'node:crypto', '', undefined, null, 0, {}])(
    'does not inspect parent for irrelevant request %#',
    (request) => {
      const own = fixture();
      const proxy = own.proxy({});

      expect(assertNodeFixedLoadScope(own.scope, request, proxy.wrapped)).toBeUndefined();
      expect(proxy.calls.traps).toBe(0);
    },
  );

  it.each([undefined, null])('does not invent a path key for an absent parent %s', (parent) => {
    const own = fixture();
    const active = lease(own);

    expect(assertNodeFixedLoadScope(own.scope, 'crypto', parent)).toBeUndefined();
    expect(healthy(own, active)).not.toThrow();
  });

  it('leaves unrelated directories and other literal request keys unscoped', () => {
    const own = fixture();

    expect(assertNodeFixedLoadScope(own.scope, 'crypto', { path: '/ordinary' })).toBeUndefined();
    expect(
      assertNodeFixedLoadScope(own.scope, 'next/dist/lib/semver-noop', own.ws),
    ).toBeUndefined();
  });

  it('checks relevant parent proxies before descriptor or prototype traps', () => {
    const own = fixture();
    const active = lease(own);
    const proxy = own.proxy(own.jwt);

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', proxy.wrapped)).toThrow('proxy');
    expect(proxy.calls.traps).toBe(0);
    expect(healthy(own, active)).toThrow('proxy');
  });

  it('rejects relevant parent path accessors without invoking them', () => {
    const own = fixture();
    const active = lease(own);
    let called = false;
    const parent = {};
    Object.defineProperty(parent, 'path', {
      get: () => {
        called = true;
        return JWT_DIR;
      },
    });

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', parent)).toThrow('own DATA');
    expect(called).toBe(false);
    expect(healthy(own, active)).toThrow('own DATA');
  });

  it.each([
    {},
    { path: undefined },
    { path: 1 },
    { path: {} },
    Object.create({ path: JWT_DIR }) as unknown,
  ])('requires an own string path for relevant requests %#', (parent) => {
    const own = fixture();

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', parent)).toThrow('own DATA');
  });

  it('rejects an alias object even if all source coordinates are equal', () => {
    const own = fixture();
    const active = lease(own);

    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', { ...own.jwt })).toThrow(
      'outside actual',
    );
    expect(healthy(own, active)).toThrow('outside actual');
  });

  it('requires the lease for the matching source directory and request', () => {
    const own = fixture();
    const active = lease(own, WS, own.ws);

    expect(assertNodeFixedLoadScope(own.scope, 'bufferutil', own.ws)).toStrictEqual({
      filename: WS,
    });
    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', own.jwt)).toThrow('outside actual');
    expect(healthy(own, active)).toThrow('outside actual');
  });

  it('keeps faults sticky beyond an original vendor catch and cleans in finally', () => {
    const own = fixture();
    const active = lease(own, WS, own.ws);
    const original = { reason: 'authored unsupported optional success' };
    poisonNodeFixedLoadScope(own.scope, WS, original);
    let caught: unknown;
    try {
      assertNodeFixedLoadScopeHealthy(own.scope, active);
    } catch (error) {
      caught = error;
    } finally {
      leaveNodeFixedLoadScope(own.scope, active);
    }

    expect(Object.getOwnPropertyDescriptor(object(caught), 'cause')?.value).toBe(original);

    const next = lease(own, WS, own.ws);

    expect(healthy(own, next)).not.toThrow();

    leaveNodeFixedLoadScope(own.scope, next);
  });

  it('retains the first fault without reading an arbitrary later error', () => {
    const own = fixture();
    const active = lease(own);
    const first = {};
    poisonNodeFixedLoadScope(own.scope, JWT, first);
    const proxy = own.proxy({});
    poisonNodeFixedLoadScope(own.scope, JWT, proxy.wrapped);
    let caught: unknown;
    try {
      assertNodeFixedLoadScopeHealthy(own.scope, active);
    } catch (error) {
      caught = error;
    }

    expect(Object.getOwnPropertyDescriptor(object(caught), 'cause')?.value).toBe(first);
    expect(proxy.calls.traps).toBe(0);
    expect(() => assertNodeFixedLoadScope(own.scope, 'crypto', own.jwt)).toThrow(
      'guarded load failed',
    );
  });

  it('rejects overlap and preserves the outer lease for final cleanup', () => {
    const own = fixture();
    const active = lease(own);

    expect(() => enterNodeFixedLoadScope(own.scope, WS, own.ws)).toThrow('overlapping');
    expect(healthy(own, active)).toThrow('overlapping');

    leaveNodeFixedLoadScope(own.scope, active);
    const next = lease(own, WS, own.ws);

    expect(healthy(own, next)).not.toThrow();
  });

  it('does not alter an active lease for nested unregistered sources', () => {
    const own = fixture();
    const active = lease(own);
    const proxy = own.proxy({});

    expect(
      enterNodeFixedLoadScope(own.scope, '/derived/semver-noop.js', proxy.wrapped),
    ).toBeUndefined();
    expect(proxy.calls.traps).toBe(0);
    expect(assertNodeFixedLoadScope(own.scope, 'crypto', own.jwt)).toStrictEqual({ filename: JWT });
    expect(healthy(own, active)).not.toThrow();
  });

  it('rejects stale, copied and foreign scope/lease handles', () => {
    const own = fixture();
    const active = lease(own);
    const other = fixture();
    const foreign = lease(other);

    expect(() => {
      assertNodeFixedLoadScopeHealthy(own.scope, foreign);
    }).toThrow('foreign');

    leaveNodeFixedLoadScope(own.scope, active);

    expect(() => {
      leaveNodeFixedLoadScope(own.scope, active);
    }).toThrow('closed');

    const fakeLease = {} as NodeFixedLoadLease;
    const fakeScope = {} as NodeFixedLoadScope;

    expect(() => {
      assertNodeFixedLoadScopeHealthy(own.scope, fakeLease);
    }).toThrow('foreign');
    expect(() => assertNodeFixedLoadScope(fakeScope, 'unrelated', {})).toThrow('copied');
  });

  it('captures original coordinate/request DATA rather than retaining caller lists', () => {
    const own = fixture();
    const first = own.first;
    first.requests.push('later');
    first.filename = '/different';
    first.directory = '/different';
    const active = lease(own);

    expect(assertNodeFixedLoadScope(own.scope, 'later', own.jwt)).toBeUndefined();
    expect(assertNodeFixedLoadScope(own.scope, 'crypto', own.jwt)).toStrictEqual({ filename: JWT });
    expect(healthy(own, active)).not.toThrow();
  });

  it.each(
    [
      [{ filename: JWT, directory: JWT_DIR, requests: [] }],
      [{ filename: JWT, directory: JWT_DIR, requests: ['crypto', 'crypto'] }],
      [{ filename: JWT, directory: JWT_DIR, requests: [''] }],
      [{ filename: '', directory: JWT_DIR, requests: ['crypto'] }],
      [
        { filename: JWT, directory: JWT_DIR, requests: ['crypto'] },
        { filename: JWT, directory: WS_DIR, requests: ['crypto'] },
      ],
      [
        { filename: JWT, directory: JWT_DIR, requests: ['crypto'] },
        { filename: WS, directory: JWT_DIR, requests: ['crypto'] },
      ],
    ].map((sources) => ({ sources })),
  )('rejects ambiguous bootstrap fixed inventories %#', ({ sources }) => {
    const own = fixture();

    expect(() => createNodeFixedLoadScope({ ...own.input, sources })).toThrow('fixed');
  });
});
