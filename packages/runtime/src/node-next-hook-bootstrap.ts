import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProxy } from 'node:util/types';

import { nodeInitializationBuiltins } from './node-initialization-builtins.ts';
import {
  assertNodeJwtRealm,
  assertNodeJwtRealmStructure,
  captureNodeNextJwtRealm,
} from './node-jwt-realm.ts';
import { assertNodeNextHookMap, captureNodeNextHookMap } from './node-next-hook-map.ts';
import { nodeNextHookRecord } from './node-next-hook-record.ts';
import { assertNodeWsModuleContext, captureNodeWsModuleContext } from './node-ws-module-context.ts';

type ObjectValue = Record<PropertyKey, unknown>;
type Method = (this: unknown, ...args: unknown[]) => unknown;
interface Slot {
  readonly owner: ObjectValue;
  readonly key: string;
  readonly descriptor: PropertyDescriptor;
}
export interface NodeNextHookExpected {
  readonly load: unknown;
  readonly require: unknown;
  readonly compile: unknown;
}
export interface NodeNextHookBootstrap {
  readonly filename: string;
  assert(): void;
  assertCachedLoad(): void;
  complete(expected: NodeNextHookExpected): void;
  restore(): void;
}
const descriptorOf = Object.getOwnPropertyDescriptor;
const descriptorsOf = Object.getOwnPropertyDescriptors;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const defineProperty = Object.defineProperty;
const apply = Reflect.apply;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const NativeError = Error;
const proxyCheck = isProxy;
const SHARED = '.shared-runtime';
const CONTEXTS = 'next/dist/server/route-modules/pages/vendored/contexts/';
const DEFAULT_KEYS = ['styled-jsx', 'styled-jsx/style', 'styled-jsx/style.js'];
const EXPORT_COUNT = 4;
const installed = { active: false };

