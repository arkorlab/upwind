import {
  assertNodeWsRealm,
  assertNodeWsRealmStructure,
  captureNodeWsRealm,
  sealNodeLoader,
  type NodeWsRealm,
} from './node-ws-realm.ts';

/** Preconditions for separately reviewed, unmodified Node-only JWT initialization. */
const descriptorOf = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const prototypeOf = Object.getPrototypeOf;
const apply = Reflect.apply;
const sameValue = Object.is;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const truthy = Boolean;
const NativeError = Error;

const ROOTS = [
  'Array',
  'ArrayBuffer',
  'Buffer',
  'DataView',
  'Date',
  'Error',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'TypeError',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'WeakMap',
  'clearTimeout',
  'isFinite',
  'parseFloat',
  'parseInt',
  'setTimeout',
] as const;
const PROCESS_KEYS = [
  'binding',
  'emit',
  'emitWarning',
  'nextTick',
  'env',
  'versions',
  'version',
] as const;
const LOADER_ENV = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'] as const;
const TYPE_PREDICATES = [
  'isArrayBuffer',
  'isDate',
  'isMap',
  'isRegExp',
  'isSet',
  'isTypedArray',
] as const;

type ObjectValue = Record<PropertyKey, unknown>;
type SnapshotPolicy = 'any' | 'enumerable-data' | 'data';
type TrustedGetter = (this: unknown) => unknown;
interface Property {
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
}
interface ObjectSnapshot {
  readonly object: ObjectValue;
  readonly prototype: ObjectValue | null;
  readonly properties: readonly Property[];
}
interface Root {
  readonly owner: ObjectValue;
  readonly property: Property;
  readonly value: ObjectValue;
  readonly getter: TrustedGetter | undefined;
}
interface PropertyGroup {
  readonly owner: ObjectValue;
  readonly prototype: ObjectValue | null;
  readonly properties: readonly Property[];
}
interface RealmState {
  readonly globals: ObjectValue;
  readonly process: ObjectValue;
  readonly environment: ObjectValue;
  readonly globalPrototype: ObjectValue | null;
  readonly roots: readonly Root[];
  readonly processProperties: readonly Property[];
  readonly builtinProperties: readonly PropertyGroup[];
  readonly snapshots: readonly ObjectSnapshot[];
  readonly websocket: NodeWsRealm | undefined;
}
/** Actual CommonJS exports captured before app evaluation; loader is the Module export. */
export interface NodeJwtBuiltinBasis {
  readonly buffer: unknown;
  readonly crypto: unknown;
  readonly stream: unknown;
  readonly util: unknown;
  readonly loader?: unknown;
  readonly websocket?: unknown;
}
const REALM = Symbol('Node JWT initialization realm');
export interface NodeJwtRealm {
  readonly [REALM]: true;
}
const REALMS = new WeakMap<NodeJwtRealm, RealmState>();
const getRealm = REALMS.get.bind(REALMS);
const setRealm = REALMS.set.bind(REALMS);

