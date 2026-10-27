const descriptorOf = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const NativeError = Error;

type ObjectValue = Record<PropertyKey, unknown>;
interface Capture {
  fields(owner: ObjectValue, keys: readonly string[]): ObjectValue[];
  functions(owner: ObjectValue, keys: readonly string[]): ObjectValue[];
  optional(owner: ObjectValue, key: string): void;
  trustedRoot(owner: ObjectValue, key: PropertyKey): ObjectValue;
  seal(value: ObjectValue, policy?: 'any' | 'enumerable-data' | 'data'): void;
  chain(value: ObjectValue): void;
}
interface CacheState {
  readonly cache: ObjectValue;
  readonly prototype: ObjectValue | null;
}
interface ModuleCacheState extends CacheState {
  readonly bare: readonly string[];
}
export interface NodeWsRealm {
  readonly path: CacheState | undefined;
  readonly modules: ModuleCacheState | undefined;
}
const MODULES = [
  'crypto',
  'stream',
  'url',
  'events',
  'http',
  'https',
  'net',
  'tls',
  'zlib',
  'path',
  'fs',
];
const JWT_BARE = ['buffer', 'crypto', 'stream', 'util'];
const WS_BARE = ['crypto', 'events', 'http', 'https', 'net', 'stream', 'tls', 'url', 'zlib'];

function fail(reason = 'invalid WebSocket builtin basis'): never {
  throw new NativeError(`Unsupported Node JWT initialization: ${reason}`);
}
function isObject(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function object(value: unknown): ObjectValue {
  return isObject(value) ? value : fail();
}
function data(owner: ObjectValue, key: string): unknown {
  const descriptor = descriptorOf(owner, key);
  if (descriptor === undefined) return undefined;
  if (!hasOwn(descriptor, 'value')) fail();
  const value: unknown = descriptor.value;
  return value;
}
function constructor(capture: Capture, value: ObjectValue): void {
  if (typeof value !== 'function') fail();
  capture.chain(value);
  capture.chain(object(data(value, 'prototype')));
}

/** The original loader footprint is also used by JWT-only installations. */
export function sealNodeLoader(capture: Capture, loader: ObjectValue): void {
  if (typeof capture.trustedRoot(loader, 'wrap') !== 'function') fail('missing loader wrap');
  capture.seal(capture.trustedRoot(loader, 'wrapper'), 'data');
  capture.functions(loader, [
    '_load',
    '_resolveFilename',
    'createRequire',
    'register',
    'registerHooks',
  ]);
  const prototype = capture.fields(loader, ['prototype'])[0];
  if (prototype === undefined) fail('missing loader prototype');
  capture.functions(prototype, ['_compile', 'load']);
  const extensions = capture.fields(loader, ['_extensions'])[0];
  if (extensions === undefined) fail('missing loader extensions');
  capture.functions(extensions, ['.js', '.json', '.node']);
  capture.optional(extensions, '.cjs');
}

/** Normal loader cache entries may grow; accessors and non-string entries are never invoked. */
function assertCachePrototype(state: CacheState): void {
  if (prototypeOf(state.cache) !== state.prototype || state.prototype !== null)
    fail('resolver cache prototype changed');
}
function assertPathCache(state: CacheState): void {
  assertCachePrototype(state);
  const keys = ownKeys(state.cache);
  let index = 0;
  while (index < keys.length) {
    const key = keys[index];
    index += 1;
    if (typeof key !== 'string') fail('resolver cache key');
    const descriptor = descriptorOf(state.cache, key);
    if (
      descriptor === undefined ||
      !hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    )
      fail('resolver cache entry is not DATA string');
  }
}
function assertModuleCache(state: ModuleCacheState): void {
  assertCachePrototype(state);
  let index = 0;
  while (index < state.bare.length) {
    const key = state.bare[index];
    index += 1;
    if (key === undefined || descriptorOf(state.cache, key) !== undefined)
      fail('bare builtin shadowed in module cache');
  }
}
export function assertNodeWsRealm(state: NodeWsRealm | undefined): void {
  if (state?.modules !== undefined) assertModuleCache(state.modules);
  if (state?.path !== undefined) assertPathCache(state.path);
}

function cacheState(capture: Capture, loader: ObjectValue, key: string): CacheState {
  const cache = capture.fields(loader, [key])[0];
  if (cache === undefined) fail('missing resolver cache');
  const prototype: unknown = prototypeOf(cache);
  if (prototype !== null) fail('resolver cache prototype');
  return freeze({ cache, prototype });
}

function resolver(capture: Capture, basis: ObjectValue): CacheState {
  const loader = object(data(basis, 'loader'));
  capture.functions(loader, ['_findPath', '_resolveLookupPaths', '_nodeModulePaths']);
  const prototype = capture.fields(loader, ['prototype'])[0];
  if (prototype === undefined) fail('missing resolver prototype');
  capture.functions(prototype, ['require']);
  for (const name of ['_stat', '_readPackage']) {
    const value = capture.trustedRoot(loader, name);
    if (typeof value !== 'function') fail('missing resolver callback');
    capture.seal(value);
  }
  const state = cacheState(capture, loader, '_pathCache');
  assertPathCache(state);
  return state;
}

/** The fixed public WS prefix reads these DATA exports before both optional native attempts. */
export function captureNodeWsRealm(
  capture: Capture,
  basis: ObjectValue,
  globals: ObjectValue,
): NodeWsRealm | undefined {
  const selected = data(basis, 'websocket');
  const loader = data(basis, 'loader');
  let modules: ModuleCacheState | undefined;
  if (loader !== undefined) {
    const bare = new Set(JWT_BARE);
    if (selected !== undefined) for (const name of WS_BARE) bare.add(name);
    modules = freeze({ ...cacheState(capture, object(loader), '_cache'), bare: freeze([...bare]) });
    assertModuleCache(modules);
  }
  if (selected === undefined)
    return modules === undefined ? undefined : freeze({ modules, path: undefined });
  const websocket = capture.fields(basis, ['websocket'])[0];
  if (websocket === undefined) fail();
  // No customer getter can run while checking the eval binding used by literal direct eval.
  const evaluator = capture.functions(globals, ['eval'])[0];
  if (evaluator === undefined) fail();
  capture.seal(evaluator);
  capture.fields(websocket, MODULES);
  capture.functions(object(data(websocket, 'crypto')), [
    'randomBytes',
    'createHash',
    'randomFillSync',
  ]);
  const streams = capture.functions(object(data(websocket, 'stream')), [
    'Readable',
    'Writable',
    'Duplex',
  ]);
  for (const stream of streams) constructor(capture, stream);
  const url = capture.functions(object(data(websocket, 'url')), ['URL'])[0];
  if (url === undefined) fail();
  constructor(capture, url);
  constructor(capture, object(data(websocket, 'events')));
  const path = object(data(websocket, 'path'));
  capture.functions(path, [
    'resolve',
    'dirname',
    'isAbsolute',
    'normalize',
    'toNamespacedPath',
    'join',
    'basename',
  ]);
  capture.optional(path, 'sep');
  capture.optional(path, 'delimiter');
  capture.functions(object(data(websocket, 'fs')), ['realpathSync']);
  return freeze({ modules, path: resolver(capture, basis) });
}