function fail(reason: string): never {
  throw new NativeError(`Unsupported Next require hook bootstrap: ${reason}`);
}
function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'function' || (typeof value === 'object' && value !== null);
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) fail('missing object');
  if (proxyCheck(value)) fail('proxy object');
  return value;
}
function data(owner: ObjectValue, key: PropertyKey): unknown {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) fail('required own DATA');
  const value: unknown = descriptor.value;
  return value;
}
function callable(value: unknown): value is Method {
  return typeof value === 'function';
}
function method(value: unknown): Method {
  return callable(value) ? value : fail('missing loader method');
}
function slot(owner: unknown, key: string): Slot {
  const at = object(owner);
  const descriptor = descriptorOf(at, key);
  if (descriptor === undefined || !hasOwn(descriptor, 'value')) fail('loader slot is not DATA');
  method(descriptor.value);
  return freeze({ owner: at, key, descriptor: freeze(descriptor) });
}
function same(left: PropertyDescriptor | undefined, right: PropertyDescriptor): boolean {
  return (
    left !== undefined &&
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    hasOwn(left, 'value') === hasOwn(right, 'value') &&
    (hasOwn(right, 'value')
      ? left.writable === right.writable && left.value === right.value
      : left.get === right.get && left.set === right.set)
  );
}
function assertSlot(own: Slot, value: unknown): void {
  if (!same(descriptorOf(own.owner, own.key), { ...own.descriptor, value }))
    fail('loader chain changed');
}
function setSlot(own: Slot, value: unknown): void {
  defineProperty(own.owner, own.key, { ...own.descriptor, value });
}
function canonical(root: string, relative: string): string {
  const filename = path.resolve(root, relative);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- A finite build-qualified archive coordinate; canonical regular files only.
  const real = realpathSync(filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The same canonical archive file, never a request path.
  const regular = statSync(filename).isFile();
  if (!regular || real !== filename || !filename.startsWith(`${root}${path.sep}`))
    fail('non-canonical regular archive file');
  return filename;
}
function context(filename: string) {
  const directory = path.dirname(filename);
  const paths: unknown = apply(method(descriptorOf(Module, '_nodeModulePaths')?.value), Module, [
    directory,
  ]);
  if (
    !Array.isArray(paths) ||
    !paths.every((value: unknown): value is string => typeof value === 'string')
  )
    fail('default Node lookup paths');
  return captureNodeWsModuleContext({
    prototype: Module.prototype,
    isProxy: proxyCheck,
    parentDescriptor: descriptorOf(Module.prototype, 'parent'),
    directory,
    filename,
    paths,
  });
}
function cached(cache: ObjectValue, filename: string, directory: string): ObjectValue {
  const current = object(data(cache, filename));
  if (
    prototypeOf(current) !== Module.prototype ||
    data(current, 'filename') !== filename ||
    data(current, 'id') !== filename ||
    data(current, 'path') !== directory ||
    descriptorOf(current, 'require') !== undefined
  )
    fail('foreign cached Module');
  return current;
}
function snapshot(value: unknown) {
  const owner = object(value);
  const prototype: unknown = prototypeOf(owner);
  const keys = ownKeys(owner);
  const properties = descriptorsOf(owner);
  return () => {
    if (proxyCheck(owner) || prototypeOf(owner) !== prototype) fail('hook namespace changed');
    const actual = ownKeys(owner);
    if (actual.length !== keys.length) fail('hook namespace keys changed');
    let index = 0;
    while (index < keys.length) {
      const key = keys[index];
      index += 1;
      const expected = key === undefined ? undefined : properties[key];
      if (
        key === undefined ||
        expected === undefined ||
        actual[index - 1] !== key ||
        !same(descriptorOf(owner, key), expected)
      )
        fail('hook namespace descriptor changed');
    }
  };
}
function hookExports(value: unknown, expected: readonly (readonly [string, string])[]) {
  const exports = object(value);
  const keys = ownKeys(exports);
  if (keys.length !== EXPORT_COUNT || data(exports, '__esModule') !== true)
    fail('hook export inventory');
  const values: ObjectValue = {};
  for (const key of ['addHookAliases', 'defaultOverrides', 'hookPropertyMap']) {
    const descriptor = descriptorOf(exports, key);
    if (
      descriptor === undefined ||
      typeof descriptor.get !== 'function' ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== false
    )
      fail('hook export descriptor');
    const getter: unknown = descriptorOf(descriptor, 'get')?.value;
    values[key] = apply(method(getter), exports, []);
  }
  method(values['addHookAliases']);
  const overrides = object(values['defaultOverrides']);
  if (prototypeOf(overrides) !== Object.prototype) fail('default override DATA');
  const names = ownKeys(overrides);
  if (names.length > 0 && names.length !== DEFAULT_KEYS.length)
    fail('partial first-stage overrides');
  let index = 0;
  while (index < names.length) {
    const key = names[index];
    const expectedKey = DEFAULT_KEYS[index];
    index += 1;
    if (typeof key !== 'string' || expectedKey === undefined) fail('default override key');
    if (key !== expectedKey || typeof data(overrides, key) !== 'string')
      fail('default override inventory');
  }
  const map: unknown = values['hookPropertyMap'];
  const guard = captureNodeNextHookMap({ map, expected, isProxy: proxyCheck });
  const assertExports = snapshot(exports);
  const assertOverrides = snapshot(overrides);
  return () => {
    assertExports();
    assertOverrides();
    assertNodeNextHookMap(guard, map);
  };
}

/** Trusted synchronous pre-app setup only. No source rewrite, preload of app code, or new loader role. */
export function initializeNodeNextRequireHook(
  serverUrl: string,
  supplied: unknown,
): NodeNextHookBootstrap {
  if (
    installed.active ||
    process.versions.node !== '24.22.1' ||
    process.execArgv.length > 0 ||
    (process.env['NEXT_MINIMAL'] !== undefined && process.env['NEXT_MINIMAL'] !== '')
  )
    fail('requires fixed default Node startup');
  const config = nodeNextHookRecord(supplied, proxyCheck);
  const server = fileURLToPath(serverUrl);
  const root = path.dirname(path.dirname(server));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- SDK-owned archive root derived from its own server URL.
  if (realpathSync(root) !== root) fail('non-canonical archive root');
  const filename = canonical(root, config.record.archivePath);
  const directory = path.dirname(filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only the canonical fixed-size, fixed-hash hook source.
  const source = readFileSync(filename, 'utf8');
  if (
    Buffer.byteLength(source) !== config.record.bytes ||
    createHash('sha256').update(source).digest('hex') !== config.record.sha256
  )
    fail('fixed hook source changed');
  const require = createRequire(serverUrl);
  if (require.resolve(filename) !== filename) fail('hook is not default CommonJS source');
  const cache = object(require.cache);
  if (descriptorOf(cache, filename) !== undefined) fail('hook already evaluated');
  const expectedAliases = Array.from(config.aliases, (alias) =>
    freeze([alias.request, canonical(root, alias.target)] as const),
  );
  const edges = config.sharedRuntimeEdges.map((edge) => {
    return freeze({
      caller: canonical(root, edge.caller),
      specifier: edge.specifier,
      directory: path.dirname(path.resolve(root, edge.caller)),
      request: `${CONTEXTS}${path.basename(edge.specifier, SHARED)}`,
      target: canonical(root, edge.target),
      targetDirectory: path.dirname(path.resolve(root, edge.target)),
    });
  });
  const loadSlot = slot(Module, '_load');
  const resolveSlot = slot(Module, '_resolveFilename');
  const requireSlot = slot(Module.prototype, 'require');
  const compileSlot = slot(Module.prototype, '_compile');
  const originalCompile = method(compileSlot.descriptor.value);
  const originalResolve = method(resolveSlot.descriptor.value);
  const realm = captureNodeNextJwtRealm(
    globalThis,
    process,
    nodeInitializationBuiltins(require).basis,
  );
  const initialContext = context(filename);
  let currentModule: ObjectValue | undefined;
  let hookNamespace: unknown;
  let nextResolve: Method;
  let nextRequire: Method;
  let checkExports: () => void;
  let completed = false;
  let restored = false;
  let expected = {
    load: loadSlot.descriptor.value as unknown,
    require: undefined as unknown,
    compile: compileSlot.descriptor.value as unknown,
  };
  let hookContext = initialContext;
  const callerContexts = new Map<string, ReturnType<typeof context>>();
  let activeEdge: (typeof edges)[number] | undefined;
  function pristine(cachedLoad = false): void {
    const slots = [loadSlot, resolveSlot, requireSlot, compileSlot];
    const current = [
      descriptorOf(loadSlot.owner, loadSlot.key),
      descriptorOf(resolveSlot.owner, resolveSlot.key),
      descriptorOf(requireSlot.owner, requireSlot.key),
      descriptorOf(compileSlot.owner, compileSlot.key),
    ];
    let index = 0;
    try {
      while (index < slots.length) {
        const own = slots[index] ?? fail('missing loader slot');
        index += 1;
        defineProperty(own.owner, own.key, own.descriptor);
      }
      if (cachedLoad) assertNodeJwtRealmStructure(realm);
      else assertNodeJwtRealm(realm);
    } finally {
      index = 0;
      while (index < slots.length) {
        const own = slots[index];
        const descriptor = current[index];
        index += 1;
        if (own !== undefined && descriptor !== undefined)
          defineProperty(own.owner, own.key, descriptor);
      }
    }
  }
  function core(): void {
    const entry = descriptorOf(cache, filename);
    if (
      restored ||
      currentModule === undefined ||
      entry === undefined ||
      !hasOwn(entry, 'value') ||
      entry.value !== currentModule ||
      cached(cache, filename, directory) !== currentModule ||
      data(currentModule, 'loaded') !== true ||
      data(currentModule, 'exports') !== hookNamespace
    )
      fail('hook cache evicted or replaced');
    checkExports();
  }
  function assertState(cachedLoad: boolean): void {
    if (!completed) fail('SDK loader installation not completed');
    assertSlot(loadSlot, expected.load);
    assertSlot(resolveSlot, resolve);
    assertSlot(requireSlot, expected.require);
    assertSlot(compileSlot, expected.compile);
    pristine(cachedLoad);
    core();
    assertNodeWsModuleContext(hookContext, currentModule);
  }
  function assert(): void {
    assertState(false);
  }
  function assertCachedLoad(): void {
    assertState(true);
  }
  function resolverTarget(request: unknown, parent: unknown): string | undefined {
    if (typeof request !== 'string') fail('non-string Next resolution');
    if (!completed) {
      if (
        !isBuiltin(request) &&
        (!path.isAbsolute(request) || !request.startsWith(`${root}${path.sep}`))
      )
        fail('non-metadata resolution during SDK setup');
      return undefined;
    }
    for (const alias of expectedAliases) if (request === alias[0]) return alias[1];
    return activeEdge?.request === request && data(object(parent), 'filename') === activeEdge.caller
      ? activeEdge.target
      : undefined;
  }
  function resolve(this: unknown, ...args: unknown[]): unknown {
    if (completed) assert();
    else core();
    try {
      const target = resolverTarget(args[0], args[1]);
      const result: unknown = apply(nextResolve, this, args);
      if (target !== undefined && result !== target) fail('qualified hook target changed');
      return result;
    } finally {
      if (completed) assert();
      else core();
    }
  }
  function incoming(receiver: unknown, request: string) {
    const parent = object(receiver);
    const name = data(parent, 'filename');
    const edge = edges.find((entry) => entry.caller === name && entry.specifier === request);
    if (edge === undefined || cached(cache, edge.caller, edge.directory) !== parent)
      fail('unqualified shared-runtime request');
    const known = callerContexts.get(edge.caller);
    if (known === undefined) fail('missing qualified caller context');
    assertNodeWsModuleContext(known, parent);
    return edge;
  }
  function hookedRequire(this: unknown, ...args: unknown[]): unknown {
    if (completed) assertCachedLoad();
    else core();
    const request = args[0];
    if (typeof request !== 'string') fail('non-string Next require');
    if (!completed && !isBuiltin(request)) fail('app load during SDK setup');
    const edge = request.endsWith(SHARED) ? incoming(this, request) : undefined;
    const previous = activeEdge;
    activeEdge = edge;
    try {
      if (edge !== undefined) {
        assert();
        try {
          if (apply(originalResolve, Module, [edge.request, this, false]) !== edge.target)
            fail('shared-runtime target changed');
        } finally {
          assert();
        }
      }
      const result: unknown = apply(nextRequire, this, args);
      if (edge !== undefined) {
        const target = cached(cache, edge.target, edge.targetDirectory);
        if (data(target, 'loaded') !== true || data(target, 'exports') !== result)
          fail('shared-runtime returned foreign namespace');
      }
      return result;
    } finally {
      activeEdge = previous;
      if (completed) assertCachedLoad();
      else core();
    }
  }
  function restore(): void {
    if (restored) return;
    for (const own of [loadSlot, resolveSlot, requireSlot, compileSlot])
      defineProperty(own.owner, own.key, own.descriptor);
    Reflect.deleteProperty(cache, filename);
    restored = true;
    installed.active = false;
  }
  try {
    let compiling = false;
    function bootstrapCompile(this: unknown, ...args: unknown[]): unknown {
      if (compiling || args[1] !== filename || args[0] !== source)
        fail('unexpected CJS evaluation during bootstrap');
      compiling = true;
      const receiver = object(this);
      if (
        cached(cache, filename, directory) !== receiver ||
        data(receiver, 'loaded') !== false ||
        ownKeys(object(data(receiver, 'exports'))).length > 0
      )
        fail('non-default bootstrap Module');
      assertNodeWsModuleContext(initialContext, receiver);
      currentModule = receiver;
      return apply(originalCompile, this, args);
    }
    setSlot(compileSlot, bootstrapCompile);
    let exports: unknown;
    try {
      // eslint-disable-next-line security/detect-non-literal-require -- The sole fixed-hash original hook; temporary _compile rejects every other CJS evaluation.
      exports = require(filename);
    } finally {
      defineProperty(compileSlot.owner, compileSlot.key, compileSlot.descriptor);
    }
    nextResolve = method(descriptorOf(Module, '_resolveFilename')?.value);
    nextRequire = method(descriptorOf(Module.prototype, 'require')?.value);
    if (nextResolve === originalResolve || nextRequire === requireSlot.descriptor.value)
      fail('missing original Next loader transitions');
    assertSlot(resolveSlot, nextResolve);
    assertSlot(requireSlot, nextRequire);
    assertSlot(loadSlot, loadSlot.descriptor.value);
    assertSlot(compileSlot, originalCompile);
    pristine();
    checkExports = hookExports(exports, expectedAliases);
    if (currentModule === undefined || data(currentModule, 'exports') !== exports)
      fail('foreign hook exports');
    hookNamespace = exports;
    core();
    setSlot(resolveSlot, resolve);
    setSlot(requireSlot, hookedRequire);
    installed.active = true;
    return freeze({
      filename,
      assert,
      assertCachedLoad,
      restore,
      complete(value: NodeNextHookExpected) {
        if (completed || restored) fail('SDK loader installation already completed');
        const refs = object(value);
        expected = freeze({
          load: method(data(refs, 'load')),
          require: method(data(refs, 'require')),
          compile: method(data(refs, 'compile')),
        });
        assertSlot(loadSlot, expected.load);
        assertSlot(requireSlot, expected.require);
        assertSlot(compileSlot, expected.compile);
        assertSlot(resolveSlot, resolve);
        pristine();
        hookContext = context(filename);
        for (const edge of edges) callerContexts.set(edge.caller, context(edge.caller));
        completed = true;
        assert();
      },
    });
  } catch (error) {
    restore();
    throw error;
  }
}