function fail(reason: string): never {
  throw new NativeError(`Unsupported Node JWT initialization: ${reason}`);
}
function object(value: unknown): value is ObjectValue {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function requiredObject(value: unknown): ObjectValue {
  return object(value) ? value : fail('missing required builtin object');
}
function parentOf(value: ObjectValue): ObjectValue | null {
  const parent: unknown = prototypeOf(value);
  return parent === null ? null : requiredObject(parent);
}
function property(owner: ObjectValue, key: PropertyKey): Property {
  return freeze({ key, descriptor: descriptorOf(owner, key) });
}
function descriptorData(descriptor: PropertyDescriptor | undefined, key: PropertyKey): unknown {
  if (descriptor === undefined) return undefined;
  if (!hasOwn(descriptor, 'value')) fail(`accessor for ${String(key)}`);
  const value: unknown = descriptor.value;
  return value;
}
function data(owner: ObjectValue, key: PropertyKey): unknown {
  return descriptorData(descriptorOf(owner, key), key);
}
function inheritedData(owner: ObjectValue, key: PropertyKey): unknown {
  for (let at: ObjectValue | null = owner; at !== null; at = parentOf(at)) {
    const descriptor = descriptorOf(at, key);
    if (descriptor !== undefined) return descriptorData(descriptor, key);
  }
  return undefined;
}
function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (
    left.configurable !== right.configurable ||
    left.enumerable !== right.enumerable ||
    hasOwn(left, 'value') !== hasOwn(right, 'value')
  )
    return false;
  return hasOwn(left, 'value')
    ? left.writable === right.writable && sameValue(left.value, right.value)
    : left.get === right.get && left.set === right.set;
}
function checkProperties(owner: ObjectValue, properties: readonly Property[]): void {
  let index = 0;
  while (index < properties.length) {
    const item = properties[index];
    index += 1;
    if (item === undefined || !sameDescriptor(item.descriptor, descriptorOf(owner, item.key)))
      fail(
        `a required builtin descriptor changed (${typeof item?.key === 'string' ? item.key : '<symbol>'})`,
      );
  }
}
function checkObject(captured: ObjectSnapshot): void {
  const keys = ownKeys(captured.object);
  if (
    parentOf(captured.object) !== captured.prototype ||
    keys.length !== captured.properties.length
  )
    fail('a required builtin shape changed');
  for (let index = 0; index < keys.length; index += 1)
    if (keys[index] !== captured.properties[index]?.key)
      fail('a required builtin key order changed');
  checkProperties(captured.object, captured.properties);
}
function snapshot(value: ObjectValue, policy: SnapshotPolicy = 'any'): ObjectSnapshot {
  const keys = ownKeys(value);
  const properties: Property[] = [];
  let index = 0;
  while (index < keys.length) {
    const key = keys[index];
    index += 1;
    if (key === undefined) fail('missing builtin key');
    const item = property(value, key);
    if (
      policy === 'data' ||
      (policy === 'enumerable-data' &&
        typeof key === 'string' &&
        item.descriptor?.enumerable === true)
    )
      descriptorData(item.descriptor, key);
    properties.push(item);
  }
  return freeze({ object: value, prototype: parentOf(value), properties: freeze(properties) });
}
function callable(value: unknown): value is TrustedGetter {
  return typeof value === 'function';
}
function getterOf(descriptor: PropertyDescriptor | undefined): TrustedGetter | undefined {
  const value = descriptor === undefined ? undefined : data(requiredObject(descriptor), 'get');
  if (value === undefined) return;
  return callable(value) ? value : fail('invalid builtin getter descriptor');
}
/** Only the trusted bootstrap may invoke the original Node lazy/accessor global getters. */
function root(owner: ObjectValue, key: PropertyKey): Root {
  const original = descriptorOf(owner, key);
  const getter = getterOf(original);
  let value: unknown;
  if (original !== undefined && hasOwn(original, 'value')) value = original.value;
  else if (getter !== undefined) value = apply(getter, owner, []);
  const current = property(owner, key);
  const currentGetter = getterOf(current.descriptor);
  const actual = currentGetter === undefined ? descriptorData(current.descriptor, key) : value;
  if (!object(value) || !sameValue(actual, value)) fail(`missing builtin ${String(key)}`);
  return freeze({ owner, property: current, value, getter: currentGetter });
}
function checkRoots(state: RealmState): void {
  let index = 0;
  while (index < state.roots.length) {
    const binding = state.roots[index];
    index += 1;
    if (
      binding === undefined ||
      !sameDescriptor(
        binding.property.descriptor,
        descriptorOf(binding.owner, binding.property.key),
      )
    )
      fail('a required builtin descriptor changed');
    if (binding.getter !== undefined) {
      const value: unknown = apply(binding.getter, binding.owner, []);
      if (!sameValue(value, binding.value)) fail('a required builtin root value changed');
    }
  }
}
function ambient(state: Pick<RealmState, 'globals' | 'process' | 'environment'>): void {
  if (data(state.globals, 'global') !== state.globals) fail('nonstandard global alias');
  if (inheritedData(state.globals, 'define') !== undefined) fail('ambient AMD define');
  const self = inheritedData(state.globals, 'self');
  if (object(self) && self !== state.globals) fail('nonstandard self object');
  inheritedData(state.globals, '_');
  const shared = inheritedData(state.globals, '__core-js_shared__');
  if (shared !== undefined && shared !== null) fail('core-js initialization context');
  let index = 0;
  while (index < LOADER_ENV.length) {
    const key = LOADER_ENV[index];
    index += 1;
    if (key !== undefined && truthy(data(state.environment, key)))
      fail('loader environment override');
  }
  const versions = data(state.process, 'versions');
  if (
    !object(versions) ||
    data(versions, 'node') !== '24.22.1' ||
    data(state.process, 'version') !== 'v24.22.1'
  )
    fail('requires Node 24.22.1');
}

class BuiltinCapture {
  private readonly values = new Set<ObjectValue>();
  readonly snapshots: ObjectSnapshot[] = [];
  readonly groups: PropertyGroup[] = [];
  readonly roots: Root[] = [];
  websocket: NodeWsRealm | undefined;

  trustedRoot(owner: ObjectValue, key: PropertyKey): ObjectValue {
    const binding = root(owner, key);
    this.roots.push(binding);
    return binding.value;
  }

  seal(value: ObjectValue, policy: SnapshotPolicy = 'any'): void {
    const captured = snapshot(value, policy);
    if (!this.values.has(value)) {
      this.values.add(value);
      this.snapshots.push(captured);
    }
  }

  chain(value: ObjectValue, policy: SnapshotPolicy = 'any'): void {
    const seen = new Set<ObjectValue>();
    for (let at: ObjectValue | null = value; at !== null; at = parentOf(at)) {
      if (seen.has(at)) fail('cyclic builtin prototype chain');
      seen.add(at);
      this.seal(at, policy);
    }
  }

  fields(owner: ObjectValue, keys: readonly string[]): ObjectValue[] {
    const properties: Property[] = [];
    const found: ObjectValue[] = [];
    let index = 0;
    while (index < keys.length) {
      const key = keys[index];
      index += 1;
      if (key === undefined) fail('missing builtin field');
      found.push(requiredObject(data(owner, key)));
      properties.push(property(owner, key));
    }
    this.groups.push(freeze({ owner, prototype: parentOf(owner), properties: freeze(properties) }));
    return found;
  }

  optional(owner: ObjectValue, key: string): void {
    data(owner, key);
    const properties = freeze([property(owner, key)]);
    this.groups.push(freeze({ owner, prototype: parentOf(owner), properties }));
  }

  inherited(owner: ObjectValue, key: string): void {
    for (let at: ObjectValue | null = owner; at !== null; at = parentOf(at)) {
      this.optional(at, key);
      if (descriptorOf(at, key) !== undefined) {
        if (typeof data(at, key) !== 'function') fail('missing process callback');
        return;
      }
    }
    fail('missing process callback');
  }

  functions(owner: ObjectValue, keys: readonly string[]): ObjectValue[] {
    const found = this.fields(owner, keys);
    let index = 0;
    while (index < found.length) {
      if (typeof found[index] !== 'function') fail('missing required builtin callback');
      index += 1;
    }
    return found;
  }
}
function sealBuiltinBasis(
  capture: BuiltinCapture,
  basis: ObjectValue,
  globalBuffer: ObjectValue | undefined,
  globals: ObjectValue,
): void {
  const buffers = capture.functions(requiredObject(data(basis, 'buffer')), [
    'Buffer',
    'SlowBuffer',
  ]);
  if (buffers[0] !== globalBuffer) fail('nonstandard Buffer alias');
  capture.functions(requiredObject(buffers[0]), [
    'from',
    'alloc',
    'allocUnsafe',
    'allocUnsafeSlow',
  ]);
  let index = 0;
  while (index < buffers.length) {
    const buffer = buffers[index];
    index += 1;
    if (buffer === undefined) fail('missing Buffer constructor');
    capture.chain(buffer, 'enumerable-data');
    const prototype = requiredObject(data(buffer, 'prototype'));
    capture.chain(prototype);
    inheritedData(prototype, 'equal');
  }
  const stream = capture.functions(requiredObject(data(basis, 'stream')), ['Stream'])[0];
  if (stream === undefined) fail('missing Stream constructor');
  capture.seal(stream);
  capture.seal(requiredObject(data(stream, 'prototype')));
  const crypto = requiredObject(data(basis, 'crypto'));
  capture.functions(crypto, [
    'KeyObject',
    'createSecretKey',
    'createPrivateKey',
    'createPublicKey',
    'createHash',
  ]);
  const constructor = capture.functions(crypto, ['Hash'])[0];
  if (constructor === undefined) fail('missing Hash constructor');
  capture.seal(constructor);
  capture.chain(requiredObject(data(constructor, 'prototype')));
  const util = requiredObject(data(basis, 'util'));
  capture.functions(util, ['inherits']);
  const types = capture.fields(util, ['types'])[0];
  if (types === undefined) fail('missing util.types');
  capture.seal(types, 'data');
  capture.functions(types, TYPE_PREDICATES);
  const loader = data(basis, 'loader');
  if (loader !== undefined) sealNodeLoader(capture, requiredObject(loader));
  capture.websocket = captureNodeWsRealm(capture, basis, globals);
}
function captureProcess(capture: BuiltinCapture, process: ObjectValue): readonly Property[] {
  const properties: Property[] = [];
  let index = 0;
  while (index < PROCESS_KEYS.length) {
    const key = PROCESS_KEYS[index];
    index += 1;
    if (key === undefined) fail('missing process field');
    data(process, key);
    properties.push(property(process, key));
    if (key === 'binding' || key === 'emit' || key === 'emitWarning' || key === 'nextTick')
      capture.inherited(process, key);
  }
  return freeze(properties);
}
/** Capture only trusted builtin basis, before any application module is evaluated. */
export function captureNodeJwtRealm(
  globals: unknown,
  process: unknown,
  builtins?: NodeJwtBuiltinBasis,
): NodeJwtRealm {
  const globalObject = requiredObject(globals);
  const processObject = requiredObject(process);
  const environment = data(processObject, 'env');
  if (!object(environment)) fail('missing Node environment');
  const capture = new BuiltinCapture();
  for (const key of ['NODE_ENV', 'NEXT_RUNTIME', 'TURBOPACK']) capture.optional(environment, key);
  const roots = capture.roots;
  let globalBuffer: ObjectValue | undefined;
  let index = 0;
  while (index < ROOTS.length) {
    const key = ROOTS[index];
    index += 1;
    if (key === undefined) fail('missing builtin root');
    const binding = root(globalObject, key);
    roots.push(binding);
    capture.seal(binding.value);
    if (key === 'Buffer') globalBuffer = binding.value;
    const prototype = data(binding.value, 'prototype');
    if (object(prototype)) capture.seal(prototype);
  }
  const processRoot = root(globalObject, 'process');
  if (processRoot.value !== processObject) fail('nonstandard process alias');
  roots.push(processRoot);
  const processProperties = captureProcess(capture, processObject);
  const globalPrototype = parentOf(globalObject);
  if (globalPrototype !== null) capture.chain(globalPrototype);
  if (builtins !== undefined)
    sealBuiltinBasis(capture, requiredObject(builtins), globalBuffer, globalObject);
  const state: RealmState = {
    globals: globalObject,
    process: processObject,
    environment,
    globalPrototype,
    roots: freeze(roots),
    processProperties,
    builtinProperties: freeze(capture.groups),
    snapshots: freeze(capture.snapshots),
    websocket: capture.websocket,
  };
  ambient(state);
  const realm = freeze({ [REALM]: true as const });
  setRealm(realm, state);
  return realm;
}

/** No changed/customer getters, source rewrites, global freezing or application callbacks. */
function assertRealm(realm: NodeJwtRealm, structure: boolean): void {
  const state = getRealm(realm);
  if (state === undefined) fail('foreign realm snapshot');
  if (parentOf(state.globals) !== state.globalPrototype) fail('global prototype chain changed');
  checkRoots(state);
  checkProperties(state.process, state.processProperties);
  let index = 0;
  while (index < state.snapshots.length) {
    const value = state.snapshots[index];
    index += 1;
    if (value === undefined) fail('missing builtin snapshot');
    checkObject(value);
  }
  index = 0;
  while (index < state.builtinProperties.length) {
    const group = state.builtinProperties[index];
    index += 1;
    if (group === undefined) fail('missing builtin property group');
    if (parentOf(group.owner) !== group.prototype) fail('a required builtin shape changed');
    checkProperties(group.owner, group.properties);
  }
  if (structure) assertNodeWsRealmStructure(state.websocket);
  else assertNodeWsRealm(state.websocket);
  ambient(state);
}

export function assertNodeJwtRealm(realm: NodeJwtRealm): void {
  assertRealm(realm, false);
}
/** Only a cached-load boundary may omit path-entry enumeration; resolvers need the full check. */
export function assertNodeJwtRealmStructure(realm: NodeJwtRealm): void {
  assertRealm(realm, true);
}
